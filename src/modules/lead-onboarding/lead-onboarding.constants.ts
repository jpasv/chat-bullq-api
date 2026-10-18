/** Job repeat que executa as ações vencidas dos leads (tentativas, inativação, resumo). */
export const ONBOARDING_TICK_QUEUE = 'lead-onboarding-tick';
export const ONBOARDING_TICK_JOB = 'tick';

/** List "Leads onboarding" (Comercial > Onboarding Members) do Hoppe. */
export const HOPPE_LEADS_LIST_ID = '8c1d6462-7541-4c2e-8a5e-020b3b635459';

export const HOPPE_STATUS = {
  NOVA_OPORTUNIDADE: 'd3d79a52-98a2-41fa-9dea-e011f660dca3',
  EM_QUALIFICACAO: 'dbff0b45-5fae-499d-b86d-7b8bccf43f1d',
  REUNIAO_AGENDADA: '74fb723e-ccc0-49e0-8c02-33d4e2d86405',
  DESQUALIFICADO: 'f673a940-cde4-4dde-be1d-1544c08f786f',
} as const;

export const HOPPE_STATUS_NAME_NOVA = 'nova oportunidade';

export const HOPPE_FIELD = {
  ATIVIDADE: '4227b019-f6e9-4737-b6d7-3a85d2b6fbd5',
  FATURAMENTO_MENSAL: '926f2dff-a7f5-4dc4-b4c5-1ea522b16cb5',
} as const;

/** Nome dos campos como vêm na task (o client indexa por nome). */
export const HOPPE_FIELD_NAMES = {
  WHATSAPP: 'WhatsApp',
  EMAIL: 'Email',
  ESTADO: 'Estado',
  ATUACAO: 'Atuação',
  EQUIPE: 'Tamanho da equipe',
  PROGRESSO: 'Progresso com o produto',
  FATURAMENTO: 'Faturamento mensal',
  GARGALO: 'Gargalo',
  META: 'Meta 12 meses',
  PRODUTOS: 'Produtos',
} as const;

export const ATIVIDADE = { ATIVO: 'Ativo', INATIVO: 'Inativo' } as const;

/** Tags de tentativa já existentes no space Comercial. */
export const ATTEMPT_TAGS: Record<1 | 2 | 3, string> = {
  1: '1º mensagem',
  2: '2º mensagem',
  3: '3º mensagem',
};

export type OnboardingState =
  | 'PENDING'
  | 'CONTACTED'
  | 'REPLIED'
  | 'INACTIVE'
  | 'SCHEDULED'
  | 'DISQUALIFIED'
  | 'OPTED_OUT'
  | 'PAUSED'
  | 'SKIPPED';

/** Origem gravada no metadata das mensagens que o sistema manda. */
export const ATTEMPT_MESSAGE_SOURCE = 'lead_onboarding_attempt';
