import { ChannelType, ConversationStatus } from '@prisma/client';
import { MembersContactMergeService } from './members-contact-merge.service';

const CHANNEL = {
  id: 'ch_members',
  organizationId: 'org_1',
  type: ChannelType.MEMBERS,
} as any;

/** Matcher mínimo de `where` do Prisma: igualdade, `{ in }`, `{ not }`. */
function matches(row: any, where: any = {}): boolean {
  return Object.entries(where).every(([k, cond]: [string, any]) => {
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('in' in cond) return cond.in.includes(row[k]);
      if ('not' in cond) return cond.not === null ? row[k] != null : row[k] !== cond.not;
    }
    return (row[k] ?? null) === cond;
  });
}

function table(rows: any[], unique?: (a: any, b: any) => boolean) {
  const p2002 = () => Object.assign(new Error('unique'), { code: 'P2002' });
  const check = (row: any) => {
    if (unique && rows.some((o) => o !== row && unique(o, row))) throw p2002();
  };
  return {
    rows,
    findMany: jest.fn(async ({ where }: any = {}) => rows.filter((r) => matches(r, where))),
    findFirst: jest.fn(async ({ where }: any = {}) => rows.find((r) => matches(r, where)) ?? null),
    findUnique: jest.fn(async ({ where }: any) => rows.find((r) => matches(r, where)) ?? null),
    update: jest.fn(async ({ where, data }: any) => {
      const r = rows.find((x) => matches(x, where));
      const before = { ...r };
      Object.assign(r, data);
      try {
        check(r);
      } catch (e) {
        Object.assign(r, before);
        throw e;
      }
      return r;
    }),
    updateMany: jest.fn(async ({ where, data }: any) => {
      const hit = rows.filter((r) => matches(r, where));
      for (const r of hit) {
        Object.assign(r, data);
        check(r);
      }
      return { count: hit.length };
    }),
    deleteMany: jest.fn(async ({ where }: any) => {
      const keep = rows.filter((r) => !matches(r, where));
      const count = rows.length - keep.length;
      rows.splice(0, rows.length, ...keep);
      return { count };
    }),
    create: jest.fn(async ({ data }: any) => {
      rows.push({ ...data });
      return data;
    }),
    createMany: jest.fn(async ({ data, skipDuplicates }: any) => {
      let count = 0;
      for (const d of data) {
        if (unique && rows.some((o) => unique(o, d))) {
          if (skipDuplicates) continue;
          throw p2002();
        }
        rows.push({ ...d });
        count++;
      }
      return { count };
    }),
  };
}

function fakeDb() {
  const conversation = table([], (a, b) =>
    !!a.externalThreadId && a.channelId === b.channelId && a.externalThreadId === b.externalThreadId,
  );
  const message = table([], (a, b) =>
    !!a.externalId && a.conversationId === b.conversationId && a.externalId === b.externalId,
  );
  const db: any = {
    conversation,
    message,
    internalNote: table([]),
    conversationAuditLog: table([]),
    aiAgentRun: table([]),
    aiAgentHandoff: table([]),
    aiPendingAction: table([]),
    card: table([]),
    onboardingLead: table([]),
    conversationTag: table([], (a, b) => a.conversationId === b.conversationId && a.tagId === b.tagId),
    conversationRating: table([], (a, b) => a.conversationId === b.conversationId),
    conversationPin: table([], (a, b) => a.conversationId === b.conversationId && a.userId === b.userId),
    conversationRead: table([], (a, b) => a.conversationId === b.conversationId && a.userId === b.userId),
  };
  // Cascade ao apagar conversa (como no schema).
  const rawDelete = conversation.deleteMany;
  conversation.deleteMany = jest.fn(async (args: any) => {
    const ids = conversation.rows.filter((r) => matches(r, args.where)).map((r) => r.id);
    for (const t of [
      message,
      db.internalNote,
      db.conversationAuditLog,
      db.conversationTag,
      db.conversationRating,
      db.conversationPin,
      db.conversationRead,
    ]) {
      await t.deleteMany({ where: { conversationId: { in: ids } } });
    }
    return rawDelete(args);
  });
  db.$transaction = jest.fn(async (fn: any) => fn(db));
  return db;
}

