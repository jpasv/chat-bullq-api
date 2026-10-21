import { Injectable } from '@nestjs/common';
import { LeadOnboardingService } from '../../../lead-onboarding/lead-onboarding.service';
import { AiTool, ToolContext, ToolResult } from '../tool.types';

/** Lead pediu pra ser chamado depois ("me chama semana que vem", "dia 5"): a retomada sai nessa data. */
@Injectable()
export class AgendarRetomadaTool implements AiTool {
  readonly name = 'agendarRetomada';
  readonly description =
    'Use quando o cliente pedir pra ser chamado numa data ("me chama semana que vem", "volto de viagem dia 5", "fala comigo segunda"). Grava a data e a conversa é retomada nela automaticamente. Depois responda curto, combinando ("combinado, te chamo {dia}"). Calcule a data a partir da data de hoje no contexto.';
  readonly parameters = {
    type: 'object',
    additionalProperties: false,
    required: ['data'],
    properties: {
      data: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Data da retomada (AAAA-MM-DD), horário de Brasília.' },
      hora: { type: 'string', pattern: '^\\d{2}:\\d{2}$', description: 'Hora, se ele disse (HH:MM). Sem hora, 10h.' },
      assunto: { type: 'string', maxLength: 120, description: 'Do que retomar, curto (ex.: "o horário do diagnóstico").' },
    },
  };

  constructor(private readonly onboarding: LeadOnboardingService) {}

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const lead = await this.onboarding.findByConversation(ctx.conversationId);
    if (!lead) return { output: { ok: false, error: 'conversa_sem_lead' } };
    const data = String(input.data ?? '');
    const hora = typeof input.hora === 'string' && /^\d{2}:\d{2}$/.test(input.hora) ? input.hora : '10:00';
    const at = new Date(`${data}T${hora}:00-03:00`);
    if (Number.isNaN(at.getTime()) || at.getTime() < Date.now()) {
      return { output: { ok: false, error: 'data_invalida', hint: 'Use uma data futura no formato AAAA-MM-DD.' } };
    }
    const when = await this.onboarding.scheduleReturn(lead, at, typeof input.assunto === 'string' ? input.assunto.trim() : null);
    return { output: { ok: true, retomadaEm: when.toISOString() } };
  }
}
