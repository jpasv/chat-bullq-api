import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  Channel,
  ChannelType,
  ConversationStatus,
  MessageContentType as PrismaContentType,
  MessageDirection,
  MessageStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../../../database/prisma.service';
import { RealtimeGateway } from '../../../realtime/realtime.gateway';
import { IdempotencyService } from '../../../messaging/pipeline/idempotency.service';
import { ConversationResolverService } from '../../../messaging/pipeline/conversation-resolver.service';
import { HistoryImportService } from '../../../messaging/pipeline/history-import.service';
import { WebhookEventsService } from '../../webhook-events.service';
import {
  MessageContentType,
  NormalizedHistoricalMessage,
} from '../../ports/types';
import { MembersInboundAdapter } from './members.inbound-adapter';
import {
  MEMBERS_CHANNEL_HEADER,
  MembersContact,
  MembersConversationRef,
  MembersHandoff,
  MembersImportConversation,
  validateMembersEvent,
  validateMembersImport,
} from './members.types';

export interface MembersHttpResult {
  status: number;
  body: Record<string, unknown>;
}

/** Autor das notas internas geradas pelo sistema (InternalNote.authorId). */
export const MEMBERS_SYSTEM_AUTHOR = 'system';

const INBOUND_JOB_OPTS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 2000 },
  removeOnComplete: true,
  removeOnFail: false,
};

/**
 * Canal MEMBERS (área de membros). Trata o que não cabe no adapter genérico:
 *  - códigos HTTP do contrato (401 assinatura / 404 canal / 400 corpo);
 *  - contato por `(channelId, contact.externalId)` com nome/email/telefone e
 *    `metadata.membersTenantName`;
 *  - 1 conversa por CONTATO no canal (a mais recente, qualquer status),
 *    reabrindo CLOSED → PENDING; `externalThreadId` = id da conversa mais
 *    recente no members (destino dos callbacks de saída);
 *  - evento `handoff` → nota interna (idempotente por conversa + timestamp);
 *  - evento `message` → pipeline inbound normal (fila `inbound-messages`);
 *  - import de histórico (`/webhooks/MEMBERS/import`).
 */
@Injectable()
export class MembersChannelService {
  private readonly logger = new Logger(MembersChannelService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotency: IdempotencyService,
    private readonly conversationResolver: ConversationResolverService,
    private readonly historyImport: HistoryImportService,
    private readonly realtime: RealtimeGateway,
    private readonly webhookEvents: WebhookEventsService,
    private readonly inboundAdapter: MembersInboundAdapter,
    @InjectQueue('inbound-messages') private readonly inboundQueue: Queue,
  ) {}

  // ─── HTTP entry points ───────────────────────────────────────

  async receiveWebhook(
    headers: Record<string, string>,
    rawBody: Buffer,
    body: unknown,
  ): Promise<MembersHttpResult> {
    const auth = await this.authenticate(headers, rawBody);
    if ('status' in auth) return auth;
    const { channel } = auth;

    const validated = validateMembersEvent(body);
    if (!validated.ok) {
      return { status: 400, body: { ok: false, error: validated.error } };
    }
    const event = validated.value;

    const eventId = await this.webhookEvents
      .record(channel.id, ChannelType.MEMBERS, body, headers)
      .catch((err) => {
        this.logger.error(`webhook_events persist failed: ${err.message}`);
        return null;
      });

    const contactId = await this.upsertContact(
      channel,
      event.contact,
      event.conversation,
    );
    const eventAt = new Date(
      event.event === 'handoff' ? event.handoff!.timestamp : event.message!.timestamp,
    );
    const conv = await this.resolveConversation(
      channel,
      contactId,
      event.conversation,
      eventAt,
    );

    if (event.event === 'handoff') {
      await this.addHandoffNote(channel, conv.conversationId, contactId, event.handoff!, {
        notify: true,
      });
      if (eventId) await this.webhookEvents.markProcessed(eventId);
      this.logger.log(
        `Members handoff: conv=${conv.conversationId} thread=${event.conversation.id} new=${conv.isNew} reopened=${conv.wasReopened}`,
      );
      return { status: 200, body: { ok: true } };
    }

    // event === 'message' → pipeline normal (dedupe por externalId = message.id).
    const parsed = this.inboundAdapter.parseWebhook(body);
    for (const message of parsed.messages) {
      await this.inboundQueue.add(
        'process-inbound',
        {
          channelId: channel.id,
          organizationId: channel.organizationId,
          webhookEventId: eventId ?? undefined,
          message,
        },
        INBOUND_JOB_OPTS,
      );
    }
    return { status: 200, body: { ok: true } };
  }

