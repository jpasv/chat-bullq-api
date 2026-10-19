import { createHmac } from 'crypto';
import { ChannelType, ConversationStatus } from '@prisma/client';
import { MembersChannelService } from './members-channel.service';
import { MembersInboundAdapter } from './members.inbound-adapter';
import { HistoryImportService } from '../../../messaging/pipeline/history-import.service';

const SECRET = 'whsec_test_123';
const CHANNEL = {
  id: 'ch_members',
  organizationId: 'org_1',
  type: ChannelType.MEMBERS,
  isActive: true,
  deletedAt: null,
  webhookSecret: SECRET,
  config: { callbackUrl: 'https://m/cb', callbackSecret: 'x' },
};

/** Prisma em memória — só o necessário pro fluxo MEMBERS + HistoryImport. */
function fakePrisma() {
  let seq = 0;
  const id = (p: string) => `${p}_${++seq}`;
  const contacts: any[] = [];
  const contactChannels: any[] = [];
  const conversations: any[] = [];
  const messages: any[] = [];
  const notes: any[] = [];
  const audit: any[] = [];

  const withContact = (cc: any) =>
    cc ? { ...cc, contact: contacts.find((c) => c.id === cc.contactId) } : null;
  const p2002 = () => Object.assign(new Error('unique'), { code: 'P2002' });

  const prisma: any = {
    channel: {
      findFirst: jest.fn(async ({ where }: any) =>
        where.id === CHANNEL.id && where.type === CHANNEL.type ? CHANNEL : null,
      ),
    },
    contactChannel: {
      findUnique: jest.fn(async ({ where }: any) => {
        const k = where.uq_contact_channel_external;
        return withContact(
          contactChannels.find((c) => c.channelId === k.channelId && c.externalId === k.externalId),
        );
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const cc = contactChannels.find((c) => c.id === where.id);
        Object.assign(cc, data);
        return cc;
      }),
    },
    contact: {
      create: jest.fn(async ({ data }: any) => {
        const { channels, ...rest } = data;
        const contact = { id: id('ct'), metadata: {}, ...rest };
        contacts.push(contact);
        if (channels?.create) {
          contactChannels.push({ id: id('cc'), contactId: contact.id, ...channels.create });
        }
        return contact;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const c = contacts.find((x) => x.id === where.id);
        Object.assign(c, data);
        return c;
      }),
    },
    conversation: {
      findUnique: jest.fn(async ({ where }: any) => {
        if (where.uq_conv_channel_thread) {
          const k = where.uq_conv_channel_thread;
          return (
            conversations.find(
              (c) => c.channelId === k.channelId && c.externalThreadId === k.externalThreadId,
            ) ?? null
          );
        }
        return conversations.find((c) => c.id === where.id) ?? null;
      }),
      create: jest.fn(async ({ data }: any) => {
        if (
          conversations.some(
            (c) => c.channelId === data.channelId && c.externalThreadId === data.externalThreadId,
          )
        ) {
          throw p2002();
        }
        const conv = { id: id('conv'), metadata: {}, lastMessageAt: null, ...data };
        conversations.push(conv);
        return conv;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const c = conversations.find((x) => x.id === where.id);
        Object.assign(c, data);
        return c;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const c = conversations.find((x) => x.id === where.id);
        if (c) Object.assign(c, data);
        return { count: c ? 1 : 0 };
      }),
    },
    conversationAuditLog: { create: jest.fn(async ({ data }: any) => audit.push(data)) },
    message: {
      findUnique: jest.fn(async ({ where }: any) => {
        const k = where.uq_msg_conv_external;
        return (
          messages.find((m) => m.conversationId === k.conversationId && m.externalId === k.externalId) ??
          null
        );
      }),
      findMany: jest.fn(async ({ where }: any) =>
        messages.filter(
          (m) => m.conversationId === where.conversationId && where.externalId.in.includes(m.externalId),
        ),
      ),
      create: jest.fn(async ({ data }: any) => {
        if (messages.some((m) => m.conversationId === data.conversationId && m.externalId === data.externalId)) {
          throw p2002();
        }
        const m = { id: id('msg'), ...data };
        messages.push(m);
        return m;
      }),
      createMany: jest.fn(async ({ data }: any) => {
        let count = 0;
        for (const d of data) {
          if (messages.some((m) => m.conversationId === d.conversationId && m.externalId === d.externalId)) continue;
          messages.push({ id: id('msg'), ...d });
          count++;
        }
        return { count };
      }),
    },
    internalNote: { create: jest.fn(async ({ data }: any) => notes.push(data)) },
  };
  return { prisma, contacts, contactChannels, conversations, messages, notes };
}

