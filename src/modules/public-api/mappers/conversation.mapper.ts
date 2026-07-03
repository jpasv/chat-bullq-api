export interface PublicConversation {
  id: string;
  status: string;
  channelId: string | null;
  contactId: string | null;
  assignedToId: string | null;
  departmentId: string | null;
  subject: string | null;
  protocol: string | null;
  isGroup: boolean;
  isArchived: boolean;
  lastMessageAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  channel: { id: string; type: string; name: string } | null;
  contact: { id: string; name: string | null; phone: string | null } | null;
}

export function mapConversation(cv: any): PublicConversation {
  return {
    id: cv.id,
    status: cv.status,
    channelId: cv.channelId ?? null,
    contactId: cv.contactId ?? null,
    assignedToId: cv.assignedToId ?? null,
    departmentId: cv.departmentId ?? null,
    subject: cv.subject ?? null,
    protocol: cv.protocol ?? null,
    isGroup: cv.isGroup ?? false,
    isArchived: cv.isArchived ?? false,
    lastMessageAt: cv.lastMessageAt ?? null,
    closedAt: cv.closedAt ?? null,
    createdAt: cv.createdAt,
    updatedAt: cv.updatedAt,
    channel: cv.channel ? { id: cv.channel.id, type: cv.channel.type, name: cv.channel.name } : null,
    contact: cv.contact ? { id: cv.contact.id, name: cv.contact.name ?? null, phone: cv.contact.phone ?? null } : null,
  };
}
