import { Injectable, Logger } from '@nestjs/common';
import { LeadOnboardingService } from '../../../lead-onboarding/lead-onboarding.service';
import {
  DiagnosticCalendarService,
  SlotTakenError,
} from '../../../lead-onboarding/diagnostic-calendar.service';
import { LeadOnboardingConfigService } from '../../../lead-onboarding/lead-onboarding-config.service';
import { AiTool, ToolContext, ToolResult } from '../tool.types';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Cria o Diagnóstico de IA REAL na agenda do Tiago (Meet + convite por
 * e-mail) e move a task do Hoppe pra "reunião agendada". Autônoma: a
 * descrição exige confirmação por escrito do cliente antes da chamada.
 * O convite NUNCA leva dado comercial (faturamento, oferta) — isso fica no Hoppe.
 */
@Injectable()
export class AgendarDiagnosticoTool implements AiTool {
  private readonly logger = new Logger(AgendarDiagnosticoTool.name);

  readonly name = 'agendarDiagnostico';
  readonly description =
    'Agenda o Diagnóstico de IA REAL (1h, videochamada com o Tiago) e envia o convite por e-mail. Exige registrarQualificacao = qualificado antes. SÓ CHAME depois que o cliente confirmou POR ESCRITO data, horário e participantes, e que todos os sócios/decisores vão participar. Use um inicioIso devolvido por consultarHorariosDiagnostico. Se voltar horario_ocupado, consulte de novo e ofereça outras opções. Nunca diga que agendou antes de receber ok=true.';
  readonly parameters = {
    type: 'object',
    additionalProperties: false,
    required: ['inicioIso', 'emails', 'participantes'],
    properties: {
      inicioIso: {
        type: 'string',
        description: 'Início confirmado, exatamente como veio em consultarHorariosDiagnostico (ISO 8601).',
      },
      emails: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: 8,
        description: 'E-mails do cliente e dos sócios que recebem o convite. O Tiago entra automaticamente.',
      },
      participantes: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: 8,
        description: 'Nomes de quem participa do lado do cliente (ele e os sócios).',
      },
    },
  };

  constructor(
    private readonly onboarding: LeadOnboardingService,
    private readonly calendar: DiagnosticCalendarService,
    private readonly config: LeadOnboardingConfigService,
  ) {}

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const lead = await this.onboarding.findByConversation(ctx.conversationId);
    if (!lead) return { output: { ok: false, error: 'conversa_sem_lead' } };
    if (lead.meetingEventId || lead.state === 'SCHEDULED') {
      return { output: { ok: false, error: 'ja_agendado', hint: 'Já existe diagnóstico marcado. Para remarcar, transfira pro humano.' } };
    }

    if (!this.onboarding.isQualified(lead)) {
      return { output: { ok: false, error: 'nao_qualificado', hint: 'Termine a qualificação (faturamento confirmado, decisor) e chame registrarQualificacao = qualificado antes de agendar.' } };
    }

    const inicioIso = String(input.inicioIso ?? '');
    const start = new Date(inicioIso);
    if (Number.isNaN(start.getTime()) || start.getTime() < Date.now()) {
      return { output: { ok: false, error: 'inicio_invalido', hint: 'Use um horário futuro de consultarHorariosDiagnostico.' } };
    }
    const emails = (Array.isArray(input.emails) ? input.emails : [])
      .map((e) => String(e).trim().toLowerCase())
      .filter((e) => EMAIL_RE.test(e));
    if (emails.length === 0) return { output: { ok: false, error: 'email_invalido' } };
    const participantes = (Array.isArray(input.participantes) ? input.participantes : [])
      .map((p) => String(p).trim())
      .filter(Boolean);

    const snapshot = (lead.snapshot ?? {}) as Record<string, any>;
    const nome = snapshot.name || snapshot.firstName || participantes[0] || 'cliente';
    const attendees = [...new Set([...emails, this.config.closerEmail, ...(this.config.extraAttendees ?? [])])];

    try {
      const ev = await this.calendar.create({
        startIso: start.toISOString(),
        attendees,
        title: `Diagnóstico de IA – ${nome}`,
        description: [
          'Diagnóstico de IA para sua Operação, gratuito, com o Tiago (Bravy).',
          'Objetivo: entender a rotina da empresa, identificar onde a IA pode ajudar e o que priorizar. A implementação não está incluída.',
          `Participantes: ${participantes.join(', ') || nome}.`,
        ].join('\n\n'),
      });
      await this.onboarding.recordScheduled(lead, {
        eventId: ev.eventId,
        startIso: start.toISOString(),
        attendees: participantes.length ? participantes : emails,
        meetLink: ev.meetLink,
      });
      return { output: { ok: true, meetLink: ev.meetLink, inicioIso: start.toISOString() } };
    } catch (err) {
      if (err instanceof SlotTakenError) return { output: { ok: false, error: 'horario_ocupado' } };
      this.logger.error(`agendarDiagnostico falhou: ${(err as Error).message}`);
      return { output: { ok: false, error: 'falha_ao_agendar', hint: 'Diga que o agendamento ainda não foi concluído e transfira pro humano.' } };
    }
  }
}