function build() {
  const db = fakePrisma();
  const idempotency = { withLock: jest.fn((_k: string, fn: () => any) => fn()) };
  const conversationResolver = {
    resolve: jest.fn(async (_org: string, channelId: string, contactId: string, _g: boolean, opts: any) => {
      const existing = db.conversations.find(
        (c) => c.channelId === channelId && c.externalThreadId === opts.externalThreadId,
      );
      if (existing) {
        const wasReopened = existing.status === ConversationStatus.CLOSED;
        if (wasReopened) existing.status = ConversationStatus.PENDING;
        return { conversationId: existing.id, status: existing.status, isNew: false, wasReopened };
      }
      const conv = await db.prisma.conversation.create({
        data: {
          organizationId: 'org_1',
          channelId,
          contactId,
          externalThreadId: opts.externalThreadId,
          status: ConversationStatus.PENDING,
        },
      });
      return { conversationId: conv.id, status: conv.status, isNew: true, wasReopened: false };
    }),
  };
  const realtime = { emitToChannel: jest.fn(), emitToConversation: jest.fn() };
  const historyImport = new HistoryImportService(db.prisma, realtime as any);
  const webhookEvents = {
    record: jest.fn().mockResolvedValue('evt_1'),
    markProcessed: jest.fn().mockResolvedValue(undefined),
  };
  const queue = { add: jest.fn().mockResolvedValue(undefined) };
  const service = new MembersChannelService(
    db.prisma,
    idempotency as any,
    conversationResolver as any,
    historyImport,
    realtime as any,
    webhookEvents as any,
    new MembersInboundAdapter(),
    queue as any,
  );
  return { service, db, queue, conversationResolver, realtime };
}

