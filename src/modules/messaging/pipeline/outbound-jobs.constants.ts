/** Job `conversation-closed` na fila `outbound-messages`: avisa o provider
 *  (hook opcional `OutboundChannelPort.onConversationClosed`). */
export const CONVERSATION_CLOSED_JOB = 'conversation-closed';

export interface ConversationClosedJobData {
  conversationId: string;
  channelId: string;
  /** ISO 8601. */
  closedAt: string;
}
