import { createHmac } from 'crypto';
import { ChannelType, ConversationStatus } from '@prisma/client';
import { MembersChannelService } from './members-channel.service';
import { MembersInboundAdapter } from './members.inbound-adapter';
import { HistoryImportService } from '../../../messaging/pipeline/history-import.service';
import { ConversationResolverService } from '../../../messaging/pipeline/conversation-resolver.service';

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
      findFirst: jest.fn(async ({ where }: any) => {
        const rows = conversations
          .filter(
            (c) =>
              c.channelId === where.channelId &&
              c.contactId === where.contactId &&
              (where.deletedAt !== null || !c.deletedAt),
          )
          .sort((a, b) => {
            const la = a.lastMessageAt ? a.lastMessageAt.getTime() : -Infinity;
            const lb = b.lastMessageAt ? b.lastMessageAt.getTime() : -Infinity;
            if (la !== lb) return lb - la;
            return b.createdAt.getTime() - a.createdAt.getTime();
          });
        return rows[0] ?? null;
      }),
      create: jest.fn(async ({ data }: any) => {
        if (
          conversations.some(
            (c) => c.channelId === data.channelId && c.externalThreadId === data.externalThreadId,
          )
        ) {
          throw p2002();
        }
        const conv = {
          id: id('conv'),
          metadata: {},
          lastMessageAt: null,
          deletedAt: null,
          assignedToId: null,
          createdAt: new Date(),
          ...data,
        };
        conversations.push(conv);
        return conv;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const c = conversations.find((x) => x.id === where.id);
        const { assignedTo, ...rest } = data;
        if (
          rest.externalThreadId &&
          conversations.some(
            (o) => o.id !== c.id && o.channelId === c.channelId && o.externalThreadId === rest.externalThreadId,
          )
        ) {
          throw p2002();
        }
        Object.assign(c, rest);
        if (assignedTo?.disconnect) c.assignedToId = null;
        return c;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        // Suporta o guard "nunca regride": OR [{lastMessageAt: null}, {lastMessageAt: {lt}}].
        const c = conversations.find(
          (x) =>
            x.id === where.id &&
            (!where.OR ||
              where.OR.some((cond: any) =>
                cond.lastMessageAt === null
                  ? x.lastMessageAt == null
                  : x.lastMessageAt != null && x.lastMessageAt < cond.lastMessageAt.lt,
              )),
        );
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
  return { prisma, contacts, contactChannels, conversations, messages, notes, audit };
}

function build() {
  const db = fakePrisma();
  const idempotency = { withLock: jest.fn((_k: string, fn: () => any) => fn()) };
  const conversationResolver = new ConversationResolverService(db.prisma, idempotency as any);
  jest.spyOn(conversationResolver, 'resolve');
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
      { externalThreadId: 'sc_1', contactScoped: true },
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

describe('MembersChannelService — 1 conversa por contato', () => {
  const handoffOn = (convId: string, timestamp: string) => ({
    ...handoffEvent,
    conversation: { ...handoffEvent.conversation, id: convId },
    handoff: { ...handoffEvent.handoff, timestamp },
  });

  it('reuses the contact conversation for a new members conversation and moves externalThreadId', async () => {
    const { service, db } = build();
    const e1 = handoffOn('sc_1', '2026-10-19T12:00:00.000Z');
    const s1 = signed(e1);
    await service.receiveWebhook(s1.headers, s1.raw, e1);
    db.conversations[0].status = ConversationStatus.CLOSED;
    db.conversations[0].assignedToId = 'u_1';

    const e2 = handoffOn('sc_2', '2026-10-20T08:00:00.000Z');
    const s2 = signed(e2);
    await service.receiveWebhook(s2.headers, s2.raw, e2);

    expect(db.conversations).toHaveLength(1);
    expect(db.conversations[0]).toMatchObject({
      externalThreadId: 'sc_2',
      status: ConversationStatus.PENDING,
      closedAt: null,
      assignedToId: null,
      metadata: expect.objectContaining({
        membersConversationIds: ['sc_1', 'sc_2'],
        membersLastActivityAt: '2026-10-20T08:00:00.000Z',
      }),
    });
    expect(db.messages.filter((m) => m.type === 'SYSTEM')).toHaveLength(2);

    // message event de uma 3ª conversa do members → mesma conversa, novo ponteiro.
    const msg = {
      event: 'message',
      conversation: { id: 'sc_3', tenantId: null, tenantName: null },
      contact: handoffEvent.contact,
      message: { id: 'sm_9', text: 'oi de novo', timestamp: '2026-10-21T09:00:00.000Z' },
    };
    const s3 = signed(msg);
    await service.receiveWebhook(s3.headers, s3.raw, msg);
    expect(db.conversations).toHaveLength(1);
    expect(db.conversations[0].externalThreadId).toBe('sc_3');
  });

  it('pre-merge data: an event for a thread held by an older conversation of the contact uses it (no unique violation)', async () => {
    const { service, db } = build();
    const e1 = handoffOn('sc_a', '2026-10-01T12:00:00.000Z');
    const s1 = signed(e1);
    await service.receiveWebhook(s1.headers, s1.raw, e1);
    // Duplicata legada (criada pelo modelo antigo: 1 conversa por thread).
    db.conversations.push({
      id: 'conv_legacy',
      channelId: CHANNEL.id,
      organizationId: 'org_1',
      contactId: db.contacts[0].id,
      externalThreadId: 'sc_b',
      status: ConversationStatus.OPEN,
      lastMessageAt: new Date('2026-10-10T00:00:00.000Z'),
      createdAt: new Date('2026-10-10T00:00:00.000Z'),
      metadata: {},
      deletedAt: null,
    });
    const e2 = handoffOn('sc_a', '2026-10-15T12:00:00.000Z');
    const s2 = signed(e2);
    const res = await service.receiveWebhook(s2.headers, s2.raw, e2);
    expect(res.status).toBe(200);
    expect(db.conversations).toHaveLength(2);
    expect(db.conversations.map((c) => c.externalThreadId).sort()).toEqual(['sc_a', 'sc_b']);
    expect(db.messages.filter((m) => m.type === 'SYSTEM')).toHaveLength(2);
    expect(db.messages.every((m) => m.conversationId === db.conversations[0].id)).toBe(true);
  });

  const item = (over: Record<string, any>) => ({
    conversation: { id: 'sc_x', tenantId: 't_1', tenantName: 'Escola X' },
    contact: { externalId: 'user:99', name: 'Duda', email: null, phone: null },
    status: 'CLOSED',
    startedAt: '2026-01-01T10:00:00.000Z',
    lastMessageAt: '2026-01-01T10:30:00.000Z',
    handoff: null,
    messages: [],
    ...over,
  });
  const older = item({
    conversation: { id: 'sc_jan', tenantId: 't_1', tenantName: 'Escola X' },
    status: 'CLOSED',
    startedAt: '2026-01-01T10:00:00.000Z',
    lastMessageAt: '2026-01-01T10:30:00.000Z',
    handoff: { reason: null, transcript: 'Membro: oi', timestamp: '2026-01-01T10:05:00.000Z' },
    messages: [
      { id: 'j1', direction: 'INBOUND', sender: 'member', text: 'oi', timestamp: '2026-01-01T10:00:00.000Z' },
      { id: 'j2', direction: 'OUTBOUND', sender: 'agent', text: 'ok', timestamp: '2026-01-01T10:30:00.000Z' },
    ],
  });
  const newer = item({
    conversation: { id: 'sc_oct', tenantId: 't_1', tenantName: 'Escola X' },
    status: 'OPEN',
    startedAt: '2026-10-18T10:00:00.000Z',
    lastMessageAt: '2026-10-18T10:10:00.000Z',
    handoff: { reason: 'x', transcript: 'Membro: socorro', timestamp: '2026-10-18T10:01:00.000Z' },
    messages: [
      { id: 'o1', direction: 'INBOUND', sender: 'member', text: 'socorro', timestamp: '2026-10-18T10:10:00.000Z' },
    ],
  });

  it.each([
    ['older first', [older, newer]],
    ['newer first', [newer, older]],
  ])('import merges two members conversations of one contact into one (%s)', async (_label, convs) => {
    const { service, db } = build();
    const body = { conversations: convs };
    const { raw, headers } = signed(body);
    const res = await service.receiveImport(headers, raw, body);
    expect(res).toEqual({ status: 200, body: { ok: true, imported: 2, skipped: 0 } });

    expect(db.conversations).toHaveLength(1);
    const conv = db.conversations[0];
    expect(conv).toMatchObject({
      externalThreadId: 'sc_oct',
      status: ConversationStatus.PENDING,
      lastMessageAt: new Date('2026-10-18T10:10:00.000Z'),
      createdAt: new Date('2026-01-01T10:00:00.000Z'),
    });
    expect(conv.closedAt ?? null).toBeNull();
    expect([...conv.metadata.membersConversationIds].sort()).toEqual(['sc_jan', 'sc_oct']);
    expect(conv.metadata.membersLastActivityAt).toBe('2026-10-18T10:10:00.000Z');
    expect(
      db.messages
        .filter((m) => m.type !== 'SYSTEM')
        .map((m) => m.externalId)
        .sort(),
    ).toEqual(['j1', 'j2', 'o1']);
    expect(db.messages.filter((m) => m.type === 'SYSTEM')).toHaveLength(2);
    expect(db.messages.every((m) => m.conversationId === conv.id)).toBe(true);

    // Re-import: nada novo.
    const again = await service.receiveImport(headers, raw, body);
    expect(again).toEqual({ status: 200, body: { ok: true, imported: 0, skipped: 2 } });
    expect(db.conversations).toHaveLength(1);
    expect(db.messages).toHaveLength(5);
  });

  it('import reopens a CLOSED contact conversation for a new OPEN item, but a re-import never reopens', async () => {
    const { service, db } = build();
    const b1 = { conversations: [older] };
    const s1 = signed(b1);
    await service.receiveImport(s1.headers, s1.raw, b1);
    expect(db.conversations[0].status).toBe(ConversationStatus.CLOSED);

    const b2 = { conversations: [newer] };
    const s2 = signed(b2);
    await service.receiveImport(s2.headers, s2.raw, b2);
    expect(db.conversations).toHaveLength(1);
    expect(db.conversations[0].status).toBe(ConversationStatus.PENDING);

    db.conversations[0].status = ConversationStatus.CLOSED; // atendente encerrou
    await service.receiveImport(s2.headers, s2.raw, b2);
    expect(db.conversations[0].status).toBe(ConversationStatus.CLOSED);
  });

  it('import of an older members conversation keeps the newest externalThreadId and lastMessageAt', async () => {
    const { service, db } = build();
    const live = {
      ...handoffEvent,
      conversation: { id: 'sc_live', tenantId: 't_1', tenantName: 'Escola X' },
      contact: older.contact,
      handoff: { ...handoffEvent.handoff, timestamp: '2026-10-19T12:00:00.000Z' },
    };
    const s1 = signed(live);
    await service.receiveWebhook(s1.headers, s1.raw, live);

    const b = { conversations: [older] };
    const s2 = signed(b);
    await service.receiveImport(s2.headers, s2.raw, b);
    expect(db.conversations).toHaveLength(1);
    expect(db.conversations[0].externalThreadId).toBe('sc_live');
    expect(db.conversations[0].lastMessageAt).toEqual(new Date('2026-10-19T12:00:00.000Z'));
    expect(db.conversations[0].status).toBe(ConversationStatus.PENDING);
  });
});
