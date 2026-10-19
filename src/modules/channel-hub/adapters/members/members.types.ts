/**
 * Wire contract do canal MEMBERS (members-backend <-> chat-bullq).
 * Fonte: docs/superpowers/specs/2026-10-19-support-chat-bullq-channel-design.md
 * (members-backend). NÃO mudar formato sem alinhar os dois lados.
 */

export const MEMBERS_CHANNEL_HEADER = 'x-members-channel';
export const MEMBERS_SIGNATURE_HEADER = 'x-members-signature';
export const BULLQ_SIGNATURE_HEADER = 'X-Bullq-Signature';

export const MEMBERS_IMPORT_MAX_CONVERSATIONS = 50;

export interface MembersChannelConfig {
  callbackUrl: string;
  callbackSecret: string;
}

export interface MembersConversationRef {
  id: string;
  tenantId: string | null;
  tenantName: string | null;
}

export interface MembersContact {
  externalId: string;
  name: string | null;
  email: string | null;
  phone: string | null;
}

export interface MembersHandoff {
  reason: string | null;
  transcript: string;
  timestamp: string;
}

export interface MembersInboundMessage {
  id: string;
  text: string;
  timestamp: string;
}

export interface MembersInboundEvent {
  event: 'handoff' | 'message';
  conversation: MembersConversationRef;
  contact: MembersContact;
  message?: MembersInboundMessage;
  handoff?: MembersHandoff;
}

export interface MembersImportMessage {
  id: string;
  direction: 'INBOUND' | 'OUTBOUND';
  sender: 'member' | 'bot' | 'agent';
  text: string;
  timestamp: string;
}

export interface MembersImportConversation {
  conversation: MembersConversationRef;
  contact: MembersContact;
  status: 'OPEN' | 'CLOSED';
  startedAt: string;
  lastMessageAt: string;
  handoff: MembersHandoff | null;
  messages: MembersImportMessage[];
}

export interface MembersImportPayload {
  conversations: MembersImportConversation[];
}

/** Callback chat-bullq -> members-backend. */
export type MembersCallbackPayload =
  | {
      event: 'message';
      conversationId: string;
      message: {
        id: string;
        text: string;
        agentName: string | null;
        createdAt: string;
      };
    }
  | {
      event: 'conversation_closed';
      conversationId: string;
      closedAt: string;
    };

// ─── Validação (corpo inválido → 400) ─────────────────────────

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string };

const isObj = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v: unknown): v is string =>
  typeof v === 'string' && v.trim().length > 0;
const isNullableString = (v: unknown) =>
  v === undefined || v === null || typeof v === 'string';
const isIsoDate = (v: unknown): v is string =>
  typeof v === 'string' && !Number.isNaN(Date.parse(v));

function checkConversation(v: unknown, path: string): string | null {
  if (!isObj(v)) return `${path} must be an object`;
  if (!isNonEmptyString(v.id)) return `${path}.id is required`;
  if (!isNullableString(v.tenantId)) return `${path}.tenantId must be string|null`;
  if (!isNullableString(v.tenantName)) return `${path}.tenantName must be string|null`;
  return null;
}

function checkContact(v: unknown, path: string): string | null {
  if (!isObj(v)) return `${path} must be an object`;
  if (!isNonEmptyString(v.externalId)) return `${path}.externalId is required`;
  if (!/^(user|email|conv):.+/.test(v.externalId)) {
    return `${path}.externalId must start with user:, email: or conv:`;
  }
  for (const k of ['name', 'email', 'phone']) {
    if (!isNullableString(v[k])) return `${path}.${k} must be string|null`;
  }
  return null;
}

function checkHandoff(v: unknown, path: string): string | null {
  if (!isObj(v)) return `${path} must be an object`;
  if (!isNullableString(v.reason)) return `${path}.reason must be string|null`;
  if (typeof v.transcript !== 'string') return `${path}.transcript must be a string`;
  if (!isIsoDate(v.timestamp)) return `${path}.timestamp must be an ISO 8601 date`;
  return null;
}

export function validateMembersEvent(body: unknown): Validation<MembersInboundEvent> {
  if (!isObj(body)) return { ok: false, error: 'body must be a JSON object' };
  if (body.event !== 'handoff' && body.event !== 'message') {
    return { ok: false, error: 'event must be "handoff" or "message"' };
  }
  const err =
    checkConversation(body.conversation, 'conversation') ??
    checkContact(body.contact, 'contact');
  if (err) return { ok: false, error: err };

  if (body.event === 'message') {
    const m = body.message;
    if (!isObj(m)) return { ok: false, error: 'message must be an object' };
    if (!isNonEmptyString(m.id)) return { ok: false, error: 'message.id is required' };
    if (typeof m.text !== 'string') return { ok: false, error: 'message.text must be a string' };
    if (!isIsoDate(m.timestamp)) {
      return { ok: false, error: 'message.timestamp must be an ISO 8601 date' };
    }
  } else {
    const herr = checkHandoff(body.handoff, 'handoff');
    if (herr) return { ok: false, error: herr };
  }
  return { ok: true, value: body as unknown as MembersInboundEvent };
}

export function validateMembersImport(body: unknown): Validation<MembersImportPayload> {
  if (!isObj(body) || !Array.isArray(body.conversations)) {
    return { ok: false, error: 'conversations must be an array' };
  }
  if (body.conversations.length > MEMBERS_IMPORT_MAX_CONVERSATIONS) {
    return {
      ok: false,
      error: `max ${MEMBERS_IMPORT_MAX_CONVERSATIONS} conversations per request`,
    };
  }
  for (let i = 0; i < body.conversations.length; i++) {
    const c = body.conversations[i];
    const p = `conversations[${i}]`;
    if (!isObj(c)) return { ok: false, error: `${p} must be an object` };
    const err =
      checkConversation(c.conversation, `${p}.conversation`) ??
      checkContact(c.contact, `${p}.contact`);
    if (err) return { ok: false, error: err };
    if (c.status !== 'OPEN' && c.status !== 'CLOSED') {
      return { ok: false, error: `${p}.status must be "OPEN" or "CLOSED"` };
    }
    if (!isIsoDate(c.startedAt)) return { ok: false, error: `${p}.startedAt must be ISO 8601` };
    if (!isIsoDate(c.lastMessageAt)) {
      return { ok: false, error: `${p}.lastMessageAt must be ISO 8601` };
    }
    if (c.handoff !== null && c.handoff !== undefined) {
      const herr = checkHandoff(c.handoff, `${p}.handoff`);
      if (herr) return { ok: false, error: herr };
    }
    if (!Array.isArray(c.messages)) return { ok: false, error: `${p}.messages must be an array` };
    for (let j = 0; j < c.messages.length; j++) {
      const m = c.messages[j];
      const mp = `${p}.messages[${j}]`;
      if (!isObj(m)) return { ok: false, error: `${mp} must be an object` };
      if (!isNonEmptyString(m.id)) return { ok: false, error: `${mp}.id is required` };
      if (m.direction !== 'INBOUND' && m.direction !== 'OUTBOUND') {
        return { ok: false, error: `${mp}.direction must be INBOUND or OUTBOUND` };
      }
      if (!['member', 'bot', 'agent'].includes(m.sender)) {
        return { ok: false, error: `${mp}.sender must be member, bot or agent` };
      }
      if (typeof m.text !== 'string') return { ok: false, error: `${mp}.text must be a string` };
      if (!isIsoDate(m.timestamp)) return { ok: false, error: `${mp}.timestamp must be ISO 8601` };
    }
  }
  return { ok: true, value: body as unknown as MembersImportPayload };
}
