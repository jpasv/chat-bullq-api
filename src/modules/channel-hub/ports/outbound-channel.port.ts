import { ChannelType, Channel } from '@prisma/client';
import { NormalizedOutboundMessage, SendResult, RateLimitConfig } from './types';

export interface ResolveMediaHint {
  externalMessageId: string;
  mediaId?: string;
  mimeType?: string;
  originalFilename?: string;
}

export interface OutboundChannelPort {
  readonly channelType: ChannelType;

  sendMessage(
    channel: Channel,
    contactExternalId: string,
    message: NormalizedOutboundMessage,
  ): Promise<SendResult>;

  sendTypingIndicator(
    channel: Channel,
    contactExternalId: string,
  ): Promise<void>;

  getMediaUrl(channel: Channel, mediaId: string): Promise<string>;

  downloadMedia(channel: Channel, mediaId: string): Promise<Buffer>;

  /**
   * Resolve an inbound message's media to a playable URL.
   *
   * Needed for channels like WhatsApp (Zappfy/Uazapi) where the webhook
   * delivers an encrypted .enc CDN URL that browsers cannot play, and for
   * Meta Cloud where the URL requires a Bearer token and must be re-hosted.
   * Channels where the webhook already carries a playable URL (Instagram)
   * can just echo the stored one.
   *
   * `hint` carries everything the media-resolver pulled off the stored
   * message — adapters use whichever fields are relevant: Uazapi only
   * needs externalMessageId, Meta Cloud needs mediaId, etc.
   */
  resolveInboundMediaUrl?(
    channel: Channel,
    hint: ResolveMediaHint,
  ): Promise<{ fileUrl: string; mimeType?: string }>;

  /**
   * Delete a previously-sent outbound message FOR EVERYONE on the provider.
   * Reach varies by channel:
   *   - Zappfy/Uazapi  : supported via `/message/delete` — deleted on the
   *     customer's WhatsApp app too.
   *   - WhatsApp Cloud : NOT supported — Meta's API has no delete endpoint
   *     for messages. Adapter throws so the caller can fall back to local-
   *     only soft-delete.
   *   - Instagram      : NOT supported — same as Meta WA.
   *
   * Optional on purpose: callers must check `typeof adapter.deleteMessage
   * === 'function'` and translate to a 400 if absent.
   */
  deleteMessage?(
    channel: Channel,
    externalMessageId: string,
    contactExternalId?: string,
  ): Promise<void>;

  /**
   * Espelha "conversa lida" no provider — sync bidirecional de leitura.
   * GMAIL: remove o label UNREAD das mensagens na caixa, pra quem abrir o
   * Gmail ver o mesmo estado do inbox. Recebe os externalIds das mensagens
   * inbound recentes da conversa.
   *
   * Opcional como o deleteMessage: canais de chat não implementam e o
   * caller checa `typeof adapter.markConversationRead === 'function'`.
   */
  markConversationRead?(
    channel: Channel,
    externalMessageIds: string[],
  ): Promise<void>;

  /**
   * Avisa o provider que a conversa foi encerrada no chat-bullq.
   * MEMBERS: dispara o callback `conversation_closed` (o membro volta pro
   * bot). Chamado SEMPRE de forma assíncrona (job na fila
   * `outbound-messages`, nome `conversation-closed`) — o fechamento nunca
   * falha por causa do callback; erro aqui só faz o job tentar de novo.
   *
   * Opcional: só adapters que implementam recebem o job.
   */
  onConversationClosed?(
    channel: Channel,
    conversation: ClosedConversationInfo,
  ): Promise<void>;

  getRateLimits(): RateLimitConfig;
}

export interface ClosedConversationInfo {
  id: string;
  externalThreadId: string | null;
  closedAt: Date;
}

export const OUTBOUND_CHANNEL_PORT = 'OUTBOUND_CHANNEL_PORT';
