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
  /** Comprou a Consultoria Individual de 90 min (já paga): agenda direto, sem qualificar. */
  consultoria?: boolean;
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
/** Corte desde 21/10: R$ 35 mil/mês. A faixa de 10 a 50 mil depende do valor. */
const NON_QUALIFYING_REVENUE = ['Até R$ 10.000'];

/**
 * Faixa do campo "Faturamento mensal" passa no corte de R$ 35 mil/mês?
 * Null = desconhecido (vazio, "Prefiro não informar", faixa fora da lista ou
 * "R$ 10.000 a R$ 50.000", que depende do valor).
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

export function revenueAbove200kMonth(faixa: string | null): boolean {
  return ['R$ 200.000 a R$ 1 milhão', 'Acima de R$ 1 milhão'].includes((faixa ?? '').trim());
}

export function firstName(name: string | null): string {
  const first = (name ?? '').trim().split(/\s+/)[0] ?? '';
  if (!first) return '';
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

/**
 * Tira o ponto final de cada linha (pedido do Tiago: ponto final no fim da
 * mensagem soa como IA no WhatsApp). Mantém reticências e pontuação interna.
 */
export function stripTrailingPeriod(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/(?<!\.)\.\s*$/, ''))
    .join('\n');
}

/**
 * Como o produto aparece na conversa. Nome de vitrine ("Gravação Masterclass
 * Vibecoding", "Claude code para iniciantes") vira "o curso"; 57 Agents fica
 * como está; vazio = sem produto (a frase se vira sem ele).
 */
export function productRef(produto: string | null): string | null {
  const p = (produto ?? '').trim();
  if (!p) return null;
  if (/^57 agents/i.test(p)) return `o ${p}`;
  return 'o curso';
}

/**
 * Copy das 3 tentativas (ajuste 41, 19/10: tom de gente, sem ponto final).
 * Cada item é uma mensagem separada no WhatsApp.
 */
export function renderAttempt(attempt: 1 | 2 | 3, lead: LeadSnapshot): string[] {
  return renderAttemptRaw(attempt, lead).map(stripTrailingPeriod);
}

function renderAttemptRaw(attempt: 1 | 2 | 3, lead: LeadSnapshot): string[] {
  const nome = lead.firstName?.trim() || '';
  const ref = productRef(lead.produto);

  if (lead.consultoria) return consultoriaAttempt(attempt, nome);
  if (attempt === 1) {
    const oi = nome ? `Oi ${nome}, tudo bem? Aqui é da Bravy` : 'Oi, tudo bem? Aqui é da Bravy';
    return [oi, openerBody(lead.progresso, ref)];
  }
  if (attempt === 2) {
    const corpo = 'conseguiu começar a usar? se travou em alguma parte, me conta que eu te ajudo';
    return [nome ? `${nome}, ${corpo}` : capitalize(corpo)];
  }
  // Última tentativa: nada de convite (só depois de qualificar, pedido de
  // 21/10). Faz a P1 da qualificação, que é fácil de responder.
  const ultima = `o que você mais queria colocar pra funcionar no escritório quando comprou ${ref ?? 'o curso'}?`;
  return [nome ? `${nome}, ${ultima}` : capitalize(ultima)];
}

/** Quem comprou a consultoria de 90 min: o assunto é marcar a consultoria. */
function consultoriaAttempt(attempt: 1 | 2 | 3, nome: string): string[] {
  if (attempt === 1) {
    return [
      nome ? `Oi ${nome}, tudo bem? Aqui é da Bravy` : 'Oi, tudo bem? Aqui é da Bravy',
      'vi que você comprou a consultoria individual de 90 min. vamos marcar? me conta o que você quer resolver primeiro que eu já preparo a conversa em cima disso',
    ];
  }
  const corpo = 'sua consultoria de 90 min tá esperando um horário. me fala o melhor dia pra você que eu encaixo';
  return [nome ? `${nome}, ${corpo}` : capitalize(corpo)];
}

