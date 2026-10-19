import { Injectable } from '@nestjs/common';
import {
  LeadOnboardingService,
  QualificationResult,
} from '../../../lead-onboarding/lead-onboarding.service';
import { AiTool, ToolContext, ToolResult } from '../tool.types';

const RESULTS: QualificationResult[] = ['qualificado', 'aguardando_socios', 'desqualificado'];
const FAIXAS = [
  'Até R$ 10.000',
  'R$ 10.000 a R$ 50.000',
  'R$ 50.000 a R$ 200.000',
  'R$ 200.000 a R$ 1 milhão',
  'Acima de R$ 1 milhão',
];

/** Registra o resultado da qualificação na task do Hoppe (status + comentário). */
@Injectable()
export class RegistrarQualificacaoTool implements AiTool {
  readonly name = 'registrarQualificacao';
  readonly description =
    'Registra no Hoppe o resultado da qualificação. Só chame quando as respostas sustentarem o resultado. "qualificado" = faturamento a partir de R$ 50 mil/mês confirmado, é decisor e prioridade média ou alta (chame ANTES de convidar pro diagnóstico). "aguardando_socios" = qualificado mas os sócios ainda não confirmaram presença. "desqualificado" = faturamento confirmado abaixo de R$ 50 mil/mês, não decide e quem decide não participa, ou prioridade baixa. Faturamento desconhecido NÃO é desqualificação.';
  readonly parameters = {
    type: 'object',
    additionalProperties: false,
    required: ['resultado', 'motivo'],
    properties: {
      resultado: { type: 'string', enum: RESULTS },
      motivo: { type: 'string', minLength: 3, maxLength: 400, description: 'Por que esse resultado, em uma frase.' },
      faturamentoConfirmado: {
        type: 'string',
        enum: FAIXAS,
        description: 'Faixa mensal confirmada pelo cliente na conversa (grava no Hoppe).',
      },
      nivel: { type: 'string', maxLength: 200 },
      objetivo: { type: 'string', maxLength: 400 },
      prioridade: { type: 'string', enum: ['baixa', 'media', 'alta'] },
      decisor: { type: 'boolean' },
      socios: { type: 'array', items: { type: 'string' }, maxItems: 8, description: 'Nomes dos sócios.' },
    },
  };

  constructor(private readonly onboarding: LeadOnboardingService) {}

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const lead = await this.onboarding.findByConversation(ctx.conversationId);
    if (!lead) return { output: { ok: false, error: 'conversa_sem_lead' } };
    const resultado = String(input.resultado ?? '') as QualificationResult;
    if (!RESULTS.includes(resultado)) {
      return { output: { ok: false, error: 'resultado_invalido', allowed: RESULTS } };
    }
    const faixa = typeof input.faturamentoConfirmado === 'string' && FAIXAS.includes(input.faturamentoConfirmado)
      ? input.faturamentoConfirmado
      : null;
    await this.onboarding.recordQualification(lead, {
      resultado,
      motivo: String(input.motivo ?? '').trim(),
      faturamentoConfirmado: faixa,
      nivel: (input.nivel as string) ?? null,
      objetivo: (input.objetivo as string) ?? null,
      prioridade: (input.prioridade as string) ?? null,
      decisor: typeof input.decisor === 'boolean' ? input.decisor : null,
      socios: Array.isArray(input.socios) ? input.socios.map(String) : null,
    });
    return { output: { ok: true, resultado } };
  }
}
