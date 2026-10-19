import { ChannelType, ConversationStatus, MessageDirection } from '@prisma/client';
import { MessageContentType, NormalizedMessageContent } from './normalized-message.types';

export interface NormalizedHistoricalConversation {
  externalConversationId: string;
  externalContactId: string;
  contactName?: string;
  contactPhone?: string;
  contactAvatarUrl?: string;
  isGroup?: boolean;
  lastMessageAt?: Date;
  unreadCount?: number;
  rawPayload?: unknown;
  /**
   * Canais thread-based (GMAIL/MEMBERS): quando setado, a conversa é
   * localizada/criada por `(channelId, externalThreadId)` em vez de "conversa
   * aberta do contato" — torna o import idempotente por thread.
   */
  externalThreadId?: string;
  /** Status explícito na criação (default: PENDING/OPEN pelo unreadCount). */
  status?: ConversationStatus;
  /** Usado quando `status = CLOSED`. */
  closedAt?: Date;
  /** `Conversation.createdAt` (início real da conversa no provider). */
  startedAt?: Date;
  contactEmail?: string;
  /** Mesclado em `Contact.metadata` na criação/atualização. */
  contactMetadata?: Record<string, unknown>;
  /** Mesclado em `Conversation.metadata` na criação. */
  metadata?: Record<string, unknown>;
}

export interface NormalizedHistoricalMessage {
  externalMessageId: string;
  externalConversationId: string;
  externalContactId: string;
  direction: MessageDirection;
  timestamp: Date;
  type: MessageContentType;
  content: NormalizedMessageContent;
  senderName?: string;
  replyToExternalId?: string;
  rawPayload?: unknown;
  /** Mesclado em `Message.metadata` (além de `imported: true`). */
  metadata?: Record<string, unknown>;
}

export interface FetchConversationsResult {
  conversations: NormalizedHistoricalConversation[];
  nextCursor?: string;
}

export interface FetchMessagesResult {
  messages: NormalizedHistoricalMessage[];
  nextCursor?: string;
}

export interface SyncCapabilities {
  supportsHistoryImport: boolean;
  supportsDeltaSync: boolean;
  defaultLookbackDays: number;
  maxLookbackDays?: number;
}

export interface HistorySyncFilters {
  sinceTimestamp?: Date;
  untilTimestamp?: Date;
}