function openerBody(progresso: string | null, ref: string | null): string {
  const com = ref ? ` com ${ref}` : '';
  const de = ref ? ` ${ref.replace(/^o /, 'do ')}` : '';
  switch ((progresso ?? '').trim()) {
    case 'Ainda não tive tempo de começar':
      return `vi no formulário que você ainda não tinha começado${com}, conseguiu mexer?`;
    case 'Instalei, tô implementando agora':
      return ref ? `vi que você já instalou ${ref}, como tá sendo colocar pra rodar?` : 'vi que você já instalou, como tá sendo colocar pra rodar?';
    case 'Sim, tá rodando no dia a dia':
      return ref ? `vi que ${ref} já tá rodando aí, em que ele mais tem te ajudado?` : 'vi que já tá rodando aí, em que mais tem te ajudado?';
    case 'Tive dificuldade técnica e parei':
      return `vi que você travou em alguma parte${de}, conseguiu resolver?`;
    default:
      return ref ? `vi que você pegou ${ref}, conseguiu começar?` : 'vi que você começou com a gente, conseguiu mexer?';
  }
}

/** Retomada única quando o lead parou no meio do agendamento (spec, seção 8). */
const AUTO_REPLY_PATTERNS = [
  /agradece (o )?(seu )?contato/i,
  /obrigad[oa] (pelo|por entrar em) contato/i,
  /em breve (irei|vou|retornarei|retornaremos|responderemos|daremos)/i,
  /(mensagem|resposta) autom[aá]tica/i,
  /fora do (nosso )?hor[aá]rio/i,
  /no momento n[aã]o (posso|estou|podemos)/i,
  /sou (o|a) assistente/i,
  /assistente virtual/i,
  /preencha o formul[aá]rio|preenche o formul[aá]rio/i,
];

/**
 * A mensagem do lead parece resposta automática do WhatsApp Business dele?
 * Chegou segundos depois da nossa tentativa, ou tem frase típica de
 * saudação/ausência e veio logo depois (até 10 min).
 */
export function isLikelyAutoReply(text: string | null, lastAttemptAt: Date | null, now: Date): boolean {
  if (!lastAttemptAt) return false;
  const elapsed = now.getTime() - lastAttemptAt.getTime();
  if (elapsed < 0) return false;
  if (elapsed <= 15_000) return true;
  if (elapsed > 10 * 60_000) return false;
  const t = text ?? '';
  return AUTO_REPLY_PATTERNS.some((re) => re.test(t));
}

/**
 * Retomada de quem parou de responder no meio da qualificação (1ª e 2ª).
 * Curta e sem repetir a pergunta: o agente retoma o ponto quando o lead voltar.
 */
export function renderSilentFollowup(n: 1 | 2 | 3, lead: LeadSnapshot, objetivo?: string | null): string | string[] {
  const nome = lead.firstName?.trim() ?? '';
  const pre = nome ? `${nome}, ` : '';
  const obj = (objetivo ?? '').trim();
  if (n === 1) return capitalize(`${pre}conseguiu ver minha última mensagem?`);
  if (n === 2) {
    return obj
      ? capitalize(`${pre}você comentou que queria ${obj}. pra seguir por esse caminho só falta aquela resposta, consegue me contar?`)
      : capitalize(`${pre}ainda faz sentido a gente seguir com isso? me conta que eu continuo daqui`);
  }
  return capitalize(`${pre}quer continuar essa conversa${obj ? ` sobre ${obj}` : ''}? se agora não for um bom momento, me chama quando quiser retomar`);
}

/** Retomada na data que o próprio lead pediu ("me chama semana que vem"). */
export function renderReturnOnDate(lead: LeadSnapshot, assunto?: string | null): string {
  const nome = lead.firstName?.trim();
  const sobre = (assunto ?? '').trim();
  return capitalize(`${nome ? `${nome}, ` : ''}como combinamos, tô passando pra gente retomar${sobre ? ` ${sobre}` : ''}. faz sentido seguir agora?`);
}