  async receiveImport(
    headers: Record<string, string>,
    rawBody: Buffer,
    body: unknown,
  ): Promise<MembersHttpResult> {
    const auth = await this.authenticate(headers, rawBody);
    if ('status' in auth) return auth;
    const { channel } = auth;

    const validated = validateMembersImport(body);
    if (!validated.ok) {
      return { status: 400, body: { ok: false, error: validated.error } };
    }

    let imported = 0;
    let skipped = 0;
    for (const item of validated.value.conversations) {
      const wrote = await this.importOne(channel, item);
      if (wrote) imported++;
      else skipped++;
    }
    this.logger.log(
      `Members import on channel ${channel.id}: imported=${imported} skipped=${skipped}`,
    );
    return { status: 200, body: { ok: true, imported, skipped } };
  }

  // ─── Internals ───────────────────────────────────────────────

  async authenticate(
    headers: Record<string, string>,
    rawBody: Buffer,
  ): Promise<{ channel: Channel } | MembersHttpResult> {
    const [locator] = this.inboundAdapter.extractLocators(null, headers);
    if (!locator?.channelId) {
      return { status: 404, body: { ok: false, error: 'unknown_channel' } };
    }
    const channel = await this.prisma.channel.findFirst({
      where: {
        id: locator.channelId,
        type: ChannelType.MEMBERS,
        isActive: true,
        deletedAt: null,
      },
    });
    if (!channel) {
      this.logger.warn(`Members webhook for unknown channel ${headers[MEMBERS_CHANNEL_HEADER]}`);
      return { status: 404, body: { ok: false, error: 'unknown_channel' } };
    }
    if (!this.inboundAdapter.validateWebhook(headers, rawBody, channel.webhookSecret ?? undefined)) {
      this.logger.warn(`Members webhook with invalid signature (channel ${channel.id})`);
      return { status: 401, body: { ok: false, error: 'invalid_signature' } };
    }
    return { channel };
  }

  /**
   * Contato por `(channelId, externalId)`. Nome/email/telefone vindos do
   * members-backend são a fonte da verdade → sobrescrevem quando presentes.
   * Mesmo lock key do ContactResolverService pra não duplicar contato numa
   * corrida webhook × pipeline.
   */
  async upsertContact(
    channel: Channel,
    contact: MembersContact,
    conversation: MembersConversationRef,
  ): Promise<string> {
    const externalId = contact.externalId;
    const find = () =>
      this.prisma.contactChannel.findUnique({
        where: {
          uq_contact_channel_external: { channelId: channel.id, externalId },
        },
        include: { contact: true },
      });

    let existing = await find();
    if (!existing) {
      existing = await this.idempotency.withLock(
        `contact:${channel.id}:${externalId}`,
        async () => {
          const racer = await find();
          if (racer) return racer;
          await this.prisma.contact.create({
            data: {
              organizationId: channel.organizationId,
              name: contact.name ?? undefined,
              email: contact.email ?? undefined,
              phone: contact.phone ?? undefined,
              metadata: tenantMetadata(conversation) as Prisma.InputJsonValue,
              channels: {
                create: {
                  channelId: channel.id,
                  externalId,
                  profileName: contact.name ?? undefined,
                },
              },
            },
          });
          return find();
        },
      );
      if (!existing) throw new Error(`Contact upsert failed for ${externalId}`);
      return existing.contactId;
    }

    const current = existing.contact;
    const updates: Prisma.ContactUpdateInput = {};
    if (contact.name && contact.name !== current.name) updates.name = contact.name;
    if (contact.email && contact.email !== current.email) updates.email = contact.email;
    if (contact.phone && contact.phone !== current.phone) updates.phone = contact.phone;
    const currentMeta = (current.metadata ?? {}) as Record<string, unknown>;
    const nextMeta = { ...currentMeta, ...tenantMetadata(conversation) };
    if (JSON.stringify(nextMeta) !== JSON.stringify(currentMeta)) {
      updates.metadata = nextMeta as Prisma.InputJsonValue;
    }
    if (Object.keys(updates).length > 0) {
      await this.prisma.contact.update({ where: { id: current.id }, data: updates });
    }
    if (contact.name && contact.name !== existing.profileName) {
      await this.prisma.contactChannel.update({
        where: { id: existing.id },
        data: { profileName: contact.name },
      });
    }
    return existing.contactId;
  }

