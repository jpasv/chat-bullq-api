import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
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
import {
  RECOVERY_OUTREACH_QUEUE,
  RECOVERY_OUTREACH_JOB,
} from './sales-recovery.constants';

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
    @InjectQueue(RECOVERY_OUTREACH_QUEUE) private readonly outreachQueue: Queue,
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
    if (k.customerPhone) {
      const resolved = await this.outreach.resolveContact(
        organizationId,
        channelId,
        { phone: k.customerPhone, name: k.customerName, email: k.customerEmail },
      );
      contactId = resolved.contactId;
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

    // Cold outreach: abandono dispara na hora; PIX/boleto/recusado esperam
    // (delay configurável) e só enviam se o lead ainda não pagou. Sem contato
    // (sem telefone) não há como contatar — card fica em Oportunidade.
    if (contactId) {
      const delayMs = this.config.outreachDelayMsForEvent(k.event);
      if (delayMs <= 0) {
        await this.dispatchOutreach(created.id).catch((err) =>
          this.logger.warn(
            `Outreach imediato falhou card=${created.id}: ${(err as Error).message}`,
          ),
        );
      } else {
        await this.outreachQueue.add(
          RECOVERY_OUTREACH_JOB,
          { cardId: created.id },
          {
            delay: delayMs,
            attempts: 3,
            backoff: { type: 'exponential', delay: 30_000 },
            removeOnComplete: true,
            removeOnFail: false,
          },
        );
        this.logger.log(
          `Outreach agendado em ${Math.round(delayMs / 60000)}min card=${created.id} (${k.event})`,
        );
      }
    }

    return { status: 'created', cardId: created.id };
  }

  /**
   * Dispara o opener pro card SE ainda fizer sentido: card aberto, ainda em
   * Oportunidade (não pago) e respeitando o cooldown de 24h por contato.
   * Usado tanto no envio imediato quanto no job agendado (após o delay).
   */
  async dispatchOutreach(cardId: string): Promise<void> {
    const channelId = this.config.outreachChannelId;
    if (!channelId) return;

    const card = await this.prisma.card.findUnique({
      where: { id: cardId },
      include: { contact: { select: { name: true } } },
    });
    if (!card || card.status !== 'OPEN' || !card.contactId) return;
    // Card de antes da (re)ativação não recebe nada (RECOVERY_ACTIVE_SINCE).
    if (!this.config.isInActiveWindow(card.createdAt)) return;

    // Só dispara se ainda está em Oportunidade — se já pagou/mudou, não manda.
    const oppStageId = await this.repo.resolveStageId(
      card.organizationId,
      'opportunity',
    );
    if (card.stageId !== oppStageId) return;

    // Fora do horário de envio: reagenda pro começo da janela. Na hora
    // confere de novo se ainda está em Oportunidade (não pagou).
    const waitMs = this.config.msUntilSendWindow();
    if (waitMs > 0) {
      await this.outreachQueue.add(
        RECOVERY_OUTREACH_JOB,
        { cardId },
        {
          delay: waitMs,
          jobId: `recovery-window-${cardId}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 30_000 },
          removeOnComplete: true,
          removeOnFail: false,
        },
      );
      this.logger.log(
        `Outreach fora do horário, reagendado em ${Math.round(waitMs / 60000)}min card=${cardId}`,
      );
      return;
    }

    // Cooldown: no máx 1 mensagem de recuperação por contato a cada 24h.
    if (await this.hasRecentOutreach(card.organizationId, card.contactId)) {
      this.logger.log(`Outreach pulado (cooldown ${this.config.cooldownHours}h) card=${cardId}`);
      return;
    }
    // Trava contra dobro: já saiu qualquer mensagem pra esse telefone nos
    // canais vigiados nas últimas 24h (gente ou automação) → não manda.
    if (await this.hasRecentMessageOnGuardChannels(card.organizationId, card.contactId)) {
      this.logger.log(`Outreach pulado (mensagem recente nos canais vigiados) card=${cardId}`);
      return;
    }

    const cc = await this.prisma.contactChannel.findFirst({
      where: { contactId: card.contactId, channelId },
      select: { externalId: true },
    });
    if (!cc) return;

    const meta = (card.metadata as Record<string, any>) ?? {};
    const k = (meta.kirvano as Record<string, any>) ?? {};
    const { conversationId, sent } = await this.outreach.sendOpener({
      organizationId: card.organizationId,
      channelId,
      contactId: card.contactId,
      externalId: cc.externalId,
      agentId: this.config.recoveryAgentId,
      vars: {
        nome: card.contact?.name ?? '',
        produto:
          this.config.productAlias(k.productUuid ?? null) ??
          k.productName ??
          '',
        link: k.checkoutUrl ?? '',
      },
    });

    await this.prisma.card.update({
      where: { id: cardId },
      data: {
        conversationId,
        ...(sent
          ? {
              metadata: {
                ...meta,
                outreach: {
                  attempts: 1,
                  lastSentAt: new Date().toISOString(),
                },
              } as Prisma.InputJsonValue,
            }
          : {}),
      },
    });

    if (sent) {
      await this.moveToKey(card.organizationId, cardId, 'contact_attempt');
    }
  }

  /**
   * Saiu alguma mensagem (OUTBOUND, de qualquer remetente) pro telefone desse
   * contato nos canais vigiados dentro da janela de cooldown? Compara pelo
   * telefone, não só pelo contato: o mesmo número pode ter contato diferente
   * por canal, e o celular BR pode vir com ou sem o 9.
   */
  private async hasRecentMessageOnGuardChannels(
    organizationId: string,
    contactId: string,
  ): Promise<boolean> {
    const channelIds = this.config.guardChannelIds;
    if (channelIds.length === 0) return false;
    const contact = await this.prisma.contact.findUnique({
      where: { id: contactId },
      select: { phone: true },
    });
    const phones = phoneVariants(contact?.phone ?? null);
    const contactIds = new Set<string>([contactId]);
    if (phones.length) {
      const same = await this.prisma.contact.findMany({
        where: { organizationId, phone: { in: phones }, deletedAt: null },
        select: { id: true },
      });
      for (const c of same) contactIds.add(c.id);
    }
    const since = new Date(Date.now() - this.config.cooldownHours * 60 * 60 * 1000);
    const recent = await this.prisma.message.findFirst({
      where: {
        direction: 'OUTBOUND',
        createdAt: { gt: since },
        conversation: {
          organizationId,
          channelId: { in: channelIds },
          contactId: { in: [...contactIds] },
        },
      },
      select: { id: true },
    });
    return !!recent;
  }

  /** Já houve mensagem de recuperação pro contato dentro da janela de cooldown? */
  private async hasRecentOutreach(
    organizationId: string,
    contactId: string,
  ): Promise<boolean> {
    const pipelineId = await this.repo.getPipelineId(organizationId);
    const sinceMs = Date.now() - this.config.cooldownHours * 60 * 60 * 1000;
    const cards = await this.prisma.card.findMany({
      where: { organizationId, pipelineId, contactId },
      select: { metadata: true },
    });
    for (const c of cards) {
      const ls = (c.metadata as any)?.outreach?.lastSentAt;
      if (ls && new Date(ls).getTime() > sinceMs) return true;
    }
    return false;
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
    // Card de antes da (re)ativação: sem lembrete nem mudança de etapa — a
    // fila antiga não recebe nada (RECOVERY_ACTIVE_SINCE).
    if (!this.config.isInActiveWindow(card.createdAt)) return 'skipped';

    const meta = (card.metadata as Record<string, any>) ?? {};
    const attempts = Number(meta?.outreach?.attempts ?? 1);

    if (attempts >= this.config.maxAttempts) {
      await this.moveToKey(organizationId, cardId, 'lost');
      return 'lost';
    }

    // Lembrete só no horário de envio; fora dele o cron tenta de novo depois.
    if (this.config.msUntilSendWindow() > 0) return 'skipped';

    const channelId = this.config.outreachChannelId;
    const cooldownOk =
      card.contactId &&
      !(await this.hasRecentOutreach(organizationId, card.contactId)) &&
      !(await this.hasRecentMessageOnGuardChannels(organizationId, card.contactId));
    if (card.contactId && channelId && cooldownOk) {
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
              produto:
                this.config.productAlias(kirvano.productUuid ?? null) ??
                kirvano.productName ??
                '',
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

/**
 * Formas do mesmo telefone como podem estar gravadas: só dígitos, com "+",
 * e celular BR com e sem o nono dígito (WhatsApp às vezes entrega sem).
 */
export function phoneVariants(raw: string | null): string[] {
  const digits = (raw ?? '').replace(/\D/g, '');
  if (!digits) return [];
  const set = new Set<string>([digits]);
  const withNine = digits.match(/^55(\d{2})9(\d{8})$/);
  if (withNine) set.add(`55${withNine[1]}${withNine[2]}`);
  const withoutNine = digits.match(/^55(\d{2})(\d{8})$/);
  if (withoutNine) set.add(`55${withoutNine[1]}9${withoutNine[2]}`);
  for (const d of [...set]) set.add(`+${d}`);
  return [...set];
}

