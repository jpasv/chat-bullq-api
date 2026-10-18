/**
 * Regras puras do onboarding pós-venda: janela de envio, cadência, corte de
 * faturamento e copy das tentativas. Sem I/O — tudo aqui é testável direto.
 * A copy é literal do spec (docs/superpowers/specs/2026-10-18-lead-onboarding-ia-design.md).
 */

/** Dados da task do Hoppe que importam pra abordagem e pro prompt. */
export interface LeadSnapshot {
  name: string | null;
  firstName: string;
  phone: string | null;
  email: string | null;
  produto: string | null;
  progresso: string | null;
  atuacao: string | null;
  equipe: string | null;
  faturamento: string | null;
  estado: string | null;
  gargalo: string | null;
  meta: string | null;
}

const TZ_OFFSET_HOURS = -3; // America/Sao_Paulo, sem horário de verão desde 2019

/** Hora local de Brasília (0-23) de um instante. */
function brtHour(at: Date): number {
  return (at.getUTCHours() + 24 + TZ_OFFSET_HOURS) % 24;
}

/** Instante de `hour`:00 de Brasília no mesmo dia local de `at` (+ dayOffset). */
function brtAt(at: Date, hour: number, dayOffset = 0): Date {
  const local = new Date(at.getTime() + TZ_OFFSET_HOURS * 3_600_000);
  const d = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate() + dayOffset,
    hour - TZ_OFFSET_HOURS,
  );
  return new Date(d);
}

/**
 * Empurra um envio pra dentro da janela [startHour, endHour) de Brasília.
 * Antes da janela → startHour do mesmo dia; depois → startHour do dia seguinte.
 */
export function adjustToSendWindow(at: Date, startHour = 8, endHour = 20): Date {
  const h = brtHour(at);
  if (h < startHour) return brtAt(at, startHour);
  if (h >= endHour) return brtAt(at, startHour, 1);
  return at;
}

/**
 * Horas até a próxima ação depois da tentativa `attempt` (1-based). A última
 * entrada da cadência é a espera antes de inativar. Null = acabou.
 */
export function nextAttemptDelayHours(
  attempt: number,
  cadence: number[],
): number | null {
  return cadence[attempt - 1] ?? null;
}

/** Rio = DDD 21 (decisão do Tiago, 18/10). */
export function isRio(phone: string | null): boolean {
  const digits = (phone ?? '').replace(/\D/g, '');
  const national = digits.startsWith('55') ? digits.slice(2) : digits;
  return national.startsWith('21');
}

const QUALIFYING_REVENUE = [
  'R$ 50.000 a R$ 200.000',
  'R$ 200.000 a R$ 1 milhão',
  'Acima de R$ 1 milhão',
];
const NON_QUALIFYING_REVENUE = ['Até R$ 10.000', 'R$ 10.000 a R$ 50.000'];

/**
 * Faixa do campo "Faturamento mensal" passa no corte de R$ 50 mil/mês?
 * Null = desconhecido (vazio, "Prefiro não informar" ou faixa fora da lista).
 */
export function revenueQualifies(faixa: string | null): boolean | null {
  const f = (faixa ?? '').trim();
  if (QUALIFYING_REVENUE.includes(f)) return true;
  if (NON_QUALIFYING_REVENUE.includes(f)) return false;
  return null;
}

/** Faixas mensais cujo piso anualizado passa de R$ 500 mil (corte da oferta). */
export function revenueAbove500kYear(faixa: string | null): boolean {
  const f = (faixa ?? '').trim();
  return f === 'R$ 200.000 a R$ 1 milhão' || f === 'Acima de R$ 1 milhão';
}

export function firstName(name: string | null): string {
  const first = (name ?? '').trim().split(/\s+/)[0] ?? '';
  if (!first) return '';
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

const OPENING = 'Sou o assistente virtual do Tiago, aqui da Bravy.';

/** Copy literal das 3 tentativas (spec, seções 1 e 8). */
export function renderAttempt(attempt: 1 | 2 | 3, lead: LeadSnapshot): string {
  const nome = lead.firstName?.trim() || '';
  const produto = lead.produto?.trim() || 'o produto';
  const oProduto = lead.produto?.trim() ? `o ${produto}` : produto;

  if (attempt === 1) {
    const oi = nome ? `Oi, ${nome}!` : 'Oi!';
    const corpo = openerBody(lead.progresso, oProduto);
    return `${oi} ${OPENING} ${corpo}`;
  }
  if (attempt === 2) {
    const pergunta = `ficou alguma dúvida para começar a usar ${oProduto}? Pode me contar por aqui.`;
    return nome ? `${nome}, ${pergunta}` : capitalize(pergunta);
  }
  const encerra = nome
    ? `Vou encerrar esse acompanhamento por aqui, ${nome}.`
    : 'Vou encerrar esse acompanhamento por aqui.';
  return `${encerra} Se precisar de ajuda com ${oProduto}, pode escrever neste número.`;
}

function openerBody(progresso: string | null, oProduto: string): string {
  switch ((progresso ?? '').trim()) {
    case 'Ainda não tive tempo de começar':
      return `Você comentou no formulário que ainda não tinha começado com ${oProduto}. Conseguiu olhar desde então?`;
    case 'Instalei, tô implementando agora':
      return `Como foi colocar ${oProduto} pra funcionar depois da instalação?`;
    case 'Sim, tá rodando no dia a dia':
      return `Em qual tarefa você está usando mais ${oProduto}?`;
    case 'Tive dificuldade técnica e parei':
      return `Você comentou que teve uma dificuldade com ${oProduto}. Conseguiu resolver?`;
    default:
      return `Você conseguiu começar a usar ${oProduto} ou ficou alguma dúvida?`;
  }
}

/** Retomada única quando o lead parou no meio do agendamento (spec, seção 8). */
export function renderResume(
  reason: string,
  lead: LeadSnapshot,
  socio?: string | null,
): string | null {
  const nome = lead.firstName?.trim();
  const pre = nome ? `${nome}, ` : '';
  switch (reason) {
    case 'socios':
      return socio
        ? `${pre}conseguiu combinar com ${socio} a participação no diagnóstico?`
        : capitalize(`${pre}conseguiu combinar com seu sócio a participação no diagnóstico?`);
    case 'horario':
      return capitalize(`${pre}ainda quer combinar o horário do diagnóstico?`);
    case 'email':
      return 'Para concluir o agendamento, ficou faltando o e-mail do convite. Ainda quer marcar?';
    default:
      return null;
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