  /**
   * Conversa do contato (1 por contato no canal); CLOSED → PENDING (reabre);
   * `externalThreadId` passa a ser o id desta conversa do members. Grava
   * tenant + rastreio dos ids do members na metadata.
   */
  private async resolveConversation(
    channel: Channel,
    contactId: string,
    ref: MembersConversationRef,
    eventAt: Date,
  ) {
    const resolved = await this.conversationResolver.resolve(
      channel.organizationId,
      channel.id,
      contactId,
      false,
      { externalThreadId: ref.id, contactScoped: true },
    );
    await this.mergeConversationMetadata(resolved.conversationId, ref, eventAt);
    return resolved;
  }

  private async mergeConversationMetadata(
    conversationId: string,
    ref: MembersConversationRef,
    eventAt: Date,
  ): Promise<void> {
    const conv = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { metadata: true, externalThreadId: true },
    });
    const current = (conv?.metadata ?? {}) as Record<string, unknown>;
    const next: Record<string, unknown> = {
      ...current,
      ...tenantMetadata(ref),
      membersConversationIds: appendMembersId(
        seenMembersIds(current, conv?.externalThreadId ?? null),
        ref.id,
      ),
    };
    const known = parseDate(current.membersLastActivityAt);
    if (!Number.isNaN(eventAt.getTime()) && (!known || eventAt > known)) {
      next.membersLastActivityAt = eventAt.toISOString();
    }
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { metadata: next as Prisma.InputJsonValue },
    });
  }

  /**
   * Nota interna do handoff (motivo + transcrição do bot). Gravada como
   * mensagem SYSTEM (aparece na timeline do atendente, nunca é enviada ao
   * membro) + InternalNote. Idempotente por conversa + timestamp do handoff
   * via unique `(conversationId, externalId)`.
   *
   * @returns true quando criou a nota agora.
   */
  async addHandoffNote(
    channel: Channel,
    conversationId: string,
    contactId: string,
    handoff: MembersHandoff,
    opts: { notify: boolean },
  ): Promise<boolean> {
    const at = new Date(handoff.timestamp);
    const externalId = `handoff:${at.toISOString()}`;
    const exists = await this.prisma.message.findUnique({
      where: { uq_msg_conv_external: { conversationId, externalId } },
      select: { id: true },
    });
    if (exists) return false;

    const text = buildHandoffNote(handoff);
    let created;
    try {
      created = await this.prisma.message.create({
        data: {
          conversationId,
          direction: MessageDirection.OUTBOUND,
          type: PrismaContentType.SYSTEM,
          content: { text },
          externalId,
          status: MessageStatus.SENT,
          senderName: 'Sistema',
          createdAt: at,
          sentAt: at,
          metadata: {
            internalNote: true,
            membersHandoff: true,
            reason: handoff.reason,
          },
        },
      });
    } catch (err: any) {
      if (err?.code === 'P2002') return false; // corrida com o mesmo handoff
      throw err;
    }

    await this.prisma.internalNote.create({
      data: { conversationId, authorId: MEMBERS_SYSTEM_AUTHOR, content: text },
    });

    if (opts.notify) {
      await this.prisma.conversation.updateMany({
        where: {
          id: conversationId,
          OR: [{ lastMessageAt: null }, { lastMessageAt: { lt: at } }],
        },
        data: { lastMessageAt: at },
      });
      this.realtime.emitToChannel(channel.id, 'message:new', {
        message: created,
        conversationId,
        contactId,
      });
      this.realtime.emitToConversation(conversationId, 'message:new', {
        message: created,
      });
    }
    return true;
  }

  /**
   * Import de UMA conversa do members, mesclada na conversa do contato
   * (1 por contato no canal).
   *
   * @returns true quando algo foi gravado (conversa nova, conversa do
   * members ainda não vista, msgs novas ou nota).
   */
  private async importOne(
    channel: Channel,
    item: MembersImportConversation,
  ): Promise<boolean> {
    const contactId = await this.upsertContact(channel, item.contact, item.conversation);
    const conv = await this.idempotency.withLock(
      `conv:${channel.id}:${contactId}`,
      () => this.upsertImportedConversation(channel, contactId, item),
    );

    const messages: NormalizedHistoricalMessage[] = item.messages.map((m) => ({
      externalMessageId: m.id,
      externalConversationId: item.conversation.id,
      externalContactId: item.contact.externalId,
      direction:
        m.direction === 'OUTBOUND' ? MessageDirection.OUTBOUND : MessageDirection.INBOUND,
      timestamp: new Date(m.timestamp),
      type: MessageContentType.TEXT,
      content: { text: m.text },
      senderName:
        m.direction === 'OUTBOUND'
          ? m.sender === 'bot'
            ? 'Bot'
            : 'Atendente'
          : (item.contact.name ?? undefined),
      metadata: { membersSender: m.sender, membersConversationId: item.conversation.id },
    }));
    const msgs = await this.historyImport.importMessages(
      channel,
      conv.conversationId,
      messages,
    );

    const noteCreated = item.handoff
      ? await this.addHandoffNote(channel, conv.conversationId, contactId, item.handoff, {
          notify: false,
        })
      : false;

    if (conv.isNew) {
      await this.historyImport
        .notifyConversationImported(channel.organizationId, conv.conversationId)
        .catch(() => undefined);
    }
    return conv.isNew || conv.newThread || msgs.imported > 0 || noteCreated;
  }

  /**
   * Localiza/cria a conversa do contato pro item importado:
   *  - conversa = a que já segura esse thread (mesmo contato) ou a mais
   *    recente do contato; cria só se não houver nenhuma;
   *  - `externalThreadId` só muda pra este thread se ele for o de atividade
   *    mais recente já vista (`metadata.membersLastActivityAt`);
   *  - item OPEN ainda não visto + conversa CLOSED → reabre como PENDING
   *    (re-import do mesmo item nunca mexe no status já tratado);
   *  - `lastMessageAt` nunca regride; `createdAt` = o início mais antigo.
   */
  private async upsertImportedConversation(
    channel: Channel,
    contactId: string,
    item: MembersImportConversation,
  ): Promise<{ conversationId: string; isNew: boolean; newThread: boolean }> {
    const threadId = item.conversation.id;
    const lastMessageAt = new Date(item.lastMessageAt);
    const startedAt = new Date(item.startedAt);
    const isClosed = item.status === 'CLOSED';

    const holder = await this.prisma.conversation.findUnique({
      where: { uq_conv_channel_thread: { channelId: channel.id, externalThreadId: threadId } },
    });
    const target =
      holder && holder.contactId === contactId && !holder.deletedAt
        ? holder
        : await this.conversationResolver.findLatestForContact(channel.id, contactId);

    if (holder && holder.id !== target?.id) {
      await this.prisma.conversation.update({
        where: { id: holder.id },
        data: { externalThreadId: null },
      });
      this.logger.warn(
        `Members import: thread ${threadId} moved from conversation ${holder.id} (contact ${holder.contactId}) to contact ${contactId}`,
      );
    }

    if (!target) {
      // "OPEN" no members = aguardando atendente → PENDING (fila) aqui.
      const status = isClosed ? ConversationStatus.CLOSED : ConversationStatus.PENDING;
      const created = await this.historyImport.importConversation(channel, {
        externalConversationId: threadId,
        externalThreadId: threadId,
        externalContactId: item.contact.externalId,
        contactName: item.contact.name ?? undefined,
        contactPhone: item.contact.phone ?? undefined,
        contactEmail: item.contact.email ?? undefined,
        lastMessageAt,
        startedAt,
        status,
        closedAt: isClosed ? lastMessageAt : undefined,
        metadata: {
          ...tenantMetadata(item.conversation),
          membersConversationIds: [threadId],
          membersLastActivityAt: lastMessageAt.toISOString(),
        },
      });
      return { conversationId: created.conversationId, isNew: created.isNew, newThread: true };
    }

    const meta = (target.metadata ?? {}) as Record<string, unknown>;
    const seen = seenMembersIds(meta, target.externalThreadId);
    const alreadySeen = seen.includes(threadId);
    const knownActivity = parseDate(meta.membersLastActivityAt) ?? target.lastMessageAt;
    const isLatest = !knownActivity || lastMessageAt > knownActivity;

    const nextMeta: Record<string, unknown> = {
      ...meta,
      membersConversationIds: appendMembersId(seen, threadId),
    };
    const data: Prisma.ConversationUpdateInput = {};
    if (isLatest) {
      Object.assign(nextMeta, tenantMetadata(item.conversation));
      nextMeta.membersLastActivityAt = lastMessageAt.toISOString();
      if (target.externalThreadId !== threadId) data.externalThreadId = threadId;
    }
    if (JSON.stringify(nextMeta) !== JSON.stringify(meta)) {
      data.metadata = nextMeta as Prisma.InputJsonValue;
    }
    if (!target.lastMessageAt || lastMessageAt > target.lastMessageAt) {
      data.lastMessageAt = lastMessageAt;
    }
    if (startedAt < target.createdAt) data.createdAt = startedAt;

    const reopen = !alreadySeen && !isClosed && target.status === ConversationStatus.CLOSED;
    if (reopen) {
      data.status = ConversationStatus.PENDING;
      data.closedAt = null;
      data.assignedTo = { disconnect: true };
    }

    if (Object.keys(data).length > 0) {
      await this.prisma.conversation.update({ where: { id: target.id }, data });
    }
    if (reopen) {
      await this.prisma.conversationAuditLog.create({
        data: {
          conversationId: target.id,
          action: 'REOPENED',
          fromValue: ConversationStatus.CLOSED,
          toValue: ConversationStatus.PENDING,
          metadata: { trigger: 'history_import', externalThreadId: threadId },
        },
      });
    }
    return { conversationId: target.id, isNew: false, newThread: !alreadySeen };
  }
}

