export const IG_FLOWS_QUEUE = 'ig-flows';

export type IgFlowTriggerType = 'COMMENT' | 'STORY_REPLY';

export interface IgFlowTriggerConfig {
  /** Posts/reels específicos; vazio = qualquer post. Só COMMENT. */
  mediaIds?: string[];
  /** Palavras-chave; vazio = qualquer texto. Comparação sem acento/caixa. */
  keywords?: string[];
  match?: 'contains' | 'exact';
  /** Respostas públicas no comentário (sorteia uma). Só COMMENT. */
  publicReplies?: string[];
  /** Default true: a mesma pessoa só entra uma vez no fluxo. */
  oncePerContact?: boolean;
}

export interface IgFlowButton {
  id: string;
  title: string;
  type: 'url' | 'postback';
  /** Obrigatório em `url`. O clique passa pelo nosso redirect pra seguir `next`. */
  url?: string;
  next?: string;
}

export interface IgFlowMessageNode {
  id: string;
  type: 'message';
  text: string;
  buttons?: IgFlowButton[];
  next?: string;
}

export interface IgFlowConditionNode {
  id: string;
  type: 'condition';
  check: 'follows';
  onTrue?: string;
  onFalse?: string;
}

export interface IgFlowHttpNode {
  id: string;
  type: 'http';
  url: string;
  method?: 'POST' | 'GET';
  headers?: Record<string, string>;
  /** Corpo customizado; strings aceitam {{username}}, {{igsid}}, {{comment}}. Sem body = payload padrão. */
  body?: Record<string, unknown>;
  next?: string;
}

export interface IgFlowDelayNode {
  id: string;
  type: 'delay';
  seconds?: number;
  /** ISO com fuso, ex. 2026-10-23T19:55:00-03:00 */
  until?: string;
  /** Todo dia nesse horário (HH:mm, Brasília). Mensagens aceitam {{dia_aula}} = "hoje"/"amanhã". */
  dailyAt?: string;
  /** Com dailyAt: até quantos minutos depois do horário ainda dispara na hora. */
  graceMinutes?: number;
  next?: string;
}

export type IgFlowNode =
  | IgFlowMessageNode
  | IgFlowConditionNode
  | IgFlowHttpNode
  | IgFlowDelayNode;

export type IgFlowRunStatus =
  | 'RUNNING'
  | 'WAITING'
  | 'WAITING_INTERACTION'
  | 'DONE'
  | 'FAILED';

export interface IgFlowStartCommentJob {
  channelId: string;
  organizationId: string;
  commentExternalId: string;
  parentExternalId?: string | null;
  mediaId: string;
  authorExternalId: string;
  authorUsername?: string | null;
  text: string;
}

export interface IgFlowStartStoryJob {
  channelId: string;
  organizationId: string;
  contactExternalId: string;
  text: string;
  messageExternalId: string;
}

export interface IgFlowPostbackJob {
  channelId: string;
  contactExternalId: string;
  payload: string;
}

export interface IgFlowResumeJob {
  runId: string;
  nodeId: string;
  /** true quando veio de clique/mensagem da pessoa (abre janela de 24h) */
  interaction?: boolean;
}

export interface IgFlowInteractionJob {
  channelId: string;
  contactExternalId: string;
}

/** Payload de postback dos nossos botões: IGF:<runId>:<buttonId> */
export const POSTBACK_PREFIX = 'IGF:';