function conv(over: Record<string, any>) {
  return {
    channelId: CHANNEL.id,
    organizationId: 'org_1',
    contactId: 'ct_1',
    status: ConversationStatus.CLOSED,
    assignedToId: null,
    lastMessageAt: null,
    firstResponseAt: null,
    closedAt: null,
    deletedAt: null,
    externalThreadId: null,
    metadata: {},
    ...over,
  };
}

function build() {
  const db = fakeDb();
  const idempotency = { withLock: jest.fn((_k: string, fn: () => any) => fn()) };
  const service = new MembersContactMergeService(db, idempotency as any);
  return { db, service, idempotency };
}

function seed(db: any) {
  db.conversation.rows.push(
    conv({
      id: 'c_old',
      externalThreadId: 'sc_old',
      status: ConversationStatus.CLOSED,
      closedAt: new Date('2026-01-02T00:00:00Z'),
      lastMessageAt: new Date('2026-01-01T10:30:00Z'),
      firstResponseAt: new Date('2026-01-01T10:02:00Z'),
      createdAt: new Date('2026-01-01T10:00:00Z'),
      metadata: { membersConversationIds: ['sc_old'] },
    }),
    conv({
      id: 'c_mid',
      externalThreadId: 'sc_mid',
      status: ConversationStatus.OPEN,
      assignedToId: 'agent_1',
      lastMessageAt: new Date('2026-05-01T10:00:00Z'),
      firstResponseAt: new Date('2026-05-01T09:00:00Z'),
      createdAt: new Date('2026-05-01T08:00:00Z'),
    }),
    conv({
      id: 'c_new',
      externalThreadId: 'sc_new',
      status: ConversationStatus.PENDING,
      lastMessageAt: new Date('2026-10-18T10:00:00Z'),
      createdAt: new Date('2026-10-18T09:00:00Z'),
      metadata: { membersTenantName: 'Escola X' },
    }),
    // Outro contato com 1 conversa só → intocado.
    conv({
      id: 'c_other',
      contactId: 'ct_2',
      externalThreadId: 'sc_other',
      lastMessageAt: new Date('2026-10-01T00:00:00Z'),
      createdAt: new Date('2026-10-01T00:00:00Z'),
    }),
  );
  db.message.rows.push(
    { id: 'm1', conversationId: 'c_old', externalId: 'x1' },
    { id: 'm2', conversationId: 'c_old', externalId: 'handoff:2026-01-01T10:05:00.000Z' },
    { id: 'm3', conversationId: 'c_mid', externalId: 'x2' },
    { id: 'm4', conversationId: 'c_mid', externalId: null },
    { id: 'm5', conversationId: 'c_new', externalId: 'x3' },
    // Duplicata (mesmo externalId já está no alvo) → descartada.
    { id: 'm6', conversationId: 'c_mid', externalId: 'x3' },
    // Duplicata entre duas origens → só uma fica.
    { id: 'm7', conversationId: 'c_old', externalId: 'x2' },
    { id: 'm8', conversationId: 'c_other', externalId: 'x9' },
  );
  db.internalNote.rows.push(
    { id: 'n1', conversationId: 'c_old', authorId: 'system', content: 'handoff A' },
    { id: 'n2', conversationId: 'c_new', authorId: 'system', content: 'handoff A' },
    { id: 'n3', conversationId: 'c_mid', authorId: 'u_1', content: 'nota humana' },
  );
  db.conversationAuditLog.rows.push({ id: 'a1', conversationId: 'c_old', action: 'CREATED' });
  db.aiAgentRun.rows.push({ id: 'r1', conversationId: 'c_mid' });
  db.card.rows.push({ id: 'k1', conversationId: 'c_old' });
  db.onboardingLead.rows.push({ id: 'o1', conversationId: 'c_mid' });
  db.conversationTag.rows.push(
    { conversationId: 'c_old', tagId: 't_a' },
    { conversationId: 'c_new', tagId: 't_a' },
    { conversationId: 'c_mid', tagId: 't_b' },
  );
  db.conversationRating.rows.push({ id: 'rt1', conversationId: 'c_old', createdAt: new Date() });
  db.conversationPin.rows.push(
    { id: 'p1', conversationId: 'c_old', userId: 'u_1' },
    { id: 'p2', conversationId: 'c_new', userId: 'u_1' },
    { id: 'p3', conversationId: 'c_mid', userId: 'u_2' },
  );
  db.conversationRead.rows.push(
    { id: 'rd1', conversationId: 'c_old', userId: 'u_1' },
    { id: 'rd2', conversationId: 'c_new', userId: 'u_1' },
  );
}