/** Máximo de ids de conversa do members guardados na metadata (rastreio). */
export const MEMBERS_IDS_CAP = 100;

/** Ids de conversa do members já vistos pela conversa (+ o thread atual). */
export function seenMembersIds(
  metadata: Record<string, unknown>,
  externalThreadId: string | null,
): string[] {
  const list = Array.isArray(metadata.membersConversationIds)
    ? (metadata.membersConversationIds as unknown[]).filter(
        (x): x is string => typeof x === 'string',
      )
    : [];
  if (externalThreadId && !list.includes(externalThreadId)) list.push(externalThreadId);
  return list;
}

/** Acrescenta (se ainda não está) e corta nos mais recentes. */
export function appendMembersId(list: string[], id: string): string[] {
  const next = list.includes(id) ? [...list] : [...list, id];
  return next.slice(-MEMBERS_IDS_CAP);
}

export function parseDate(v: unknown): Date | null {
  if (typeof v !== 'string' && !(v instanceof Date)) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function tenantMetadata(ref: MembersConversationRef): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  if (ref.tenantName) meta.membersTenantName = ref.tenantName;
  if (ref.tenantId) meta.membersTenantId = ref.tenantId;
  return meta;
}

export function buildHandoffNote(handoff: MembersHandoff): string {
  const lines = ['Transferido pelo bot da área de membros.'];
  if (handoff.reason) lines.push(`Motivo: ${handoff.reason}`);
  if (handoff.transcript?.trim()) {
    lines.push('', 'Conversa com o bot:', handoff.transcript.trim());
  }
  return lines.join('\n');
}
