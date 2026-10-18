import { Injectable, Logger } from '@nestjs/common';
import { OnboardingLead, Prisma } from '@prisma/client';
import { LeadOnboardingRepository } from './lead-onboarding.repository';
import { HoppeLeadsClient } from './hoppe-leads.client';
import {
  HumanConversationError,
  OnboardingMessengerService,
} from './onboarding-messenger.service';
import { LeadOnboardingConfigService } from './lead-onboarding-config.service';
import { OnboardingSummaryService } from './onboarding-summary.service';
import {
  ATIVIDADE,
  ATTEMPT_TAGS,
  HOPPE_FIELD,
  HOPPE_STATUS,
  HOPPE_STATUS_NAME_NOVA,
  OnboardingState,
} from './lead-onboarding.constants';
import {
  adjustToSendWindow,
  buildPromptContext,
  isRio,
  LeadSnapshot,
  nextAttemptDelayHours,
  renderAttempt,
  renderResume,
  revenueAbove500kYear,
  snapshotFromTask,
} from './onboarding-rules';

const HOUR = 3_600_000;
const SUMMARY_DEBOUNCE_MS = 30 * 60 * 1000;

export type QualificationResult = 'qualificado' | 'aguardando_socios' | 'desqualificado';

export interface QualificationInput {
  resultado: QualificationResult;
  motivo: string;
  faturamentoConfirmado?: string | null;
  nivel?: string | null;
  objetivo?: string | null;
  prioridade?: string | null;
  decisor?: boolean | null;
  socios?: string[] | null;
}

/**
 * Máquina de estados do onboarding pós-venda. O cron chama `tick` a cada
 * poucos minutos; o pipeline de inbound chama `onInbound`; as tools do agente
 * chamam `recordQualification` / `recordScheduled` / `optOut`.
 *
 * Toda escrita no Hoppe é best-effort: falha vira log e o estado local segue
 * (a mensagem pro lead já saiu, não dá pra "desenviar").
 */
@Injectable()
export class LeadOnboardingService {
  private readonly logger = new Logger(LeadOnboardingService.name);

  constructor(
    private readonly repo: LeadOnboardingRepository,
    private readonly hoppe: HoppeLeadsClient,
    private readonly messenger: OnboardingMessengerService,
    private readonly config: LeadOnboardingConfigService,
    private readonly summaries: OnboardingSummaryService,
  ) {}

  async tick(now = new Date()): Promise<{ processed: number }> {
    if (!this.config.enabled) return { processed: 0 };
    const due = await this.repo.findDue(['PENDING', 'CONTACTED', 'REPLIED'], now);
    let processed = 0;
    for (const lead of due) {
      // Claim atômico: outro tick/réplica já pegou, ou o estado mudou desde a leitura.
      if (!(await this.repo.claim(lead))) continue;
      try {
        await this.processDue(lead, now);
        processed++;
      } catch (err) {
        this.logger.warn(`Onboarding lead ${lead.id} falhou: ${(err as Error).message}`);
        // Não deixa um lead quebrado travar o cron: tenta de novo em 30min.
        await this.repo.update(lead.id, { nextActionAt: new Date(now.getTime() + 30 * 60 * 1000) });
      }
    }
    for (const lead of await this.repo.findSummaryDue(now)) {
      try {
        await this.summaries.summarize(lead);
        await this.repo.update(lead.id, { summaryDueAt: null, lastSummaryAt: now });
      } catch (err) {
        this.logger.warn(`Resumo do lead ${lead.id} falhou: ${(err as Error).message}`);
        await this.repo.update(lead.id, { summaryDueAt: new Date(now.getTime() + SUMMARY_DEBOUNCE_MS) });
      }
    }
    return { processed };
  }

  private async processDue(lead: OnboardingLead, now: Date): Promise<void> {
    if (lead.state === 'PENDING') return this.start(lead, now);
    if (lead.state === 'CONTACTED') {
      if (lead.attempt >= 3) return this.inactivate(lead, now);
      return this.sendAttempt(lead, (lead.attempt + 1) as 2 | 3, now);
    }
    if (lead.state === 'REPLIED') return this.resume(lead, now);
  }

