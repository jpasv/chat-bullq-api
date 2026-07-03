export interface PublicMessage {
  id: string;
  conversationId: string;
  direction: string;
  type: string;
  content: unknown;
  status: string | null;
  externalId: string | null;
  senderId: string | null;
  senderName: string | null;
  sentAt: Date | null;
  deliveredAt: Date | null;
  readAt: Date | null;
  createdAt: Date;
}

export function mapMessage(m: any): PublicMessage {
  return {
    id: m.id,
    conversationId: m.conversationId,
    direction: m.direction,
    type: m.type,
    content: m.content ?? null,
    status: m.status ?? null,
    externalId: m.externalId ?? null,
    senderId: m.senderId ?? null,
    senderName: m.senderName ?? null,
    sentAt: m.sentAt ?? null,
    deliveredAt: m.deliveredAt ?? null,
    readAt: m.readAt ?? null,
    createdAt: m.createdAt,
  };
}