function signed(body: unknown, channelId = CHANNEL.id, secret = SECRET) {
  const raw = JSON.stringify(body);
  return {
    raw: Buffer.from(raw),
    headers: {
      'x-members-channel': channelId,
      'x-members-signature': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`,
    } as Record<string, string>,
  };
}

const handoffEvent = {
  event: 'handoff',
  conversation: { id: 'sc_1', tenantId: 't_1', tenantName: 'Escola X' },
  contact: { externalId: 'user:42', name: 'Ana', email: 'ana@x.com', phone: '5511999999999' },
  handoff: {
    reason: 'quer reembolso',
    transcript: 'Membro: quero reembolso\nBot: vou chamar um atendente',
    timestamp: '2026-10-19T12:00:00.000Z',
  },
};

describe('MembersChannelService.receiveWebhook — auth & validation', () => {
  it('404 when X-Members-Channel is missing or unknown', async () => {
    const { service } = build();
    const { raw, headers } = signed(handoffEvent, 'nope');
    expect((await service.receiveWebhook(headers, raw, handoffEvent)).status).toBe(404);
    const { raw: r2 } = signed(handoffEvent);
    expect((await service.receiveWebhook({}, r2, handoffEvent)).status).toBe(404);
  });

  it('401 on bad or missing signature', async () => {
    const { service } = build();
    const { raw, headers } = signed(handoffEvent, CHANNEL.id, 'wrong');
    expect((await service.receiveWebhook(headers, raw, handoffEvent)).status).toBe(401);
    const res = await service.receiveWebhook({ 'x-members-channel': CHANNEL.id }, raw, handoffEvent);
    expect(res.status).toBe(401);
  });

  it('400 on invalid body', async () => {
    const { service } = build();
    const bad = { event: 'nope' };
    const { raw, headers } = signed(bad);
    const res = await service.receiveWebhook(headers, raw, bad);
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });
});

describe('MembersChannelService — handoff event', () => {
  it('creates contact (with tenant metadata), thread conversation and an internal note', async () => {
    const { service, db, conversationResolver, realtime } = build();
    const { raw, headers } = signed(handoffEvent);

    const res = await service.receiveWebhook(headers, raw, handoffEvent);

    expect(res).toEqual({ status: 200, body: { ok: true } });
    expect(db.contacts).toHaveLength(1);
    expect(db.contacts[0]).toMatchObject({
      name: 'Ana',
      email: 'ana@x.com',
      phone: '5511999999999',
      metadata: { membersTenantName: 'Escola X', membersTenantId: 't_1' },
    });
    expect(db.contactChannels[0]).toMatchObject({ channelId: CHANNEL.id, externalId: 'user:42' });
    expect(conversationResolver.resolve).toHaveBeenCalledWith(
      'org_1',
      CHANNEL.id,
      db.contacts[0].id,
      false,
      { externalThreadId: 'sc_1' },
    );
    expect(db.conversations[0].metadata).toMatchObject({ membersTenantName: 'Escola X' });

    expect(db.messages).toHaveLength(1);
    const note = db.messages[0];
    expect(note).toMatchObject({
      type: 'SYSTEM',
      externalId: 'handoff:2026-10-19T12:00:00.000Z',
      metadata: expect.objectContaining({ internalNote: true }),
    });
    expect(note.content.text).toContain('quer reembolso');
    expect(note.content.text).toContain('Bot: vou chamar um atendente');
    expect(db.notes).toEqual([
      expect.objectContaining({ authorId: 'system', conversationId: db.conversations[0].id }),
    ]);
    expect(realtime.emitToChannel).toHaveBeenCalledWith(CHANNEL.id, 'message:new', expect.anything());
  });

  it('is idempotent per conversation + handoff timestamp', async () => {
    const { service, db } = build();
    const { raw, headers } = signed(handoffEvent);
    await service.receiveWebhook(headers, raw, handoffEvent);
    await service.receiveWebhook(headers, raw, handoffEvent);
    expect(db.conversations).toHaveLength(1);
    expect(db.messages).toHaveLength(1);
    expect(db.notes).toHaveLength(1);

    // Novo handoff (outro timestamp) na mesma conversa → só mais uma nota.
    const again = { ...handoffEvent, handoff: { ...handoffEvent.handoff, timestamp: '2026-10-20T09:00:00.000Z' } };
    const s = signed(again);
    await service.receiveWebhook(s.headers, s.raw, again);
    expect(db.conversations).toHaveLength(1);
    expect(db.messages).toHaveLength(2);
  });

  it('reopens a CLOSED conversation as PENDING', async () => {
    const { service, db } = build();
    const { raw, headers } = signed(handoffEvent);
    await service.receiveWebhook(headers, raw, handoffEvent);
    db.conversations[0].status = ConversationStatus.CLOSED;

    const again = { ...handoffEvent, handoff: { ...handoffEvent.handoff, timestamp: '2026-10-21T09:00:00.000Z' } };
    const s = signed(again);
    await service.receiveWebhook(s.headers, s.raw, again);
    expect(db.conversations[0].status).toBe(ConversationStatus.PENDING);
  });

  it('updates name/email/phone of an existing contact', async () => {
    const { service, db } = build();
    const s1 = signed(handoffEvent);
    await service.receiveWebhook(s1.headers, s1.raw, handoffEvent);
    const changed = {
      ...handoffEvent,
      contact: { ...handoffEvent.contact, name: 'Ana Souza', email: 'ana2@x.com' },
      handoff: { ...handoffEvent.handoff, timestamp: '2026-10-22T09:00:00.000Z' },
    };
    const s2 = signed(changed);
    await service.receiveWebhook(s2.headers, s2.raw, changed);
    expect(db.contacts).toHaveLength(1);
    expect(db.contacts[0]).toMatchObject({ name: 'Ana Souza', email: 'ana2@x.com' });
  });
});

describe('MembersChannelService — message event', () => {
  it('enqueues process-inbound with thread id and message id as externalId', async () => {
    const { service, queue, db } = build();
    const event = {
      event: 'message',
      conversation: { id: 'sc_1', tenantId: null, tenantName: 'Escola X' },
      contact: { externalId: 'user:42', name: 'Ana', email: null, phone: null },
      message: { id: 'sm_1', text: 'Oi?', timestamp: '2026-10-19T12:05:00.000Z' },
    };
    const { raw, headers } = signed(event);
    const res = await service.receiveWebhook(headers, raw, event);
    expect(res).toEqual({ status: 200, body: { ok: true } });
    expect(db.conversations).toHaveLength(1);
    expect(queue.add).toHaveBeenCalledWith(
      'process-inbound',
      expect.objectContaining({
        channelId: CHANNEL.id,
        organizationId: 'org_1',
        message: expect.objectContaining({
          externalMessageId: 'sm_1',
          threadExternalId: 'sc_1',
          externalContactId: 'user:42',
          content: { text: 'Oi?' },
        }),
      }),
      expect.anything(),
    );
  });
});

describe('MembersChannelService.receiveImport', () => {
  const batch = {
    conversations: [
      {
        conversation: { id: 'sc_old', tenantId: 't_1', tenantName: 'Escola X' },
        contact: { externalId: 'email:bia@x.com', name: 'Bia', email: 'bia@x.com', phone: null },
        status: 'CLOSED',
        startedAt: '2026-01-01T10:00:00.000Z',
        lastMessageAt: '2026-01-01T10:30:00.000Z',
        handoff: { reason: null, transcript: 'Membro: oi', timestamp: '2026-01-01T10:05:00.000Z' },
        messages: [
          { id: 'm1', direction: 'INBOUND', sender: 'member', text: 'oi', timestamp: '2026-01-01T10:00:00.000Z' },
          { id: 'm2', direction: 'OUTBOUND', sender: 'bot', text: 'olá', timestamp: '2026-01-01T10:01:00.000Z' },
          { id: 'm3', direction: 'OUTBOUND', sender: 'agent', text: 'resolvido', timestamp: '2026-01-01T10:30:00.000Z' },
        ],
      },
      {
        conversation: { id: 'sc_new', tenantId: null, tenantName: null },
        contact: { externalId: 'user:7', name: 'Caio', email: null, phone: null },
        status: 'OPEN',
        startedAt: '2026-10-18T10:00:00.000Z',
        lastMessageAt: '2026-10-18T10:10:00.000Z',
        handoff: null,
        messages: [
          { id: 'm4', direction: 'INBOUND', sender: 'member', text: 'ajuda', timestamp: '2026-10-18T10:10:00.000Z' },
        ],
      },
    ],
  };

  it('imports conversations, messages, status and closedAt', async () => {
    const { service, db } = build();
    const { raw, headers } = signed(batch);
    const res = await service.receiveImport(headers, raw, batch);
    expect(res).toEqual({ status: 200, body: { ok: true, imported: 2, skipped: 0 } });

    const closed = db.conversations.find((c) => c.externalThreadId === 'sc_old');
    expect(closed).toMatchObject({
      status: ConversationStatus.CLOSED,
      closedAt: new Date('2026-01-01T10:30:00.000Z'),
      createdAt: new Date('2026-01-01T10:00:00.000Z'),
      lastMessageAt: new Date('2026-01-01T10:30:00.000Z'),
    });
    const open = db.conversations.find((c) => c.externalThreadId === 'sc_new');
    expect(open.status).toBe(ConversationStatus.PENDING);

    const byExt = (e: string) => db.messages.find((m) => m.externalId === e);
    expect(byExt('m2')).toMatchObject({
      direction: 'OUTBOUND',
      senderName: 'Bot',
      createdAt: new Date('2026-01-01T10:01:00.000Z'),
      sentAt: new Date('2026-01-01T10:01:00.000Z'),
      metadata: expect.objectContaining({ imported: true, membersSender: 'bot' }),
    });
    expect(byExt('m3')).toMatchObject({ senderName: 'Atendente' });
    expect(byExt('m1')).toMatchObject({ direction: 'INBOUND' });
    expect(db.messages.filter((m) => m.type === 'SYSTEM')).toHaveLength(1);
  });

  it('is idempotent: re-sending the same batch writes nothing and reports skipped', async () => {
    const { service, db } = build();
    const { raw, headers } = signed(batch);
    await service.receiveImport(headers, raw, batch);
    const counts = [db.conversations.length, db.messages.length, db.contacts.length, db.notes.length];

    const res = await service.receiveImport(headers, raw, batch);
    expect(res).toEqual({ status: 200, body: { ok: true, imported: 0, skipped: 2 } });
    expect([db.conversations.length, db.messages.length, db.contacts.length, db.notes.length]).toEqual(counts);
  });

  it('does not change the status of an already existing conversation', async () => {
    const { service, db } = build();
    const { raw, headers } = signed(batch);
    await service.receiveImport(headers, raw, batch);
    const conv = db.conversations.find((c) => c.externalThreadId === 'sc_old');
    conv.status = ConversationStatus.OPEN; // agente reabriu
    await service.receiveImport(headers, raw, batch);
    expect(conv.status).toBe(ConversationStatus.OPEN);
  });

  it('rejects more than 50 conversations and bad signatures', async () => {
    const { service } = build();
    const big = { conversations: Array.from({ length: 51 }, () => batch.conversations[1]) };
    const s = signed(big);
    expect((await service.receiveImport(s.headers, s.raw, big)).status).toBe(400);
    const bad = signed(batch, CHANNEL.id, 'wrong');
    expect((await service.receiveImport(bad.headers, bad.raw, batch)).status).toBe(401);
  });
});
