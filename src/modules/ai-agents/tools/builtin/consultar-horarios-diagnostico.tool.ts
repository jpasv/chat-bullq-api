import { Injectable } from '@nestjs/common';
import { LeadOnboardingService } from '../../../lead-onboarding/lead-onboarding.service';
import { DiagnosticCalendarService } from '../../../lead-onboarding/diagnostic-calendar.service';
import { AiTool, ToolContext, ToolResult } from '../tool.types';

/** Horários livres do Diagnóstico de IA (agenda do Pedro), a partir de amanhã. */
@Injectable()
export class ConsultarHorariosDiagnosticoTool implements AiTool {
  readonly name = 'consultarHorariosDiagnostico';
  readonly description =
    'Lista horários REAIS livres para o Diagnóstico de IA com o Pedro (1h, das 9h às 20h, a partir de amanhã, horário de Brasília). Chame SEMPRE antes de oferecer horário — nunca invente. Ofereça 2 opções (de preferência em dias diferentes) usando o campo label. Para outro período, passe aPartirDe.';
  readonly parameters = {
    type: 'object',
    additionalProperties: false,
    properties: {
      dias: {
        type: 'integer',
        minimum: 1,
        maximum: 14,
        description: 'Quantos dias olhar a partir do primeiro dia (default 4).',
      },
      aPartirDe: {
        type: 'string',
        description:
          'Primeiro dia a considerar, YYYY-MM-DD (horário de Brasília). Use quando o lead pedir outro período, ex.: "semana que vem" → a segunda da próxima semana. Default: amanhã.',
      },
    },
  };

  constructor(
    private readonly onboarding: LeadOnboardingService,
    private readonly calendar: DiagnosticCalendarService,
  ) {}

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const lead = await this.onboarding.findByConversation(ctx.conversationId);
    if (!lead) return { output: { ok: false, error: 'conversa_sem_lead' } };
    if (!this.onboarding.isQualified(lead)) {
      return { output: { ok: false, error: 'nao_qualificado', hint: 'Qualifique antes (faturamento confirmado, decisor) e chame registrarQualificacao = qualificado; só então ofereça horário.' } };
    }
    const dias = Number(input.dias) > 0 ? Number(input.dias) : 4;
    const aPartirDe =
      typeof input.aPartirDe === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.aPartirDe)
        ? new Date(`${input.aPartirDe}T12:00:00-03:00`)
        : undefined;
    try {
      const slots = await this.calendar.freeSlots(new Date(), dias, 6, aPartirDe);
      return { output: { ok: true, hoje: todayBrt(), slots } };
    } catch {
      return { output: { ok: false, error: 'agenda_indisponivel', hint: 'Diga que vai confirmar os horários e já volta; não invente horário.' } };
    }
  }
}

/** Data de hoje em Brasília (YYYY-MM-DD), pra o agente calcular "semana que vem". */
function todayBrt(now = new Date()): string {
  const local = new Date(now.getTime() - 3 * 3_600_000);
  const wd = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'][local.getUTCDay()];
  return `${local.toISOString().slice(0, 10)} (${wd})`;
}
