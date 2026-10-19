import { Injectable, Logger } from '@nestjs/common';
import { ConversationStatus } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { IdempotencyService } from './idempotency.service';

export interface ResolvedConversation {
  conversationId: string;
  status: ConversationStatus;
  isNew: boolean;
  wasReopened: boolean;
}

/**
 * Canais thread-based (GMAIL): a conversa é chaveada pelo thread do
 * provider — não pelo contato. `subject` vira o título na criação.
 */
export interface ThreadResolveOpts {
  externalThreadId?: string;
  subject?: string;
  /**
   * MEMBERS: 1 conversa por CONTATO no canal. `externalThreadId` deixa de ser
   * a chave e vira só o ponteiro pro thread mais recente do provider (usado
   * pelos callbacks de saída) — é sobrescrito a cada evento.
   */
  contactScoped?: boolean;
}

const OPEN_STATES = [
  ConversationStatus.PENDING,
  ConversationStatus.OPEN,
  ConversationStatus.BOT,
  ConversationStatus.WAITING,
] as const;

@Injectable()
export class ConversationResolverService {
  private readonly logger = new Logger(ConversationResolverService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async resolve(
    organizationId: string,
    channelId: string,
    contactId: string,
    isGroup?: boolean,
    opts?: ThreadResolveOpts,
  ): Promise<ResolvedConversation> {
    // Path thread-based (só o GMAIL passa externalThreadId): 1 conversa por
    // thread de email. Isolado aqui — canais de chat seguem o path abaixo
    // idêntico ao que sempre foi.
    if (opts?.externalThreadId && opts.contactScoped) {
      return this.resolveByContactThread(organizationId, channelId, contactId, opts);
    }
    if (opts?.externalThreadId) {
      return this.resolveByThread(organizationId, channelId, contactId, opts);
    }

    // Fast path without lock — most webhooks hit an already-open conversation.
    const fast = await this.findOpen(organizationId, channelId, contactId);
    if (fast) return this.touchOpen(fast, isGroup);

    // Need to create or reopen — serialise to prevent duplicate conversations.
    return this.idempotency.withLock(
      `conv:${channelId}:${contactId}`,
      async () => {
        const existing = await this.findOpen(organizationId, channelId, contactId);
        if (existing) return this.touchOpen(existing, isGroup);

        const lastClosed = await this.prisma.conversation.findFirst({
          where: {
            organizationId,
            channelId,
            contactId,
            status: ConversationStatus.CLOSED,
          },
          orderBy: { closedAt: 'desc' },
        });

        if (lastClosed) {
          const closedAt = lastClosed.closedAt || lastClosed.updatedAt;
          const hoursSinceClosed = (Date.now() - closedAt.getTime()) / (1000 * 60 * 60);
          if (hoursSinceClosed < 24) {
            await this.prisma.conversation.update({
              where: { id: lastClosed.id },
              data: {
                status: ConversationStatus.PENDING,
                closedAt: null,
                assignedToId: null,
              },
            });
            await this.prisma.conversationAuditLog.create({
              data: {
                conversationId: lastClosed.id,
                action: 'REOPENED',
                fromValue: ConversationStatus.CLOSED,
                toValue: ConversationStatus.PENDING,
                metadata: { trigger: 'new_inbound_message' },
              },
            });
            this.logger.log(`Conversation reopened: ${lastClosed.id}`);
            return {
              conversationId: lastClosed.id,
              status: ConversationStatus.PENDING,
              isNew: false,
              wasReopened: true,
            };
          }
        }

        const protocol = this.generateProtocol();
        const conversation = await this.prisma.conversation.create({
          data: {
            organizationId,
            channelId,
            contactId,
            status: ConversationStatus.PENDING,
            protocol,
            isGroup: isGroup || false,
          },
        });
        await this.prisma.conversationAuditLog.create({
          data: {
            conversationId: conversation.id,
            action: 'CREATED',
            toValue: ConversationStatus.PENDING,
          },
        });
        this.logger.log(
          `New conversation created: ${conversation.id} (protocol: ${protocol})`,
        );
        return {
          conversationId: conversation.id,
          status: ConversationStatus.PENDING,
          isNew: true,
          wasReopened: false,
        };
      },
    );
  }

  /**
   * Resolve por thread do provider (unique `(channelId, externalThreadId)`).
   * Diferença pro path de chat: mensagem nova num thread FECHADO sempre
   * reabre a MESMA conversa (sem janela de 24h) — email é lento e o
   * histórico do thread pertence a uma conversa só.
   */
  private async resolveByThread(
    organizationId: string,
    channelId: string,
    contactId: string,
    opts: ThreadResolveOpts,
  ): Promise<ResolvedConversation> {
    const externalThreadId = opts.externalThreadId!;

    const fast = await this.findByThread(channelId, externalThreadId);
    if (fast && this.isOpen(fast.status)) return this.touchOpen(fast);

    return this.idempotency.withLock(
      `conv:${channelId}:${externalThreadId}`,
      async () => {
        const existing = await this.findByThread(channelId, externalThreadId);
        if (existing) {
          if (this.isOpen(existing.status)) return this.touchOpen(existing);

          await this.prisma.conversation.update({
            where: { id: existing.id },
            data: {
              status: ConversationStatus.PENDING,
              closedAt: null,
              assignedToId: null,
            },
          });
          await this.prisma.conversationAuditLog.create({
            data: {
              conversationId: existing.id,
              action: 'REOPENED',
              fromValue: existing.status,
              toValue: ConversationStatus.PENDING,
              metadata: { trigger: 'new_inbound_message' },
            },
          });
          this.logger.log(`Thread conversation reopened: ${existing.id}`);
          return {
            conversationId: existing.id,
            status: ConversationStatus.PENDING,
            isNew: false,
            wasReopened: true,
          };
        }

        const protocol = this.generateProtocol();
        const conversation = await this.prisma.conversation.create({
          data: {
            organizationId,
            channelId,
            contactId,
            externalThreadId,
            subject: opts.subject ?? null,
            status: ConversationStatus.PENDING,
            protocol,
            isGroup: false,
          },
        });
        await this.prisma.conversationAuditLog.create({
          data: {
            conversationId: conversation.id,
            action: 'CREATED',
            toValue: ConversationStatus.PENDING,
          },
        });
        this.logger.log(
          `New thread conversation: ${conversation.id} (thread: ${externalThreadId})`,
        );
        return {
          conversationId: conversation.id,
          status: ConversationStatus.PENDING,
          isNew: true,
          wasReopened: false,
        };
      },
    );
  }

  /**
   * Canais de 1 conversa por contato com ponteiro de thread (MEMBERS):
   *  - conversa = a mais recente do contato no canal (por lastMessageAt,
   *    qualquer status); cria só se não existir;
   *  - CLOSED → PENDING (sem janela de 24h, igual ao path de thread);
   *  - `externalThreadId` passa a apontar pro thread do evento (o mais
   *    recente do provider).
   * Se outra conversa do canal já segura esse thread id (dados anteriores ao
   * merge por contato): sendo do mesmo contato, é ELA a conversa (evita
   * espalhar o mesmo thread em duas); sendo de outro contato, o ponteiro é
   * liberado lá antes de ser gravado aqui — o unique nunca é violado.
   */
  private async resolveByContactThread(
    organizationId: string,
    channelId: string,
    contactId: string,
    opts: ThreadResolveOpts,
  ): Promise<ResolvedConversation> {
    const externalThreadId = opts.externalThreadId!;

    const fast = await this.findLatestForContact(channelId, contactId);
    if (fast && fast.externalThreadId === externalThreadId && this.isOpen(fast.status)) {
      return this.touchOpen(fast);
    }

    return this.idempotency.withLock(
      `conv:${channelId}:${contactId}`,
      async () => {
        const holder = await this.findByThread(channelId, externalThreadId);
        const target =
          holder && holder.contactId === contactId && !holder.deletedAt
            ? holder
            : await this.findLatestForContact(channelId, contactId);

        if (holder && holder.id !== target?.id) {
          await this.prisma.conversation.update({
            where: { id: holder.id },
            data: { externalThreadId: null },
          });
          this.logger.warn(
            `Thread ${externalThreadId} moved from conversation ${holder.id} (contact ${holder.contactId}) to contact ${contactId}`,
          );
        }

        if (!target) {
          const protocol = this.generateProtocol();
          const conversation = await this.prisma.conversation.create({
            data: {
              organizationId,
              channelId,
              contactId,
              externalThreadId,
              subject: opts.subject ?? null,
              status: ConversationStatus.PENDING,
              protocol,
              isGroup: false,
            },
          });
          await this.prisma.conversationAuditLog.create({
            data: {
              conversationId: conversation.id,
              action: 'CREATED',
              toValue: ConversationStatus.PENDING,
            },
          });
          this.logger.log(
            `New contact conversation: ${conversation.id} (thread: ${externalThreadId})`,
          );
          return {
            conversationId: conversation.id,
            status: ConversationStatus.PENDING,
            isNew: true,
            wasReopened: false,
          };
        }

        const threadChanged = target.externalThreadId !== externalThreadId;

        if (!this.isOpen(target.status)) {
          await this.prisma.conversation.update({
            where: { id: target.id },
            data: {
              status: ConversationStatus.PENDING,
              closedAt: null,
              assignedToId: null,
              ...(threadChanged ? { externalThreadId } : {}),
            },
          });
          await this.prisma.conversationAuditLog.create({
            data: {
              conversationId: target.id,
              action: 'REOPENED',
              fromValue: target.status,
              toValue: ConversationStatus.PENDING,
              metadata: { trigger: 'new_inbound_message', externalThreadId },
            },
          });
          this.logger.log(`Contact conversation reopened: ${target.id} (thread: ${externalThreadId})`);
          return {
            conversationId: target.id,
            status: ConversationStatus.PENDING,
            isNew: false,
            wasReopened: true,
          };
        }

        if (threadChanged) {
          await this.prisma.conversation.update({
            where: { id: target.id },
            data: { externalThreadId },
          });
        }
        return this.touchOpen(target);
      },
    );
  }

  /**
   * Conversa mais recente do contato no canal (qualquer status) — por
   * `lastMessageAt` (nulls por último), desempate por `createdAt`.
   */
  findLatestForContact(channelId: string, contactId: string) {
    return this.prisma.conversation.findFirst({
      where: { channelId, contactId, deletedAt: null },
      orderBy: [
        { lastMessageAt: { sort: 'desc', nulls: 'last' } },
        { createdAt: 'desc' },
      ],
    });
  }

  /**
   * Operador inicia conversa ativa pelo painel ("Nova conversa") com um
   * contato que pode nunca ter tido histórico. Reaproveita `findOpen()` —
   * se já existe conversa aberta pra esse contato+canal, devolve ela sem
   * mexer em status/assignee (mesmo comportamento de reaproveitar e mandar
   * mensagem numa conversa existente). Se não existe, cria já com o estado
   * final (`OPEN`, atribuída a quem iniciou, IA desligada) — SEM passar por
   * `ConversationFsmService.assign()`, porque o FSM dispara o evento de
   * automação `CONVERSATION_ASSIGNED` e seta `firstResponseAt` (usado nas
   * métricas de tempo de primeira resposta/SLA). Uma conversa que a empresa
   * iniciou não é "resposta" a ninguém — não deve contar nessas métricas
   * nem acionar automação de atribuição.
   */
  async resolveForOperator(
    organizationId: string,
    channelId: string,
    contactId: string,
    senderId: string,
    /** Só usado na criação (GMAIL) — vira `Conversation.subject`, que
     *  `outbound-message.processor.ts` usa como assunto do email. Ignorado
     *  ao reaproveitar uma conversa já existente. */
    subject?: string,
  ): Promise<ResolvedConversation> {
    const fast = await this.findOpen(organizationId, channelId, contactId);
    if (fast) return this.touchOpen(fast);

    return this.idempotency.withLock(
      `conv:${channelId}:${contactId}`,
      async () => {
        const existing = await this.findOpen(organizationId, channelId, contactId);
        if (existing) return this.touchOpen(existing);

        const protocol = this.generateProtocol();
        const conversation = await this.prisma.conversation.create({
          data: {
            organizationId,
            channelId,
            contactId,
            status: ConversationStatus.OPEN,
            assignedToId: senderId,
            aiEnabled: false,
            protocol,
            isGroup: false,
            subject: subject?.trim() || undefined,
          },
        });
        await this.prisma.conversationAuditLog.create({
          data: {
            conversationId: conversation.id,
            action: 'CREATED',
            toValue: ConversationStatus.OPEN,
            metadata: { trigger: 'manual_outreach', createdBy: senderId },
          },
        });
        this.logger.log(
          `New operator-initiated conversation: ${conversation.id} (protocol: ${protocol})`,
        );
        return {
          conversationId: conversation.id,
          status: ConversationStatus.OPEN,
          isNew: true,
          wasReopened: false,
        };
      },
    );
  }

  private findByThread(channelId: string, externalThreadId: string) {
    return this.prisma.conversation.findUnique({
      where: {
        uq_conv_channel_thread: { channelId, externalThreadId },
      },
    });
  }

  private isOpen(status: ConversationStatus): boolean {
    return (OPEN_STATES as readonly ConversationStatus[]).includes(status);
  }

  private async findOpen(
    organizationId: string,
    channelId: string,
    contactId: string,
  ) {
    return this.prisma.conversation.findFirst({
      where: {
        organizationId,
        channelId,
        contactId,
        status: { in: Array.from(OPEN_STATES) },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  private async touchOpen(
    openConversation: {
      id: string;
      status: ConversationStatus;
      isGroup: boolean;
    },
    isGroup?: boolean,
  ): Promise<ResolvedConversation> {
    if (isGroup && !openConversation.isGroup) {
      await this.prisma.conversation.update({
        where: { id: openConversation.id },
        data: { isGroup: true },
      });
    }

    if (openConversation.status === ConversationStatus.WAITING) {
      await this.prisma.conversation.update({
        where: { id: openConversation.id },
        data: { status: ConversationStatus.OPEN },
      });
      await this.prisma.conversationAuditLog.create({
        data: {
          conversationId: openConversation.id,
          action: 'STATUS_CHANGED',
          fromValue: ConversationStatus.WAITING,
          toValue: ConversationStatus.OPEN,
          metadata: { trigger: 'customer_replied' },
        },
      });
      return {
        conversationId: openConversation.id,
        status: ConversationStatus.OPEN,
        isNew: false,
        wasReopened: false,
      };
    }

    return {
      conversationId: openConversation.id,
      status: openConversation.status,
      isNew: false,
      wasReopened: false,
    };
  }

  private generateProtocol(): string {
    const now = new Date();
    const date = now.toISOString().slice(0, 10).replace(/-/g, '');
    const rand = Math.random().toString(36).substring(2, 8).toUpperCase();
    return `${date}-${rand}`;
  }
}
