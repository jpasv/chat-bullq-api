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
  HOPPE_USER,
  HOPPE_STATUS_NAME_NOVA,
  HUMAN_TAG,
  MAX_SILENT_FOLLOWUPS,
  OnboardingState,
} from './lead-onboarding.constants';
import {
  adjustToSendWindow,
  buildPromptContext,
  isLikelyAutoReply,
  isRio,
  LeadSnapshot,
  nextAttemptDelayHours,
  renderAttempt,
  renderResume,
  renderSilentFollowup,
  renderAfterSupport,
  revenueAbove500kYear,
  snapshotFromTask,
  OFFICIAL_OUTREACH_NOTE,
  productRef,
} from './onboarding-rules';

const HOUR = 3_600_000;
const SUMMARY_DEBOUNCE_MS = 30 * 60 * 1000;
const MEETING_MS = HOUR;

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
    if (lead.state === 'REPLIED') return this.followUp(lead, now);
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
        template: this.template('abertura', snapshot),
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
        buildPromptContext(snapshot, { attempt: 1, state: 'CONTACTED' }) + OFFICIAL_OUTREACH_NOTE,
      ),
    );
    await this.safe(() => this.hoppe.setAssignees(lead.hoppeTaskId, { add: [HOPPE_USER.CLAUDE] }));
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
    const template = this.template(attempt === 2 ? 'lembrete' : 'ultima', snapshot);

    // Lead que nunca respondeu e foi abordado pelo 1258: a próxima tentativa
    // sai pelo canal de abordagem (API oficial), numa conversa nova.
    const outreach = this.messenger.outreachChannelId();
    if ((await this.messenger.channelOf(lead.conversationId)) !== outreach) {
      const target = await this.messenger.resolveTarget(snapshot.phone ?? lead.phone);
      if (!target) return this.skip(lead, 'número sem WhatsApp no canal de abordagem');
      let sent: { conversationId: string; contactId: string };
      try {
        sent = await this.messenger.send({
          target,
          name: snapshot.name,
          email: snapshot.email,
          text: renderAttempt(attempt, snapshot),
          template,
        });
      } catch (err) {
        if (err instanceof HumanConversationError) return this.skip(lead, 'conversa com o time no canal oficial, abordagem manual');
        throw err;
      }
      await this.safe(() =>
        this.messenger.setPromptContext(
          sent.conversationId,
          buildPromptContext(snapshot, { attempt, state: 'CONTACTED' }) + OFFICIAL_OUTREACH_NOTE,
        ),
      );
      await this.afterAttempt(lead, attempt, now, { conversationId: sent.conversationId, contactId: sent.contactId });
      return;
    }

    await this.messenger.send({
      target: { digits: lead.phone, jid: lead.phone },
      name: snapshot.name,
      email: snapshot.email,
      text: renderAttempt(attempt, snapshot),
      template,
      conversationId: lead.conversationId,
    });
    await this.afterAttempt(lead, attempt, now, {});
  }

  /**
   * Leva a conversa do lead do 1258 pro canal de abordagem (API oficial):
   * template de continuação, contexto com o histórico anterior e IA desligada
   * na conversa antiga. Público pra rodar a migração dos leads em andamento.
   */
  async migrateConversation(lead: OnboardingLead, now = new Date()): Promise<string | null> {
    const snapshot = this.snapshotOf(lead);
    const oldConversationId = lead.conversationId;
    const phone = snapshot.phone ?? lead.phone;
    if (!oldConversationId || !phone) return null;
    const target = await this.messenger.resolveTarget(phone);
    if (!target) return null;
    const template = this.template('continuacao', snapshot);
    const history = await this.messenger.transcript(oldConversationId);
    let sent: { conversationId: string; contactId: string };
    try {
      const continuacao = `oi ${template.vars[0]}, aqui é da Bravy. mudamos o nosso atendimento pra este número oficial e vou seguir daqui a nossa conversa sobre o ${template.vars[1]}`;
      sent = await this.messenger.send({ target, name: snapshot.name, email: snapshot.email, text: continuacao, template });
    } catch (err) {
      if (err instanceof HumanConversationError) {
        this.logger.warn(`Migração do lead ${lead.id}: conversa com o time no canal oficial, pulado`);
        return null;
      }
      throw err;
    }
    await this.safe(() =>
      this.messenger.setPromptContext(
        sent.conversationId,
        [
          buildPromptContext(snapshot, { attempt: lead.attempt, state: lead.state }),
          OFFICIAL_OUTREACH_NOTE,
          `\nEsta conversa continua uma anterior pelo WhatsApp do Tiago, que foi desativado. A 1ª mensagem aqui foi o template: "Oi ${template.vars[0]}, aqui é da Bravy. Mudamos o nosso atendimento para este número oficial e vou seguir daqui a nossa conversa sobre o ${template.vars[1]}. Pode me responder por aqui?". Quando o lead responder, retome de onde parou, sem repetir perguntas já respondidas. Histórico anterior:\n${history}`,
        ].join(''),
      ),
    );
    await this.safe(() => this.messenger.pauseConversation(oldConversationId));
    await this.repo.update(lead.id, {
      conversationId: sent.conversationId,
      contactId: sent.contactId,
      nextActionAt: this.followupAt(now),
    });
    await this.safe(() =>
      this.hoppe.addComment(lead.hoppeTaskId, `Conversa movida do WhatsApp do Tiago (restringido) pro número oficial da Bravy em ${fmt(now)}.`),
    );
    return sent.conversationId;
  }

  /** Template HSM da API oficial: {{1}} primeiro nome, {{2}} produto. */
  private template(kind: 'abertura' | 'lembrete' | 'ultima' | 'retomada' | 'continuacao', snapshot: LeadSnapshot) {
    const produto = (productRef(snapshot.produto) ?? 'nosso curso').replace(/^o /, '');
    return { name: this.config.templates[kind], vars: [snapshot.firstName?.trim() || 'tudo bem', produto] };
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
    await this.syncDates(lead, now, ok ? nextActionAt : undefined);
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
    await this.syncDates(lead, now, null);
    await this.safe(() => this.hoppe.setField(lead.hoppeTaskId, HOPPE_FIELD.ATIVIDADE, ATIVIDADE.INATIVO));
    const datas = this.dates(lead).map((d) => fmt(new Date(d))).join(', ');
    await this.safe(() =>
      this.hoppe.addComment(
        lead.hoppeTaskId,
        `Sem resposta após 3 tentativas (${datas}). Atividade marcada como Inativo em ${fmt(now)}; status mantido.`,
      ),
    );
  }

  /**
   * Lead parou de responder no meio da qualificação: até 2 retomadas, 24h
   * depois da última resposta dele e entre elas. Pendência de agendamento
   * (sócios, horário, e-mail) usa a retomada específica na 1ª. Depois da 2ª
   * sem resposta, Atividade vira Inativo (status mantido).
   */
  private async followUp(lead: OnboardingLead, now: Date): Promise<void> {
    if (!lead.conversationId || !lead.phone) {
      await this.repo.update(lead.id, { nextActionAt: null });
      return;
    }
    if (await this.deferIfNeeded(lead, now, false)) return;
    // Bola com o time (humano, aprovação pendente, resposta devida): não cutuca o lead.
    if (await this.messenger.followupGuard(lead.conversationId)) {
      await this.repo.update(lead.id, { nextActionAt: null });
      return;
    }
    const done = lead.silentFollowups ?? 0;
    if (done >= MAX_SILENT_FOLLOWUPS) {
      await this.repo.update(lead.id, { nextActionAt: null });
      await this.syncDates(lead, now, null);
      await this.safe(() => this.hoppe.setField(lead.hoppeTaskId, HOPPE_FIELD.ATIVIDADE, ATIVIDADE.INATIVO));
      await this.safe(() =>
        this.hoppe.addComment(lead.hoppeTaskId, `Sem resposta depois de ${done} retomadas na qualificação. Atividade marcada como Inativo em ${fmt(now)}; status mantido.`),
      );
      return;
    }
    const n = (done + 1) as 1 | 2;
    const snapshot = this.snapshotOf(lead);
    // Conversa no 1258 (restringido em 20/10): a retomada leva a conversa pro canal oficial.
    if ((await this.messenger.channelOf(lead.conversationId)) !== this.messenger.outreachChannelId()) {
      await this.migrateConversation(lead, now);
      await this.repo.update(lead.id, { silentFollowups: n });
      return;
    }
    // Parou com o suporte (Lívia): volta pro onboarding, que segue pro convite quando ele responder.
    const fromSupport = await this.messenger.returnFromSupport(lead.conversationId);
    const specific =
      n === 1 && lead.pendingReason && !lead.resumeSentAt
        ? renderResume(lead.pendingReason, snapshot, lead.pendingDetail)
        : null;
    await this.messenger.send({
      target: { digits: lead.phone, jid: `${lead.phone}@s.whatsapp.net` },
      name: null,
      email: null,
      template: this.template('retomada', snapshot),
      text: fromSupport ? renderAfterSupport(snapshot) : specific ?? renderSilentFollowup(n, snapshot),
      conversationId: lead.conversationId,
    });
    const { start, end } = this.config.sendWindow;
    const nextActionAt = adjustToSendWindow(new Date(now.getTime() + 24 * HOUR), start, end);
    await this.repo.update(lead.id, {
      silentFollowups: n,
      nextActionAt,
      ...(specific ? { resumeSentAt: now } : {}),
    });
    await this.syncDates(lead, now, nextActionAt);
    await this.safe(() =>
      this.hoppe.addComment(
        lead.hoppeTaskId,
        `${n}ª retomada enviada em ${fmt(now)}${specific ? ` (pendência: ${lead.pendingReason})` : ''}: lead sem resposta na qualificação.`,
      ),
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
      await this.syncDates(lead, now, null);
      await this.safe(() => this.hoppe.setStatus(lead.hoppeTaskId, HOPPE_STATUS.EM_QUALIFICACAO));
      await this.safe(() => this.hoppe.addComment(lead.hoppeTaskId, `Lead respondeu (detectado em ${fmt(now)}). Status movido para em qualificação.`));
      return true;
    }
    if (guard === 'support') {
      // Suporte (Lívia) atendendo: não interrompe, tenta de novo em 1h.
      await this.repo.update(lead.id, { nextActionAt: new Date(now.getTime() + HOUR) });
      return true;
    }
    if (guard === 'human') {
      await this.repo.update(lead.id, { state: 'PAUSED', nextActionAt: null });
      await this.syncDates(lead, now, null);
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
      await this.syncDates(lead, undefined, inWindow);
      return true;
    }
    if (isFirst) {
      const sent = await this.repo.countFirstAttemptsSince(startOfBrtDay(now));
      if (sent >= this.config.dailyCap) {
        const tomorrow = adjustToSendWindow(new Date(startOfBrtDay(now).getTime() + 24 * HOUR), start, end);
        await this.repo.update(lead.id, { nextActionAt: tomorrow });
        await this.syncDates(lead, undefined, tomorrow);
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
    msg: { isEcho: boolean; isNew: boolean; text: string | null; messageId?: string },
  ): Promise<void> {
    const lead = await this.repo.findByConversation(conversationId);
    if (!lead) return;
    const now = new Date();

    if (msg.isEcho) {
      if (!msg.isNew || ['PAUSED', 'OPTED_OUT'].includes(lead.state)) return;
      if (await this.messenger.hasRecentSystemOutbound(conversationId, msg.text)) return;
      await this.repo.update(lead.id, { state: 'PAUSED', nextActionAt: null });
      await this.messenger.pauseConversation(conversationId);
      await this.syncDates(lead, now, null);
      await this.safe(() => this.hoppe.removeTag(lead.hoppeTaskId, HUMAN_TAG));
      await this.safe(() =>
        this.hoppe.addComment(lead.hoppeTaskId, `Tiago respondeu direto pelo WhatsApp em ${fmt(now)}; IA pausada nesta conversa.`),
      );
      return;
    }

    // Resposta automática do WhatsApp Business do lead: não conta como
    // resposta (as tentativas seguem) e a IA não responde (flag na mensagem).
    if (lead.state === 'CONTACTED' && msg.isNew && isLikelyAutoReply(msg.text, lead.lastAttemptAt ?? null, now)) {
      if (msg.messageId) await this.safe(() => this.messenger.flagAutoReply(msg.messageId!));
      await this.safe(() =>
        this.hoppe.addComment(lead.hoppeTaskId, `Resposta automática do WhatsApp do lead em ${fmt(now)} ignorada; tentativas seguem.`),
      );
      return;
    }

    if (lead.state === 'CONTACTED' || lead.state === 'INACTIVE') {
      const wasInactive = lead.state === 'INACTIVE';
      const followupAt = this.followupAt(now);
      await this.repo.update(lead.id, {
        state: 'REPLIED',
        repliedAt: lead.repliedAt ?? now,
        lastInboundAt: now,
        nextActionAt: followupAt,
        silentFollowups: 0,
        summaryDueAt: new Date(now.getTime() + SUMMARY_DEBOUNCE_MS),
      });
      await this.syncDates(lead, now, followupAt);
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
      // Resposta reinicia a contagem de retomadas e empurra o resumo. Só
      // quem está em qualificação ganha retomada.
      const followupAt = lead.state === 'REPLIED' ? this.followupAt(now) : null;
      await this.repo.update(lead.id, {
        lastInboundAt: now,
        nextActionAt: followupAt,
        silentFollowups: 0,
        summaryDueAt: new Date(now.getTime() + SUMMARY_DEBOUNCE_MS),
      });
      if (lead.state === 'REPLIED' && (lead.silentFollowups ?? 0) >= MAX_SILENT_FOLLOWUPS) {
        await this.safe(() => this.hoppe.setField(lead.hoppeTaskId, HOPPE_FIELD.ATIVIDADE, ATIVIDADE.ATIVO));
      }
      // Em reunião agendada as datas são as da reunião: não mexe.
      if (lead.state !== 'SCHEDULED') await this.syncDates(lead, now, followupAt);
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
      await this.syncDates(lead, now, null);
      await this.safe(() => this.hoppe.setStatus(lead.hoppeTaskId, HOPPE_STATUS.DESQUALIFICADO));
      await this.safe(() =>
        this.hoppe.addComment(lead.hoppeTaskId, `Desqualificado pelo assistente virtual em ${fmt(now)}. Motivo: ${input.motivo}. Dados: ${dados}.`),
      );
      return;
    }

    if (input.resultado === 'aguardando_socios') {
      const resumeAt = new Date(now.getTime() + 24 * HOUR);
      await this.repo.update(lead.id, {
        snapshot: this.withQualification(lead, input, now),
        pendingReason: 'socios',
        pendingDetail: input.socios?.[0] ?? null,
        resumeSentAt: null,
        nextActionAt: resumeAt,
      });
      await this.syncDates(lead, now, resumeAt);
      await this.safe(() =>
        this.hoppe.addComment(lead.hoppeTaskId, `Qualificado, aguardando confirmação dos sócios (${input.socios?.join(', ') || 'a definir'}). ${input.motivo}. Dados: ${dados}.`),
      );
      return;
    }

    const followupAt = this.followupAt(now);
    await this.repo.update(lead.id, {
      pendingReason: null,
      nextActionAt: followupAt,
      snapshot: this.withQualification(lead, input, now),
    });
    await this.syncDates(lead, now, followupAt);
    await this.safe(() =>
      this.hoppe.addComment(
        lead.hoppeTaskId,
        `Qualificado para o Diagnóstico de IA em ${fmt(now)}. ${input.motivo}. Dados: ${dados}. Oferta sugerida pro Pedro: ${suggestedOffer(snapshot.phone, faixa)}.`,
      ),
    );
  }

  /** Lead combinou horário mas falta algo (e-mail, horário): agenda a retomada. */
  async markPending(lead: OnboardingLead, reason: 'horario' | 'email'): Promise<void> {
    const now = new Date();
    const resumeAt = new Date(now.getTime() + 24 * HOUR);
    await this.repo.update(lead.id, {
      pendingReason: reason,
      resumeSentAt: null,
      nextActionAt: resumeAt,
    });
    await this.syncDates(lead, now, resumeAt);
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
    // Reunião agendada: start = início da reunião, due = fim (1h).
    const start = new Date(meeting.startIso);
    await this.syncDates(lead, start, new Date(start.getTime() + MEETING_MS));
    await this.safe(() => this.hoppe.setStatus(lead.hoppeTaskId, HOPPE_STATUS.REUNIAO_AGENDADA));
    await this.safe(() =>
      this.hoppe.setAssignees(lead.hoppeTaskId, { add: [HOPPE_USER.TIAGO], rem: [HOPPE_USER.CLAUDE] }),
    );
    await this.safe(() =>
      this.hoppe.addComment(
        lead.hoppeTaskId,
        `Diagnóstico de IA agendado para ${fmt(new Date(meeting.startIso))} (1h) com ${meeting.attendees.join(', ')}. Meet: ${meeting.meetLink ?? 'link no convite'}.`,
      ),
    );
  }

  async noteSupport(lead: OnboardingLead, motivo: string): Promise<void> {
    await this.syncDates(lead, new Date(), null);
    await this.safe(() =>
      this.hoppe.addComment(lead.hoppeTaskId, `Demanda de suporte encaminhada à Lívia em ${fmt(new Date())}: ${motivo}. Depois do suporte, a qualificação continua.`),
    );
  }

  async optOut(lead: OnboardingLead, motivo: string): Promise<void> {
    await this.repo.update(lead.id, { state: 'OPTED_OUT', nextActionAt: null, pendingReason: null });
    await this.syncDates(lead, new Date(), null);
    await this.safe(() =>
      this.hoppe.addComment(lead.hoppeTaskId, `Lead pediu para não receber mais mensagens (${motivo}) em ${fmt(new Date())}. Contatos automáticos encerrados.`),
    );
  }

  /** Qualificação liberada pra agendar? (registrada como qualificado/aguardando_socios com faturamento) */
  isQualified(lead: OnboardingLead): boolean {
    const q = (this.snapshotOf(lead) as LeadSnapshot & { qualificacao?: { resultado?: string } }).qualificacao;
    return q?.resultado === 'qualificado' || q?.resultado === 'aguardando_socios';
  }

  // ─── helpers ───────────────────────────────────────────────

  /** Snapshot com o resultado da qualificação, que libera o agendarDiagnostico. */
  private withQualification(lead: OnboardingLead, input: QualificationInput, now: Date): Prisma.InputJsonValue {
    return {
      ...((lead.snapshot ?? {}) as Record<string, unknown>),
      qualificacao: {
        resultado: input.resultado,
        faturamento: input.faturamentoConfirmado ?? null,
        nivel: input.nivel ?? null,
        em: now.toISOString(),
      },
    } as Prisma.InputJsonValue;
  }

  private snapshotOf(lead: OnboardingLead): LeadSnapshot {
    return (lead.snapshot ?? {}) as unknown as LeadSnapshot;
  }

  private dates(lead: OnboardingLead): string[] {
    return Array.isArray(lead.attemptDates) ? (lead.attemptDates as string[]) : [];
  }

  /** Próxima checagem de retomada: 24h depois, dentro da janela de envio. */
  private followupAt(now: Date): Date {
    const { start, end } = this.config.sendWindow ?? { start: 8, end: 20 };
    return adjustToSendWindow(new Date(now.getTime() + 24 * HOUR), start, end);
  }

  /**
   * start_date = última ação, due_date = próxima ação (null = nenhuma
   * agendada). `undefined` mantém o valor atual no Hoppe.
   */
  private async syncDates(lead: OnboardingLead, start: Date | null | undefined, due: Date | null | undefined): Promise<void> {
    await this.safe(() => this.hoppe.setDates(lead.hoppeTaskId, { start, due }));
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
