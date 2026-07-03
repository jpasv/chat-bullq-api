// Mapeia o payload interno do outbox para o `data` público do webhook (thin: só IDs).
export function mapWebhookData(type: string, payload: any): Record<string, any> {
  const base = {
    contactId: payload.contactId,
    conversationId: payload.conversationId,
    channelId: payload.channelId,
  };
  switch (type) {
    case 'MESSAGE_RECEIVED':
      return { contactId: payload.contactId, conversationId: payload.conversationId, channelId: payload.channelId, messageId: payload.messageId };
    case 'CONVERSATION_CREATED':
      return { contactId: payload.contactId, conversationId: payload.conversationId, channelId: payload.channelId };
    case 'CONVERSATION_STATUS_CHANGED':
      return { ...base, fromStatus: payload.fromStatus, toStatus: payload.toStatus };
    case 'CONVERSATION_ASSIGNED':
      return { ...base, fromAssigneeId: payload.fromAssigneeId, toAssigneeId: payload.toAssigneeId };
    case 'TAG_ADDED':
    case 'TAG_REMOVED':
      return { contactId: payload.contactId, conversationId: payload.conversationId, tagId: payload.tagId };
    default:
      return { ...payload };
  }
}