  private async start(lead: OnboardingLead, now: Date): Promise<void> {
    const deferred = await this.deferIfNeeded(lead, now, true);
    if (deferred) return;

    const task = await this.hoppe.getTask(lead.hoppeTaskId);
    if (!task) return this.skip(lead, 'task não encontrada no Hoppe');
    if ((task.statusName ?? '').toLowerCase() !== HOPPE_STATUS_NAME_NOVA) {
      return this.skip(lead, `status "${task.statusName}" (só abordamos "nova oportunidade")`);
    }
    const snapshot = snapshotFromTask(task);
    if (!snapshot.phone) return this.skip(lead, 'sem WhatsApp na task');

    const target = await this.messenger.resolveTarget(snapshot.phone);
    if (!target) {
      await this.safe(() => this.hoppe.setField(lead.hoppeTaskId, HOPPE_FIELD.ATIVIDADE, ATIVIDADE.INATIVO));
      return this.skip(lead, `o número ${snapshot.phone} não tem WhatsApp`);
    }

    let sent: { conversationId: string; contactId: string };
    try {
      sent = await this.messenger.send({
        target,
        name: snapshot.name,
        email: snapshot.email,
        text: renderAttempt(1, snapshot),
      });
    } catch (err) {
      if (err instanceof HumanConversationError) {
        return this.skip(
          lead,
          'conversa existente com o Tiago no 1258 nos últimos 30 dias, abordagem manual',
        );
      }
      throw err;
    }

    await this.safe(() =>
      this.messenger.setPromptContext(
        sent.conversationId,
        buildPromptContext(snapshot, { attempt: 1, state: 'CONTACTED' }),
      ),
    );
    await this.afterAttempt(lead, 1, now, {
      conversationId: sent.conversationId,
      contactId: sent.contactId,
      phone: target.digits,
      snapshot: snapshot as unknown as Prisma.InputJsonValue,
      firstAttemptAt: now,
    });
  }

  private async sendAttempt(lead: OnboardingLead, attempt: 2 | 3, now: Date): Promise<void> {
    if (await this.deferIfNeeded(lead, now, false)) return;
    const snapshot = this.snapshotOf(lead);
    if (!lead.phone || !lead.conversationId) return this.skip(lead, 'lead sem telefone/conversa resolvidos');
    if (await this.blockedByConversation(lead, now)) return;
    await this.messenger.send({
      target: { digits: lead.phone, jid: `${lead.phone}@s.whatsapp.net` },
      name: snapshot.name,
      email: snapshot.email,
      text: renderAttempt(attempt, snapshot),
      conversationId: lead.conversationId,
    });
    await this.afterAttempt(lead, attempt, now, {});
  }

  private async afterAttempt(
    lead: OnboardingLead,
    attempt: 1 | 2 | 3,
    now: Date,
    extra: Prisma.OnboardingLeadUpdateInput,
  ): Promise<void> {
    const hours = nextAttemptDelayHours(attempt, this.config.cadenceHours) ?? 24;
    const { start, end } = this.config.sendWindow;
    const nextActionAt =
      attempt === 3
        ? new Date(now.getTime() + hours * HOUR) // inativação não precisa de janela
        : adjustToSendWindow(new Date(now.getTime() + hours * HOUR), start, end);
    const dates = [...this.dates(lead), now.toISOString()];

    // Condicional: se o lead respondeu/deu opt-out/foi pausado durante o
    // envio, não volta pra CONTACTED — só registra a tentativa que saiu.
    const ok = await this.repo.updateIfState(lead.id, ['PENDING', 'CONTACTED'], {
      ...(extra as Prisma.OnboardingLeadUpdateManyMutationInput),
      ...(extra.conversationId ? { conversationId: extra.conversationId as string } : {}),
      ...(extra.contactId ? { contactId: extra.contactId as string } : {}),
      state: 'CONTACTED',
      attempt,
      lastAttemptAt: now,
      attemptDates: dates,
      nextActionAt,
    });
    if (!ok) {
      await this.repo.update(lead.id, { ...extra, attempt, lastAttemptAt: now, attemptDates: dates });
    }
    await this.safe(() => this.hoppe.addTag(lead.hoppeTaskId, ATTEMPT_TAGS[attempt]));
    if (attempt === 1) {
      await this.safe(() => this.hoppe.setField(lead.hoppeTaskId, HOPPE_FIELD.ATIVIDADE, ATIVIDADE.ATIVO));
    }
    await this.safe(() =>
      this.hoppe.addComment(
        lead.hoppeTaskId,
        `${attempt}ª tentativa de contato enviada pelo assistente virtual (WhatsApp 1258) em ${fmt(now)}.`,
      ),
    );
  }