/** Retomada de quem ficou parado com o suporte: checa se resolveu, o agente segue pro convite. */
export function renderAfterSupport(lead: LeadSnapshot): string {
  const nome = lead.firstName?.trim();
  return capitalize(`${nome ? `${nome}, ` : ''}deu certo por aí depois daquilo?`);
}

export function renderResume(
  reason: string,
  lead: LeadSnapshot,
  socio?: string | null,
): string | null {
  const nome = lead.firstName?.trim();
  const pre = nome ? `${nome}, ` : '';
  const msg = renderResumeRaw(reason, pre, socio);
  return msg ? stripTrailingPeriod(msg) : null;
}

function renderResumeRaw(reason: string, pre: string, socio?: string | null): string | null {
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

/** Valor de custom field do Hoppe como texto (LABEL vem como array). */
function fieldText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) {
    const items = v.map((x) => (typeof x === 'string' ? x : (x as any)?.name ?? '')).filter(Boolean);
    return items.length ? items.join(', ') : null;
  }
  const s = String(v).trim();
  return s || null;
}

/** Snapshot da task (campos indexados por nome, como o HoppeLeadsClient devolve). */
export function snapshotFromTask(task: {
  name: string;
  fields: Record<string, unknown>;
}): LeadSnapshot {
  const f = task.fields;
  const produtos = Array.isArray(f['Produtos'])
    ? (f['Produtos'] as unknown[]).map((x) => (typeof x === 'string' ? x : (x as any)?.name)).filter(Boolean)
    : [];
  // O 1º produto que não é aula de boas-vindas/instalação é o que ele comprou.
  const produto =
    produtos.find((p) => !/boas-vindas|como baixar/i.test(String(p))) ??
    produtos[0] ??
    null;
  return {
    name: task.name || null,
    firstName: firstName(task.name),
    phone: normalizePhone(fieldText(f['WhatsApp'])),
    email: fieldText(f['Email']),
    produto: produto ? String(produto).trim() : null,
    progresso: fieldText(f['Progresso com o produto']),
    atuacao: fieldText(f['Atuação']),
    equipe: fieldText(f['Tamanho da equipe']),
    faturamento: fieldText(f['Faturamento mensal']),
    estado: fieldText(f['Estado']),
    gargalo: fieldText(f['Gargalo']),
    meta: fieldText(f['Meta 12 meses']),
  };
}

/** Só dígitos, com DDI 55 quando vier sem (10-11 dígitos nacionais). */
export function normalizePhone(raw: string | null): string | null {
  const d = (raw ?? '').replace(/\D/g, '');
  if (!d) return null;
  if (d.length === 10 || d.length === 11) return `55${d}`;
  return d;
}

/**
 * Bloco "Contexto do lead" que entra no prompt do agente (via
 * conversation.metadata.promptContext). Só dados do formulário + estado.
 */
