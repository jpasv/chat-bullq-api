import { ChannelType } from '@prisma/client';

export enum MessageContentType {
  TEXT = 'TEXT',
  IMAGE = 'IMAGE',
  AUDIO = 'AUDIO',
  VIDEO = 'VIDEO',
  DOCUMENT = 'DOCUMENT',
  STICKER = 'STICKER',
  LOCATION = 'LOCATION',
  REACTION = 'REACTION',
  TEMPLATE = 'TEMPLATE',
  INTERACTIVE = 'INTERACTIVE',
  SYSTEM = 'SYSTEM',
}

export interface TemplateButton {
  type: string;
  title: string;
  url?: string;
  payload?: string;
}

export interface TemplateElement {
  title?: string;
  subtitle?: string;
  imageUrl?: string;
  defaultActionUrl?: string;
  buttons?: TemplateButton[];
}

export interface NormalizedMessageContent {
  text?: string;
  mediaUrl?: string;
  mediaId?: string;
  mimeType?: string;
  fileName?: string;
  fileSize?: number;
  caption?: string;
  latitude?: number;
  longitude?: number;
  reaction?: { emoji: string; targetMessageId: string };
  interactive?: { type: string; buttonId?: string; listRowId?: string };
  template?: {
    templateType?: string;
    text?: string;
    buttons?: TemplateButton[];
    elements?: TemplateElement[];
  };
}

/**
 * Rich reply context. On Instagram, users can reply to:
 *  - a message (`externalMessageId` is the parent mid)
 *  - a story       (`story.id` + `story.url` point to the original story)
 *  - a mention     (same shape as story, with `kind: 'mention'`)
 *  - an ad         (`ad.id` + `ad.title`)
 */
export interface ReplyContext {
  externalMessageId?: string;
  story?: { id?: string; url?: string; kind?: 'reply' | 'mention' };
  ad?: { id?: string; title?: string };
}

export interface NormalizedInboundMessage {
  externalMessageId: string;
  externalContactId: string;
  contactName?: string;
  contactPhone?: string;
  contactAvatarUrl?: string;
  channelType: ChannelType;
  timestamp: Date;
  type: MessageContentType;
  content: NormalizedMessageContent;
  replyTo?: ReplyContext;
  isForwarded?: boolean;
  isGroup?: boolean;
  isEcho?: boolean;
  senderName?: string;
  /**
   * Canais thread-based (GMAIL): id do thread no provider. Vira
   * `Conversation.externalThreadId` — 1 conversa por thread de email.
   * Canais de chat (WhatsApp/IG) deixam undefined e seguem chaveando
   * a conversa por contato.
   */
  threadExternalId?: string;
  /** Assunto do email — usado como `Conversation.subject` na criação. */
  subject?: string;
  rawPayload: unknown;
}

export interface NormalizedOutboundMessage {
  type: MessageContentType;
  content: NormalizedMessageContent;
  /**
   * Quando preenchido, sinaliza ao adapter que a msg deve ser enviada
   * como reply à mensagem `externalMessageId`.
   *
   * - Zappfy/Uazapi: vira `replyid` no payload
   * - WhatsApp Official: vira `context.message_id`
   * - Instagram: a Messenger Platform NÃO suporta reply nativo em DMs.
   *   O adapter usa o `previewText`+`senderName` pra prefixar a msg
   *   com um quote textual ("> trecho\n\ntexto") como degradação.
   */
  replyTo?: {
    externalMessageId: string;
    /** Texto curto da msg citada — usado pelo Instagram como fallback. */
    previewText?: string;
    /** Nome de quem enviou a msg citada — Instagram fallback. */
    senderName?: string;
  };
  /**
   * Contexto de threading pra canais de email (GMAIL). Preenchido pelo
   * OutboundMessageProcessor a partir da conversa + última msg inbound,
   * pra resposta sair no thread certo (`threadId` + `In-Reply-To`/
   * `References` casando com o Message-ID original). Adapters de chat
   * ignoram.
   */
  emailContext?: {
    threadId?: string;
    inReplyTo?: string;
    references?: string;
    subject?: string;
  };
}

export interface StatusUpdate {
  externalMessageId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  timestamp: Date;
  errorMessage?: string;
}

export interface WebhookParseResult {
  messages: NormalizedInboundMessage[];
  statuses: StatusUpdate[];
  errors: WebhookError[];
}

export interface WebhookError {
  code: string;
  message: string;
  rawData?: unknown;
}

export interface VerificationResponse {
  statusCode: number;
  body: string | Record<string, unknown>;
}
