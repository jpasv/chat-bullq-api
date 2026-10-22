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

/** Responsáveis: Claude conduz a abordagem; com reunião marcada passa pro Tiago (pedido de 19/10). */
export const HOPPE_USER = {
  CLAUDE: 'f16655b4-ad1c-4a12-998f-c29c319c1307',
  TIAGO: 'ea1fa1a7-1742-4153-811b-7784ef00b18e',
} as const;

export const HOPPE_STATUS_NAME_NOVA = 'nova oportunidade';

export const HOPPE_FIELD = {
  ATIVIDADE: '4227b019-f6e9-4737-b6d7-3a85d2b6fbd5',
  FATURAMENTO_MENSAL: '926f2dff-a7f5-4dc4-b4c5-1ea522b16cb5',
  /** Moeda do tipo de task Lead: valor da oferta sugerida (pedido de 22/10). */
  OPORTUNIDADE: '1e77b98a-c352-4d2b-91c8-29ac32a7ba26',
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

/** Tag do Hoppe que autoriza a abordagem pela IA. */
export const TRIGGER_TAG = 'abordar-ia';
/** Lead esperando alguém do time (aprovação pendente, bot do lead etc). */
export const HUMAN_TAG = 'aguardando-humano';
/** Retomadas automáticas de quem parou de responder na qualificação. */
export const MAX_SILENT_FOLLOWUPS = 3;

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

/**
 * Instrução que vai no "Contexto do lead" enquanto o suporte (Lívia) atende
 * uma conversa do onboarding. Sai quando ela devolve.
 */
export const SUPPORT_RETURN_NOTE =
  'Você (suporte) foi chamada para resolver uma demanda de suporte deste lead do onboarding. Resolva só o suporte. Assim que estiver resolvido (ou se o cliente mudar de assunto), chame handBackToOrchestrator: a conversa volta para o agente de onboarding continuar a qualificação.\n' +
  'Agendamento de reunião ou horário ("pode ser hoje às 14h?", "quero falar com o Tiago") NÃO é com você: chame handBackToOrchestrator na hora, sem prometer verificar agenda. Pedido de cancelamento, reembolso ou reclamação: chame transferToHuman na hora.\n' +
  'Tom: escreva como gente, curto e informal. Não repita nem resuma o que o cliente acabou de dizer. Reaja primeiro ("poxa", "ah, entendi", "boa") e só depois ajude. Nada de "identifico", "verifico", "implantação", "conforme". Sem ponto final no fim da mensagem. Pode separar em 2 mensagens deixando uma linha em branco entre elas.\n' +
  'Dúvida sobre aula (ao vivo, gravação, horário, onde assistir): mande o grupo dos alunos, onde ficam os avisos e as aulas: https://grupos-api.bravy.com.br/g/alunos-agents. Não prometa gravação.';

/** Versões anteriores da nota, que ainda podem estar gravadas em conversas abertas. */
export const LEGACY_SUPPORT_RETURN_NOTES = [
  'Você (suporte) foi chamada para resolver uma demanda de suporte deste lead do onboarding. Resolva só o suporte. Assim que estiver resolvido (ou se o cliente mudar de assunto), chame handBackToOrchestrator: a conversa volta para o agente de onboarding continuar a qualificação.\n' +
    'Tom nesta conversa (é o WhatsApp pessoal do Tiago): escreva como gente, curto e informal. Não repita nem resuma o que o cliente acabou de dizer. Reaja primeiro ("poxa", "ah, entendi", "boa") e só depois ajude. Nada de "identifico", "verifico", "implantação", "conforme". Sem ponto final no fim da mensagem. Pode separar em 2 mensagens deixando uma linha em branco entre elas.\n' +
    'Dúvida sobre aula (ao vivo, gravação, horário, onde assistir): mande o grupo dos alunos, onde ficam os avisos e as aulas: https://grupos-api.bravy.com.br/g/alunos-agents. Não prometa gravação.',
  'Você (suporte) foi chamada para resolver uma demanda de suporte deste lead do onboarding. Resolva só o suporte. Assim que estiver resolvido (ou se o cliente mudar de assunto), chame handBackToOrchestrator: a conversa volta para o agente de onboarding continuar a qualificação.\n' +
    'Tom nesta conversa (é o WhatsApp pessoal do Tiago): escreva como gente, curto e informal. Não repita nem resuma o que o cliente acabou de dizer. Reaja primeiro ("poxa", "ah, entendi", "boa") e só depois ajude. Nada de "identifico", "verifico", "implantação", "conforme". Sem ponto final no fim da mensagem. Pode separar em 2 mensagens deixando uma linha em branco entre elas.',
  'Você (suporte) foi chamada para resolver uma demanda de suporte deste lead do onboarding. Resolva só o suporte. Assim que estiver resolvido (ou se o cliente mudar de assunto), chame handBackToOrchestrator: a conversa volta para o agente de onboarding continuar a qualificação.',
];

/** Origem gravada no metadata das mensagens que o sistema manda. */
export const ATTEMPT_MESSAGE_SOURCE = 'lead_onboarding_attempt';