  private async inactivate(lead: OnboardingLead, now: Date): Promise<void> {
    await this.repo.update(lead.id, { state: 'INACTIVE', nextActionAt: null });
    await this.safe(() => this.hoppe.setField(lead.hoppeTaskId, HOPPE_FIELD.ATIVIDADE, ATIVIDADE.INATIVO));
    const datas = this.dates(lead).map((d) => fmt(new Date(d))).join(', ');
    await this.safe(() =>
      this.hoppe.addComment(
        lead.hoppeTaskId,
        `Sem resposta após 3 tentativas (${datas}). Atividade marcada como Inativo em ${fmt(now)}; status mantido.`,
      ),
    );
  }

  /** Retomada única de quem parou no meio do agendamento. */
  private async resume(lead: OnboardingLead, now: Date): Promise<void> {
    if (!lead.pendingReason || lead.resumeSentAt || !lead.conversationId || !lead.phone) {
      await this.repo.update(lead.id, { nextActionAt: null });
      return;
    }
    if (await this.deferIfNeeded(lead, now, false)) return;
    if (await this.blockedByConversation(lead, now)) return;
    const text = renderResume(lead.pendingReason, this.snapshotOf(lead), lead.pendingDetail);
    if (!text) {
      await this.repo.update(lead.id, { nextActionAt: null });
      return;
    }
    await this.messenger.send({
      target: { digits: lead.phone, jid: `${lead.phone}@s.whatsapp.net` },
      name: null,
      email: null,
      text,
      conversationId: lead.conversationId,
    });
    await this.repo.update(lead.id, { resumeSentAt: now, nextActionAt: null });
    await this.safe(() =>
      this.hoppe.addComment(lead.hoppeTaskId, `Retomada enviada em ${fmt(now)} (pendência: ${lead.pendingReason}).`),
    );
  }

  /**
   * Guarda independente do hook de inbound: o lead já respondeu (hook falhou)
   * ou um humano assumiu/desligou a IA. Retorna true quando bloqueou.
   */
  private async blockedByConversation(lead: OnboardingLead, now: Date): Promise<boolean> {
    if (!lead.conversationId) return false;
    const guard = await this.messenger.conversationGuard(lead.conversationId, lead.lastAttemptAt ?? null);
    if (guard === 'replied') {
      await this.repo.update(lead.id, { state: 'REPLIED', repliedAt: lead.repliedAt ?? now, nextActionAt: null });
      await this.safe(() => this.hoppe.setStatus(lead.hoppeTaskId, HOPPE_STATUS.EM_QUALIFICACAO));
      await this.safe(() => this.hoppe.addComment(lead.hoppeTaskId, `Lead respondeu (detectado em ${fmt(now)}). Status movido para em qualificação.`));
      return true;
    }
    if (guard === 'human') {
      await this.repo.update(lead.id, { state: 'PAUSED', nextActionAt: null });
      await this.safe(() => this.hoppe.addComment(lead.hoppeTaskId, `Conversa assumida por humano ou IA desligada; contatos automáticos pausados em ${fmt(now)}.`));
      return true;
    }
    return false;
  }

  /**
   * Fora da janela de envio (ou com o teto diário de 1ªs mensagens batido)
   * só reagenda. Retorna true quando reagendou.
   */
  private async deferIfNeeded(lead: OnboardingLead, now: Date, isFirst: boolean): Promise<boolean> {
    const { start, end } = this.config.sendWindow;
    const inWindow = adjustToSendWindow(now, start, end);
    if (inWindow.getTime() !== now.getTime()) {
      await this.repo.update(lead.id, { nextActionAt: inWindow });
      return true;
    }
    if (isFirst) {
      const sent = await this.repo.countFirstAttemptsSince(startOfBrtDay(now));
      if (sent >= this.config.dailyCap) {
        const tomorrow = adjustToSendWindow(new Date(startOfBrtDay(now).getTime() + 24 * HOUR), start, end);
        await this.repo.update(lead.id, { nextActionAt: tomorrow });
        return true;
      }
    }
    return false;
  }

