import { Injectable, Logger } from '@nestjs/common';
import { Card, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { PipelinesService } from '../pipelines/pipelines.service';
import {
  RecoveryCardsRepository,
  RecoveryStageKey,
} from './recovery-cards.repository';
import { RecoveryOutreachService } from './recovery-outreach.service';
import { RecoveryConfigService } from './recovery-config.service';
import { KirvanoNormalized } from './webhooks/kirvano-payload';

export interface RecoveryActionResult {
  status:
    | 'created'
    | 'exists'
    | 'moved'
    | 'no_card'
    | 'no_phone'
    | 'skipped';
  cardId?: string;
}

/**
 * Orquestra criação/movimentação de cards no pipeline de recuperação. As
 * transições determinísticas (criar Oportunidade, fechar Ganho/Reembolsado)
 * vêm dos webhooks da Kirvano; "Em Contato" vem do inbound; "Follow Up/Perdido"
 * do cron; e a IA pode mover via tool. Sempre passa por `PipelinesService` pra
 * herdar a lógica atômica de ordem/status e os eventos socket `card:*`.
 */
@Injectable()
export class SalesRecoveryService {
  private readonly logger = new Logger(SalesRecoveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pipelines: PipelinesService,
    private readonly repo: RecoveryCardsRepository,
    private readonly outreach: RecoveryOutreachService,
    private readonly config: RecoveryConfigService,
  ) {}

  // ─── Webhook: Oportunidade ───────────────────────────────────

  async createOpportunity(
    organizationId: string,
    channelId: string,
    k: KirvanoNormalized,
  ): Promise<RecoveryActionResult> {
    const pipelineId = await this.repo.getPipelineId(organizationId);
    const opportunityStageId = await this.repo.resolveStageId(
      organizationId,
      'opportunity',
    );

    // Resolve/cria o contato (e o vínculo no canal de outreach) se houver
    // telefone — sem telefone não há como contatar, mas ainda registramos
    // o card pra visibilidade.
    let contactId: string | null = null;
    let externalId: string | null = null;
    if (k.customerPhone) {
      const resolved = await this.outreach.resolveContact(
        organizationId,
        channelId,
        { phone: k.customerPhone, name: k.customerName, email: k.customerEmail },
      );
      contactId = resolved.contactId;
      externalId = resolved.externalId;
    }

    // Idempotência: 1 card aberto por contato; senão dedupe pelo checkout.
    let existing: Card | null = null;
    if (contactId) {
      existing = await this.repo.findOpenCardByContact(organizationId, contactId);
    }
    if (!existing && k.checkoutId) {
      existing = await this.repo.findCardByCheckout(organizationId, k.checkoutId);
    }
    if (existing) {
      await this.mergeKirvanoMetadata(existing, k);
      return { status: 'exists', cardId: existing.id };
    }

    const title =
      k.customerName || k.productName || k.customerPhone || 'Lead Kirvano';
    const created = await this.pipelines.createCard(pipelineId, organizationId, {
      title,
      value: k.value ?? undefined,
      contactId: contactId ?? undefined,
      stageId: opportunityStageId,
    });
    await this.prisma.card.update({
      where: { id: created.id },
      data: { metadata: this.buildMetadata(k) as Prisma.InputJsonValue },
    });

    // Cold outreach: dispara a 1ª mensagem e move pra "Tentativa de Contato".
    if (contactId && externalId) {
      try {
        const { conversationId } = await this.outreach.sendOpener({
          organizationId,
          channelId,
          contactId,
          externalId,
          agentId: this.config.recoveryAgentId,
          vars: {
            nome: k.customerName ?? '',
            produto: k.productName ?? '',
            link: k.checkoutUrl ?? '',
          },
        });
        await this.prisma.card.update({
          where: { id: created.id },
          data: {
            conversationId,
            metadata: this.buildMetadata(k, {
              outreach: { attempts: 1, lastSentAt: new Date().toISOString() },
            }) as Prisma.InputJsonValue,
          },
        });
        await this.moveToKey(organizationId, created.id, 'contact_attempt');
      } catch (err) {
        this.logger.warn(
          `Outreach falhou pro card ${created.id} — fica em Oportunidade: ${(err as Error).message}`,
        );
      }
    }

    return { status: 'created', cardId: created.id };
  }

  // ─── Webhook: fechamento ─────────────────────────────────────

  async closeWon(
    organizationId: string,
    k: KirvanoNormalized,
  ): Promise<RecoveryActionResult> {
    const card = await this.findCardForClose(organizationId, k, true);
    if (!card) return { status: 'no_card' };
    await this.mergeKirvanoMetadata(card, k, {
      closedVia: `kirvano:${k.event}`,
    });
    await this.moveToKey(organizationId, card.id, 'won');
    return { status: 'moved', cardId: card.id };
  }

  async closeRefunded(
    organizationId: string,
    k: KirvanoNormalized,
  ): Promise<RecoveryActionResult> {
    const card = await this.findCardForClose(organizationId, k, false);
    if (!card) return { status: 'no_card' };
    await this.mergeKirvanoMetadata(card, k, {
      closedVia: `kirvano:${k.event}`,
    });
    await this.moveToKey(organizationId, card.id, 'refunded');
    return { status: 'moved', cardId: card.id };
  }

  // ─── Inbound / IA ────────────────────────────────────────────

  /**
   * Chamado pelo pipeline de inbound: se a conversa que recebeu mensagem tem
   * card aberto na recuperação em "Tentativa de Contato", move pra "Em Contato"
   * (o lead respondeu). No-op silencioso fora desse caso.
   */
  async onInboundReply(conversationId: string): Promise<void> {
    const card = await this.prisma.card.findFirst({
      where: { conversationId, status: 'OPEN' },
      select: { id: true, organizationId: true, stageId: true, pipelineId: true },
    });
    if (!card) return;

    const pipelineId = await this.repo.getPipelineId(card.organizationId).catch(
      () => null,
    );
    if (!pipelineId || pipelineId !== card.pipelineId) return; // não é da recuperação

    const contactAttemptStageId = await this.repo.resolveStageId(
      card.organizationId,
      'contact_attempt',
    );
    if (card.stageId !== contactAttemptStageId) return;

    await this.moveToKey(card.organizationId, card.id, 'in_contact');
  }

  /**
   * Escalada de card parado (chamado pelo cron): se já bateu o teto de
   * tentativas → Perdido; senão manda um follow-up e move pra "Follow Up".
   */
  async escalateStuckCard(
    organizationId: string,
    cardId: string,
  ): Promise<'follow_up' | 'lost' | 'skipped'> {
    const card = await this.prisma.card.findUnique({
      where: { id: cardId },
      include: { contact: { select: { name: true } } },
    });
    if (!card || card.status !== 'OPEN') return 'skipped';

    const meta = (card.metadata as Record<string, any>) ?? {};
    const attempts = Number(meta?.outreach?.attempts ?? 1);

    if (attempts >= this.config.maxAttempts) {
      await this.moveToKey(organizationId, cardId, 'lost');
      return 'lost';
    }

    const channelId = this.config.outreachChannelId;
    if (card.contactId && channelId) {
      const cc = await this.prisma.contactChannel.findFirst({
        where: { contactId: card.contactId, channelId },
        select: { externalId: true },
      });
      if (cc) {
        const kirvano = (meta.kirvano as Record<string, any>) ?? {};
        try {
          await this.outreach.sendFollowUp({
            organizationId,
            channelId,
            contactId: card.contactId,
            externalId: cc.externalId,
            conversationId: card.conversationId,
            agentId: this.config.recoveryAgentId,
            vars: {
              nome: card.contact?.name ?? '',
              produto: kirvano.productName ?? '',
              link: kirvano.checkoutUrl ?? '',
            },
          });
          await this.prisma.card.update({
            where: { id: cardId },
            data: {
              metadata: {
                ...meta,
                outreach: {
                  attempts: attempts + 1,
                  lastSentAt: new Date().toISOString(),
                },
              } as Prisma.InputJsonValue,
            },
          });
        } catch (err) {
          this.logger.warn(
            `Follow-up falhou pro card ${cardId}: ${(err as Error).message}`,
          );
        }
      }
    }

    await this.moveToKey(organizationId, cardId, 'follow_up');
    return 'follow_up';
  }

  /**
   * Move o card aberto de uma conversa (usado pela tool de IA). Garante que o
   * card é do funil de recuperação antes de mexer.
   */
  async moveCardByConversation(
    conversationId: string,
    stageKey: RecoveryStageKey,
  ): Promise<{ ok: boolean; error?: string }> {
    const card = await this.prisma.card.findFirst({
      where: { conversationId, status: 'OPEN' },
      select: { id: true, pipelineId: true, organizationId: true },
    });
    if (!card) return { ok: false, error: 'no_open_recovery_card' };

    const recoveryPipelineId = await this.repo
      .getPipelineId(card.organizationId)
      .catch(() => null);
    if (!recoveryPipelineId || recoveryPipelineId !== card.pipelineId) {
      return { ok: false, error: 'card_fora_do_funil_recuperacao' };
    }

    await this.moveToKey(card.organizationId, card.id, stageKey);
    return { ok: true };
  }

  /** Move um card pra um stage pela key (resolve stageId + posição). */
  async moveToKey(
    organizationId: string,
    cardId: string,
    stageKey: RecoveryStageKey,
  ): Promise<void> {
    const pipelineId = await this.repo.getPipelineId(organizationId);
    const toStageId = await this.repo.resolveStageId(organizationId, stageKey);
    const toIndex = await this.repo.nextIndexInStage(pipelineId, toStageId);
    await this.pipelines.moveCard(cardId, organizationId, { toStageId, toIndex });
  }

  // ─── helpers ─────────────────────────────────────────────────

  private async findCardForClose(
    organizationId: string,
    k: KirvanoNormalized,
    openOnly: boolean,
  ): Promise<Card | null> {
    if (k.checkoutId) {
      const byCheckout = await this.repo.findCardByCheckout(
        organizationId,
        k.checkoutId,
      );
      if (byCheckout) return byCheckout;
    }
    if (!k.customerPhone) return null;
    const contact = await this.prisma.contact.findFirst({
      where: { organizationId, phone: k.customerPhone, deletedAt: null },
      select: { id: true },
    });
    if (!contact) return null;

    if (openOnly) {
      return this.repo.findOpenCardByContact(organizationId, contact.id);
    }
    const pipelineId = await this.repo.getPipelineId(organizationId);
    return this.prisma.card.findFirst({
      where: { organizationId, pipelineId, contactId: contact.id },
      orderBy: { updatedAt: 'desc' },
    });
  }

  private buildMetadata(
    k: KirvanoNormalized,
    extra?: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      source: 'kirvano',
      kirvano: {
        event: k.event,
        saleId: k.saleId,
        checkoutId: k.checkoutId,
        productUuid: k.productUuid,
        offerId: k.offerId,
        productName: k.productName,
        value: k.value,
        currency: k.currency,
        checkoutUrl: k.checkoutUrl,
        paymentMethod: k.paymentMethod,
        utm: k.utm,
      },
      ...(extra ?? {}),
    };
  }

  /** Mescla os dados Kirvano mais recentes no metadata sem perder o resto. */
  private async mergeKirvanoMetadata(
    card: Card,
    k: KirvanoNormalized,
    extra?: Record<string, unknown>,
  ): Promise<void> {
    const current = (card.metadata as Record<string, unknown>) ?? {};
    const merged = {
      ...current,
      ...this.buildMetadata(k, extra),
      // preserva outreach já registrado
      outreach: (current as any).outreach ?? undefined,
    };
    await this.prisma.card.update({
      where: { id: card.id },
      data: { metadata: merged as Prisma.InputJsonValue },
    });
  }
}
