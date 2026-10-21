import { Injectable } from '@nestjs/common';
import {
  LeadOnboardingService,
  QualificationResult,
} from '../../../lead-onboarding/lead-onboarding.service';
import { AiTool, ToolContext, ToolResult } from '../tool.types';

const RESULTS: QualificationResult[] = ['qualificado', 'aguardando_socios', 'desqualificado'];
const BELOW_CUT = ['Até R$ 10.000', 'R$ 10.000 a R$ 50.000'];
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
    'Registra no Hoppe o resultado da qualificação. Só chame quando as respostas sustentarem o resultado. "qualificado" = faturamento a partir de R$ 50 mil/mês confirmado, é decisor e prioridade média ou alta (chame ANTES de convidar pro diagnóstico). "aguardando_socios" = qualificado mas os sócios ainda não confirmaram presença. "desqualificado" = faturamento confirmado abaixo de R$ 50 mil/mês, não decide e quem decide não participa, ou prioridade baixa. "qualificado" e "aguardando_socios" exigem faturamentoConfirmado (faixa que o cliente confirmou nesta conversa); sem ele o agendamento fica bloqueado.';
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
      maiorDor: { type: 'string', maxLength: 400, description: 'O que ele mais quer resolver com IA, com as palavras dele.' },
      chatOuCode: { type: 'string', enum: ['nenhum', 'só chat', 'chat e code', 'só code'], description: 'Usa IA só no chat ou também Claude Code/código.' },
      desenvolveSistemas: { type: 'string', maxLength: 200, description: 'Se já desenvolve sistema/automação própria e qual.' },
      agentes: { type: 'string', maxLength: 200, description: 'Se já tem agente rodando e o que faz.' },
      perfil: { type: 'string', enum: ['fazer por mim', 'aprender a construir', 'treinar alguém da equipe'], description: 'Se quer que alguém faça (Implementação) ou aprender/treinar alguém do time (Maestr.IA).' },
      usoIA: { type: 'string', maxLength: 300, description: 'Como usa IA hoje: ferramentas e pra quê, com as palavras do cliente (ex.: "ChatGPT pra redigir contrato").' },
      equipe: { type: 'string', maxLength: 100, description: 'Quantas pessoas trabalham na empresa, como o cliente disse (ex.: "8 pessoas").' },
      folhaMensal: { type: 'string', maxLength: 100, description: 'Média da folha salarial mensal, como o cliente disse (ex.: "uns R$ 40 mil").' },
      investimentoSoftware: { type: 'string', maxLength: 100, description: 'Quanto investe por mês em sistemas/softwares (ex.: "R$ 2 mil").' },
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
    if (resultado !== 'desqualificado') {
      if (!faixa) {
        return { output: { ok: false, error: 'falta_faturamento', hint: 'Confirme o faturamento mensal com o cliente antes de qualificar.' } };
      }
      if (BELOW_CUT.includes(faixa)) {
        return { output: { ok: false, error: 'faturamento_abaixo_do_corte', hint: 'Abaixo de R$ 50 mil/mês é desqualificado; não convide.' } };
      }
    }
    await this.onboarding.recordQualification(lead, {
      resultado,
      motivo: String(input.motivo ?? '').trim(),
      faturamentoConfirmado: faixa,
      nivel: (input.nivel as string) ?? null,
      objetivo: (input.objetivo as string) ?? null,
      prioridade: (input.prioridade as string) ?? null,
      decisor: typeof input.decisor === 'boolean' ? input.decisor : null,
      socios: Array.isArray(input.socios) ? input.socios.map(String) : null,
      usoIA: typeof input.usoIA === 'string' ? input.usoIA : null,
      perfil: typeof input.perfil === 'string' ? input.perfil : null,
      maiorDor: typeof input.maiorDor === 'string' ? input.maiorDor : null,
      chatOuCode: typeof input.chatOuCode === 'string' ? input.chatOuCode : null,
      desenvolveSistemas: typeof input.desenvolveSistemas === 'string' ? input.desenvolveSistemas : null,
      agentes: typeof input.agentes === 'string' ? input.agentes : null,
      equipe: typeof input.equipe === 'string' ? input.equipe : null,
      folhaMensal: typeof input.folhaMensal === 'string' ? input.folhaMensal : null,
      investimentoSoftware: typeof input.investimentoSoftware === 'string' ? input.investimentoSoftware : null,
    });
    return { output: { ok: true, resultado } };
  }
}