  private async skip(lead: OnboardingLead, motivo: string): Promise<void> {
    await this.repo.update(lead.id, { state: 'SKIPPED', nextActionAt: null });
    await this.safe(() => this.hoppe.addComment(lead.hoppeTaskId, `Assistente virtual: lead ignorado: ${motivo}.`));
    this.logger.log(`Onboarding lead ${lead.id} ignorado: ${motivo}`);
  }

  // ─── Inbound ───────────────────────────────────────────────

  /** Chamado pelo pipeline de inbound em toda mensagem nova da conversa. */
  async onInbound(
    conversationId: string,
    msg: { isEcho: boolean; isNew: boolean; text: string | null },
  ): Promise<void> {
    const lead = await this.repo.findByConversation(conversationId);
    if (!lead) return;
    const now = new Date();

    if (msg.isEcho) {
      if (!msg.isNew || ['PAUSED', 'OPTED_OUT'].includes(lead.state)) return;
      if (await this.messenger.hasRecentSystemOutbound(conversationId, msg.text)) return;
      await this.repo.update(lead.id, { state: 'PAUSED', nextActionAt: null });
      await this.messenger.pauseConversation(conversationId);
      await this.safe(() =>
        this.hoppe.addComment(lead.hoppeTaskId, `Tiago respondeu direto pelo WhatsApp em ${fmt(now)}; IA pausada nesta conversa.`),
      );
      return;
    }

    if (lead.state === 'CONTACTED' || lead.state === 'INACTIVE') {
      const wasInactive = lead.state === 'INACTIVE';
      await this.repo.update(lead.id, {
        state: 'REPLIED',
        repliedAt: lead.repliedAt ?? now,
        lastInboundAt: now,
        nextActionAt: null,
        summaryDueAt: new Date(now.getTime() + SUMMARY_DEBOUNCE_MS),
      });
      await this.safe(() => this.hoppe.setStatus(lead.hoppeTaskId, HOPPE_STATUS.EM_QUALIFICACAO));
      await this.safe(() => this.hoppe.setField(lead.hoppeTaskId, HOPPE_FIELD.ATIVIDADE, ATIVIDADE.ATIVO));
      await this.safe(() =>
        this.hoppe.addComment(
          lead.hoppeTaskId,
          wasInactive
            ? `Lead voltou a responder em ${fmt(now)} depois de inativado. Status movido para em qualificação.`
            : `Lead respondeu em ${fmt(now)}. Status movido para em qualificação.`,
        ),
      );
      return;
    }

    if (['REPLIED', 'SCHEDULED', 'DISQUALIFIED'].includes(lead.state)) {
      // Resposta cancela a retomada pendente e empurra o resumo.
      await this.repo.update(lead.id, {
        lastInboundAt: now,
        nextActionAt: null,
        summaryDueAt: new Date(now.getTime() + SUMMARY_DEBOUNCE_MS),
      });
    }
  }

  // ─── Tools do agente ───────────────────────────────────────

  findByConversation(conversationId: string): Promise<OnboardingLead | null> {
    return this.repo.findByConversation(conversationId);
  }