export function buildPromptContext(lead: LeadSnapshot, extra: { attempt: number; state: string }): string {
  const lines = [
    `Lead do Hoppe (list Leads onboarding). Comprou: ${lead.produto ?? 'não informado'}.`,
    `Nome: ${lead.name ?? 'não informado'}`,
    `WhatsApp: ${lead.phone ?? 'não informado'}`,
    `E-mail do formulário: ${lead.email ?? 'não informado'}`,
    `Progresso com o produto (formulário): ${lead.progresso ?? 'não informado'}`,
    `Atuação: ${lead.atuacao ?? 'não informado'}`,
    `Tamanho da equipe: ${lead.equipe ?? 'não informado'}`,
    `Faturamento mensal (formulário): ${lead.faturamento ?? 'não informado'}`,
    `Estado: ${lead.estado ?? 'não informado'}`,
    `Gargalo (formulário): ${lead.gargalo ?? 'não informado'}`,
    `Meta 12 meses (formulário): ${lead.meta ?? 'não informado'}`,
    `Tentativas de abordagem já enviadas: ${extra.attempt}. Estado no fluxo: ${extra.state}.`,
  ];
  if (!lead.progresso && !lead.faturamento && !lead.atuacao) {
    lines.push(
      'SEM FORMULÁRIO: este comprador não preencheu o formulário de onboarding. Descubra o nível de maturidade dele ao longo da conversa (já usa IA ou Claude Code no dia a dia? o que faz e pra quem? tamanho da equipe? faturamento), uma coisa por vez e sem virar questionário, e siga pro convite.',
    );
  }
  if (lead.consultoria) {
    lines.push(
      'COMPROU A CONSULTORIA INDIVIDUAL de 90 min (já paga): NÃO qualifique, NÃO fale de diagnóstico gratuito nem de faturamento. Descubra em uma pergunta o que ele quer resolver primeiro e marque a consultoria com o Tiago: consultarHorariosDiagnostico e agendarDiagnostico (o sistema já reserva 90 min e chama de Consultoria Individual). Peça o e-mail do convite.',
    );
  }
  if (revenueAbove200kMonth(lead.faturamento)) {
    lines.push('PRIORIDADE ALTA (faturamento de R$ 200 mil/mês pra cima no formulário): qualifique sem enrolar e convide assim que confirmar.');
  }
  return lines.join('\n');
}

/**
 * Espera antes da IA responder no onboarding (30-45s, aleatório). Resposta
 * instantânea no WhatsApp pessoal do Tiago denuncia robô (pedido de 18/10).
 */
export function onboardingReplyDelayMs(random: () => number = Math.random): number {
  return Math.round(30_000 + random() * 15_000);
}

const ACK_WORDS = new Set([
  'ok', 'okay', 'okey', 'blz', 'beleza', 'valeu', 'vlw', 'obrigado', 'obrigada', 'brigado', 'brigada', 'obg',
  'show', 'top', 'tranquilo', 'certo', 'combinado', 'fechado', 'perfeito', 'joia', 'jóia', 'massa', 'entendi',
  'tá', 'ta', 'bom', 'pode', 'deixar', 'boa', 'legal', 'muito', 'e', '👍', '🙏', '👌',
]);

/**
 * "ok", "blz", "valeu"... encerram o turno do lead: ninguém deve resposta.
 * Sem isso a retomada de 24h nunca saía pra quem fechava a conversa assim.
 */
export function isAcknowledgement(text: string | null | undefined): boolean {
  const t = (text ?? '').trim().toLowerCase();
  if (!t || t.length > 30) return false;
  const words = t.split(/[\s,.!…]+/u).filter(Boolean);
  return words.length > 0 && words.every((w) => ACK_WORDS.has(w));
}

/**
 * Nota no contexto do agente quando a abordagem saiu pela API oficial: o
 * histórico mostra só "[template]", então o agente precisa saber o que foi dito.
 */
export const OFFICIAL_OUTREACH_NOTE = `

Abordagem pela API oficial da Bravy (não é o WhatsApp do Tiago): as tentativas saíram como template e no histórico aparecem como [template].
- Abertura: "Oi {nome}, aqui é da Bravy. Vi que você adquiriu o {produto}. Conseguiu começar? Se travou em alguma parte, me responde aqui que eu te ajudo."
- Lembrete: "Oi {nome}, conseguiu dar uma olhada no {produto}? Se travou em alguma coisa, me responde aqui que eu te ajudo."
- Última: "Oi {nome}, como cliente do {produto} você tem direito a um diagnóstico de 1h com o Tiago, sem custo, pra ver o que automatizar primeiro. Quer que eu separe um horário? É só responder aqui."
- Retomada: "Oi {nome}, conseguiu ver minha última mensagem sobre o {produto}? Quando puder, me responde aqui."`;
