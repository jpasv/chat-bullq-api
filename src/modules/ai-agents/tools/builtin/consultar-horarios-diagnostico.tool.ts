import { Injectable } from '@nestjs/common';
import { LeadOnboardingService } from '../../../lead-onboarding/lead-onboarding.service';
import { DiagnosticCalendarService } from '../../../lead-onboarding/diagnostic-calendar.service';
import { AiTool, ToolContext, ToolResult } from '../tool.types';

/** Horários livres do Diagnóstico de IA (agenda do Pedro), a partir de amanhã. */
@Injectable()
export class ConsultarHorariosDiagnosticoTool implements AiTool {
  readonly name = 'consultarHorariosDiagnostico';
  readonly description =
    'Lista horários REAIS livres para o Diagnóstico de IA com o Pedro (1h, das 9h às 20h, a partir de amanhã, horário de Brasília). Chame SEMPRE antes de oferecer horário — nunca invente. Ofereça no máximo 3 opções ao cliente usando o campo label.';
  readonly parameters = {
    type: 'object',
    additionalProperties: false,
    properties: {
      dias: {
        type: 'integer',
        minimum: 1,
        maximum: 14,
        description: 'Quantos dias à frente olhar (default 4).',
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
    const dias = Number(input.dias) > 0 ? Number(input.dias) : 4;
    const slots = await this.calendar.freeSlots(new Date(), dias, 6);
    return { output: { ok: true, slots } };
  }
}