  async recordQualification(lead: OnboardingLead, input: QualificationInput): Promise<void> {
    const now = new Date();
    const snapshot = this.snapshotOf(lead);
    const faixa = input.faturamentoConfirmado ?? snapshot.faturamento;
    if (input.faturamentoConfirmado) {
      await this.safe(() =>
        this.hoppe.setField(lead.hoppeTaskId, HOPPE_FIELD.FATURAMENTO_MENSAL, input.faturamentoConfirmado),
      );
    }
    const dados = [
      `objetivo: ${input.objetivo ?? 'não informado'}`,
      `nível: ${input.nivel ?? 'não informado'}`,
      `faturamento mensal: ${faixa ?? 'não informado'}`,
      `decisor: ${input.decisor === true ? 'sim' : input.decisor === false ? 'não' : 'não informado'}`,
      `sócios: ${input.socios?.length ? input.socios.join(', ') : 'nenhum informado'}`,
      `prioridade: ${input.prioridade ?? 'não informada'}`,
    ].join('; ');

    if (input.resultado === 'desqualificado') {
      await this.repo.update(lead.id, { state: 'DISQUALIFIED', pendingReason: null, nextActionAt: null });
      await this.safe(() => this.hoppe.setStatus(lead.hoppeTaskId, HOPPE_STATUS.DESQUALIFICADO));
      await this.safe(() =>
        this.hoppe.addComment(lead.hoppeTaskId, `Desqualificado pelo assistente virtual em ${fmt(now)}. Motivo: ${input.motivo}. Dados: ${dados}.`),
      );
      return;
    }

    if (input.resultado === 'aguardando_socios') {
      await this.repo.update(lead.id, {
        pendingReason: 'socios',
        pendingDetail: input.socios?.[0] ?? null,
        resumeSentAt: null,
        nextActionAt: new Date(now.getTime() + 24 * HOUR),
      });
      await this.safe(() =>
        this.hoppe.addComment(lead.hoppeTaskId, `Qualificado, aguardando confirmação dos sócios (${input.socios?.join(', ') || 'a definir'}). ${input.motivo}. Dados: ${dados}.`),
      );
      return;
    }

    await this.repo.update(lead.id, { pendingReason: null, nextActionAt: null });
    await this.safe(() =>
      this.hoppe.addComment(
        lead.hoppeTaskId,
        `Qualificado para o Diagnóstico de IA em ${fmt(now)}. ${input.motivo}. Dados: ${dados}. Oferta sugerida pro Pedro: ${suggestedOffer(snapshot.phone, faixa)}.`,
      ),
    );
  }

  /** Lead combinou horário mas falta algo (e-mail, horário): agenda a retomada. */
  async markPending(lead: OnboardingLead, reason: 'horario' | 'email'): Promise<void> {
    await this.repo.update(lead.id, {
      pendingReason: reason,
      resumeSentAt: null,
      nextActionAt: new Date(Date.now() + 24 * HOUR),
    });
  }

  async recordScheduled(
    lead: OnboardingLead,
    meeting: { eventId: string; startIso: string; attendees: string[]; meetLink: string | null },
  ): Promise<void> {
    await this.repo.update(lead.id, {
      state: 'SCHEDULED',
      meetingEventId: meeting.eventId,
      pendingReason: null,
      nextActionAt: null,
    });
    await this.safe(() => this.hoppe.setStatus(lead.hoppeTaskId, HOPPE_STATUS.REUNIAO_AGENDADA));
    await this.safe(() =>
      this.hoppe.addComment(
        lead.hoppeTaskId,
        `Diagnóstico de IA agendado para ${fmt(new Date(meeting.startIso))} (1h) com ${meeting.attendees.join(', ')}. Meet: ${meeting.meetLink ?? 'link no convite'}.`,
      ),
    );
  }

  async optOut(lead: OnboardingLead, motivo: string): Promise<void> {
    await this.repo.update(lead.id, { state: 'OPTED_OUT', nextActionAt: null, pendingReason: null });
    await this.safe(() =>
      this.hoppe.addComment(lead.hoppeTaskId, `Lead pediu para não receber mais mensagens (${motivo}) em ${fmt(new Date())}. Contatos automáticos encerrados.`),
    );
  }

  // ─── helpers ───────────────────────────────────────────────

  private snapshotOf(lead: OnboardingLead): LeadSnapshot {
    return (lead.snapshot ?? {}) as unknown as LeadSnapshot;
  }

  private dates(lead: OnboardingLead): string[] {
    return Array.isArray(lead.attemptDates) ? (lead.attemptDates as string[]) : [];
  }

  private async safe(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.logger.warn(`Onboarding: escrita externa falhou: ${(err as Error).message}`);
    }
  }
}

/** Oferta que o Pedro deve levar pro diagnóstico (anotação interna, nunca pro cliente). */
export function suggestedOffer(phone: string | null, faixa: string | null): string {
  if (!revenueAbove500kYear(faixa)) return 'Pedro decide na reunião (faturamento abaixo de R$ 500k/ano ou não confirmado)';
  return isRio(phone) ? 'evento presencial (Rio, acima de R$ 500k/ano)' : 'Maestria (fora do Rio, acima de R$ 500k/ano)';
}

function startOfBrtDay(at: Date): Date {
  const local = new Date(at.getTime() - 3 * HOUR);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 3));
}

function fmt(d: Date): string {
  return d.toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export type { OnboardingState };