describe('MembersContactMergeService.mergeChannel', () => {
  it('dry run reports without writing', async () => {
    const { db, service } = build();
    seed(db);
    const res = await service.mergeChannel(CHANNEL, { dryRun: true });
    expect(res).toEqual({
      groups: 1,
      merged: 1,
      deletedConversations: 2,
      movedMessages: 4, // m1, m2, m3, m4 (m6 e m7 duplicadas)
      dryRun: true,
    });
    expect(db.conversation.rows).toHaveLength(4);
    expect(db.message.rows).toHaveLength(8);
  });

  it('merges into the most recent conversation, moving children and dropping duplicates', async () => {
    const { db, service, idempotency } = build();
    seed(db);
    const res = await service.mergeChannel(CHANNEL, { dryRun: false });

    expect(res).toEqual({
      groups: 1,
      merged: 1,
      deletedConversations: 2,
      movedMessages: 4,
      dryRun: false,
    });
    expect(idempotency.withLock).toHaveBeenCalledWith(
      'conv:ch_members:ct_1',
      expect.any(Function),
      expect.anything(),
    );

    expect(db.conversation.rows.map((c: any) => c.id).sort()).toEqual(['c_new', 'c_other']);
    const target = db.conversation.rows.find((c: any) => c.id === 'c_new');
    expect(target).toMatchObject({
      externalThreadId: 'sc_new',
      status: ConversationStatus.OPEN, // OPEN > PENDING
      closedAt: null,
      assignedToId: 'agent_1', // alvo sem atendente → vem da origem aberta
      lastMessageAt: new Date('2026-10-18T10:00:00Z'),
      firstResponseAt: new Date('2026-01-01T10:02:00Z'),
      createdAt: new Date('2026-01-01T10:00:00Z'),
    });
    expect(target.metadata).toMatchObject({
      membersTenantName: 'Escola X',
      membersConversationIds: ['sc_old', 'sc_mid', 'sc_new'],
      mergedConversationIds: ['c_mid', 'c_old'],
    });

    const msgsOf = (id: string) =>
      db.message.rows.filter((m: any) => m.conversationId === id).map((m: any) => m.id).sort();
    expect(msgsOf('c_new')).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
    expect(msgsOf('c_other')).toEqual(['m8']);

    // Nota de handoff duplicada descartada; nota humana movida.
    expect(db.internalNote.rows.map((n: any) => [n.id, n.conversationId]).sort()).toEqual([
      ['n2', 'c_new'],
      ['n3', 'c_new'],
    ]);
    expect(db.aiAgentRun.rows[0].conversationId).toBe('c_new');
    expect(db.card.rows[0].conversationId).toBe('c_new');
    expect(db.onboardingLead.rows[0].conversationId).toBe('c_new');
    expect(
      db.conversationTag.rows.map((t: any) => `${t.conversationId}:${t.tagId}`).sort(),
    ).toEqual(['c_new:t_a', 'c_new:t_b']);
    expect(db.conversationRating.rows).toEqual([expect.objectContaining({ conversationId: 'c_new' })]);
    expect(
      db.conversationPin.rows.map((p: any) => `${p.conversationId}:${p.userId}`).sort(),
    ).toEqual(['c_new:u_1', 'c_new:u_2']);
    expect(db.conversationRead.rows.map((r: any) => r.id)).toEqual(['rd2']);
    expect(db.conversationAuditLog.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'a1', conversationId: 'c_new' }),
        expect.objectContaining({ conversationId: 'c_new', action: 'MERGED' }),
      ]),
    );
  });

  it('is idempotent: a second run finds nothing to merge', async () => {
    const { db, service } = build();
    seed(db);
    await service.mergeChannel(CHANNEL, { dryRun: false });
    const snapshot = JSON.stringify(db.conversation.rows);
    const res = await service.mergeChannel(CHANNEL, { dryRun: false });
    expect(res).toEqual({
      groups: 0,
      merged: 0,
      deletedConversations: 0,
      movedMessages: 0,
      dryRun: false,
    });
    expect(JSON.stringify(db.conversation.rows)).toBe(snapshot);
  });

  it('keeps CLOSED when every conversation of the contact is closed, and keeps the target assignee', async () => {
    const { db, service } = build();
    db.conversation.rows.push(
      conv({
        id: 'c1',
        externalThreadId: 'sc_1',
        assignedToId: 'agent_old',
        closedAt: new Date('2026-02-01T00:00:00Z'),
        lastMessageAt: new Date('2026-01-31T00:00:00Z'),
        createdAt: new Date('2026-01-30T00:00:00Z'),
      }),
      conv({
        id: 'c2',
        externalThreadId: 'sc_2',
        assignedToId: 'agent_new',
        closedAt: new Date('2026-03-01T00:00:00Z'),
        lastMessageAt: new Date('2026-02-28T00:00:00Z'),
        createdAt: new Date('2026-02-27T00:00:00Z'),
      }),
    );
    await service.mergeChannel(CHANNEL, { dryRun: false });
    expect(db.conversation.rows).toHaveLength(1);
    expect(db.conversation.rows[0]).toMatchObject({
      id: 'c2',
      status: ConversationStatus.CLOSED,
      closedAt: new Date('2026-03-01T00:00:00Z'),
      assignedToId: 'agent_new',
      externalThreadId: 'sc_2',
    });
  });

  it('picks WAITING over PENDING/BOT and keeps the target assignee when it has one', async () => {
    const { db, service } = build();
    db.conversation.rows.push(
      conv({
        id: 'c1',
        status: ConversationStatus.WAITING,
        assignedToId: 'agent_src',
        externalThreadId: 'sc_1',
        lastMessageAt: new Date('2026-01-01T00:00:00Z'),
        createdAt: new Date('2026-01-01T00:00:00Z'),
      }),
      conv({
        id: 'c2',
        status: ConversationStatus.BOT,
        externalThreadId: 'sc_2',
        lastMessageAt: new Date('2026-02-01T00:00:00Z'),
        createdAt: new Date('2026-02-01T00:00:00Z'),
      }),
      conv({
        id: 'c3',
        status: ConversationStatus.CLOSED,
        assignedToId: 'agent_target',
        externalThreadId: 'sc_3',
        closedAt: new Date('2026-03-02T00:00:00Z'),
        lastMessageAt: new Date('2026-03-01T00:00:00Z'),
        createdAt: new Date('2026-03-01T00:00:00Z'),
      }),
    );
    await service.mergeChannel(CHANNEL, { dryRun: false });
    expect(db.conversation.rows).toHaveLength(1);
    expect(db.conversation.rows[0]).toMatchObject({
      id: 'c3',
      status: ConversationStatus.WAITING,
      closedAt: null,
      assignedToId: 'agent_target',
      externalThreadId: 'sc_3',
    });
  });
});
