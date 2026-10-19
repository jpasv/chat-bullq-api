import { Injectable, Logger } from '@nestjs/common';
import { Channel, Conversation, ConversationStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../../../database/prisma.service';
import { IdempotencyService } from '../../../messaging/pipeline/idempotency.service';
import {
  MEMBERS_IDS_CAP,
  MEMBERS_SYSTEM_AUTHOR,
  appendMembersId,
  parseDate,
  seenMembersIds,
} from './members-channel.service';

export interface MembersMergeResult {
  groups: number;
  merged: number;
  deletedConversations: number;
  movedMessages: number;
  dryRun: boolean;
}

interface GroupResult {
  targetId: string;
  sourceIds: string[];
  movedMessages: number;
  droppedMessages: number;
}

type Db = Prisma.TransactionClient;

/** Quanto mais "ativo", maior. CLOSED fica de fora (tratado à parte). */
const STATUS_RANK: Record<ConversationStatus, number> = {
  [ConversationStatus.OPEN]: 4,
  [ConversationStatus.WAITING]: 3,
  [ConversationStatus.PENDING]: 2,
  [ConversationStatus.BOT]: 1,
  [ConversationStatus.CLOSED]: 0,
};

/**
 * Merge único (one-off) das conversas duplicadas por contato num canal
 * MEMBERS: antes a chave era 1 conversa por conversa do members; agora é
 * 1 por contato. Pra cada contato com >1 conversa no canal:
 *  - alvo = a mais recente (lastMessageAt, nulls por último; desempate createdAt);
 *  - todas as relações filhas das demais vão pro alvo (ou são descartadas
 *    quando são estado por conversa que não dá pra fundir);
 *  - mensagens duplicadas por `externalId` são descartadas;
 *  - as demais conversas são apagadas.
 * Cada contato roda numa transação, sob o mesmo lock do resolver
 * (`conv:<channel>:<contact>`). Idempotente: rodar de novo não acha nada.
 * Não dispara callback de saída nem automação.
 */
@Injectable()
export class MembersContactMergeService {
  private readonly logger = new Logger(MembersContactMergeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async mergeChannel(channel: Channel, opts: { dryRun: boolean }): Promise<MembersMergeResult> {
    const { dryRun } = opts;
    const rows = await this.prisma.conversation.findMany({
      where: { channelId: channel.id, deletedAt: null },
      select: { id: true, contactId: true },
    });
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.contactId, (counts.get(r.contactId) ?? 0) + 1);
    const contactIds = [...counts.entries()].filter(([, n]) => n > 1).map(([id]) => id);

    const result: MembersMergeResult = {
      groups: contactIds.length,
      merged: 0,
      deletedConversations: 0,
      movedMessages: 0,
      dryRun,
    };

    for (const contactId of contactIds) {
      try {
        const group = dryRun
          ? await this.mergeContact(this.prisma, channel.id, contactId, true)
          : await this.idempotency.withLock(
              `conv:${channel.id}:${contactId}`,
              () =>
                this.prisma.$transaction(
                  (tx) => this.mergeContact(tx, channel.id, contactId, false),
                  { timeout: 120_000, maxWait: 10_000 },
                ),
              { ttlMs: 150_000, timeoutMs: 30_000 },
            );
        if (!group) continue;
        result.merged++;
        result.deletedConversations += group.sourceIds.length;
        result.movedMessages += group.movedMessages;
        this.logger.log(
          `${dryRun ? '[dry-run] ' : ''}Members merge contact=${contactId} target=${group.targetId} ` +
            `sources=${group.sourceIds.join(',')} movedMessages=${group.movedMessages} ` +
            `droppedDuplicates=${group.droppedMessages}`,
        );
      } catch (err: any) {
        this.logger.error(
          `Members merge failed for contact ${contactId} (channel ${channel.id}): ${err?.message ?? err}`,
          err?.stack,
        );
      }
    }

    this.logger.log(
      `${dryRun ? '[dry-run] ' : ''}Members merge on channel ${channel.id}: groups=${result.groups} ` +
        `merged=${result.merged} deletedConversations=${result.deletedConversations} ` +
        `movedMessages=${result.movedMessages}`,
    );
    return result;
  }

  /** Funde as conversas de UM contato. `null` quando já não há o que fundir. */
  async mergeContact(
    db: Db,
    channelId: string,
    contactId: string,
    dryRun: boolean,
  ): Promise<GroupResult | null> {
    const convs = await db.conversation.findMany({
      where: { channelId, contactId, deletedAt: null },
    });
    if (convs.length < 2) return null;

    const ordered = [...convs].sort(byRecencyDesc);
    const [target, ...sources] = ordered;
    const sourceIds = sources.map((s) => s.id);

    // ─── Mensagens: move, descartando duplicadas por externalId ───
    const targetMsgs = await db.message.findMany({
      where: { conversationId: target.id, externalId: { not: null } },
      select: { externalId: true },
    });
    const seen = new Set(targetMsgs.map((m) => m.externalId as string));
    let movedMessages = 0;
    let droppedMessages = 0;
    const dupIds: string[] = [];
    for (const src of sources) {
      const msgs = await db.message.findMany({
        where: { conversationId: src.id },
        select: { id: true, externalId: true },
      });
      for (const m of msgs) {
        if (m.externalId && seen.has(m.externalId)) {
          dupIds.push(m.id);
          droppedMessages++;
          continue;
        }
        if (m.externalId) seen.add(m.externalId);
        movedMessages++;
      }
    }

    if (dryRun) return { targetId: target.id, sourceIds, movedMessages, droppedMessages };

    if (dupIds.length) await db.message.deleteMany({ where: { id: { in: dupIds } } });
    await db.message.updateMany({
      where: { conversationId: { in: sourceIds } },
      data: { conversationId: target.id },
    });

    // ─── Notas internas: notas de sistema (handoff) iguais às do alvo são
    //     duplicatas do mesmo handoff → descartadas; o resto move. ───
    const targetSystemNotes = await db.internalNote.findMany({
      where: { conversationId: target.id, authorId: MEMBERS_SYSTEM_AUTHOR },
      select: { content: true },
    });
    const noteContents = new Set(targetSystemNotes.map((n) => n.content));
    const sourceSystemNotes = await db.internalNote.findMany({
      where: { conversationId: { in: sourceIds }, authorId: MEMBERS_SYSTEM_AUTHOR },
      select: { id: true, content: true },
    });
    const dupNoteIds: string[] = [];
    for (const n of sourceSystemNotes) {
      if (noteContents.has(n.content)) dupNoteIds.push(n.id);
      else noteContents.add(n.content);
    }
    if (dupNoteIds.length) await db.internalNote.deleteMany({ where: { id: { in: dupNoteIds } } });
    await db.internalNote.updateMany({
      where: { conversationId: { in: sourceIds } },
      data: { conversationId: target.id },
    });

    // ─── Relações 1:N sem unique por conversa → movem ───
    const move = { where: { conversationId: { in: sourceIds } }, data: { conversationId: target.id } };
    await db.conversationAuditLog.updateMany(move);
    await db.aiAgentRun.updateMany(move);
    await db.aiAgentHandoff.updateMany(move);
    await db.aiPendingAction.updateMany(move);
    await db.card.updateMany(move);
    await db.onboardingLead.updateMany(move);

    // ─── Tags (PK conversa+tag) → união ───
    const srcTags = await db.conversationTag.findMany({
      where: { conversationId: { in: sourceIds } },
      select: { tagId: true },
    });
    if (srcTags.length) {
      await db.conversationTag.createMany({
        data: [...new Set(srcTags.map((t) => t.tagId))].map((tagId) => ({
          conversationId: target.id,
          tagId,
        })),
        skipDuplicates: true,
      });
    }

    // ─── Avaliação (1 por conversa) → só se o alvo não tem ───
    const targetRating = await db.conversationRating.findUnique({
      where: { conversationId: target.id },
      select: { id: true },
    });
    if (!targetRating) {
      const srcRating = await db.conversationRating.findFirst({
        where: { conversationId: { in: sourceIds } },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      if (srcRating) {
        await db.conversationRating.update({
          where: { id: srcRating.id },
          data: { conversationId: target.id },
        });
      }
    }

    // ─── Pins (1 por usuário+conversa) → move se o usuário não fixou o alvo ───
    const targetPins = await db.conversationPin.findMany({
      where: { conversationId: target.id },
      select: { userId: true },
    });
    const pinned = new Set(targetPins.map((p) => p.userId));
    const srcPins = await db.conversationPin.findMany({
      where: { conversationId: { in: sourceIds } },
      select: { id: true, userId: true },
    });
    for (const p of srcPins) {
      if (pinned.has(p.userId)) continue;
      pinned.add(p.userId);
      await db.conversationPin.update({ where: { id: p.id }, data: { conversationId: target.id } });
    }

    // Marcadores de leitura são por conversa (unique usuário+conversa) e
    // apontam pra mensagens da conversa de origem → descartados; o resto
    // (tags/rating/pins não movidos) cai no cascade ao apagar as origens.
    await db.conversationRead.deleteMany({ where: { conversationId: { in: sourceIds } } });

    const merged = mergedFields(target, sources);

    await db.conversation.deleteMany({ where: { id: { in: sourceIds } } });
    await db.conversation.update({ where: { id: target.id }, data: merged.data });
    await db.conversationAuditLog.create({
      data: {
        conversationId: target.id,
        action: 'MERGED',
        fromValue: target.status,
        toValue: merged.status,
        metadata: {
          trigger: 'members_contact_merge',
          mergedConversationIds: sourceIds,
          movedMessages,
          droppedDuplicateMessages: droppedMessages,
        },
      },
    });

    return { targetId: target.id, sourceIds, movedMessages, droppedMessages };
  }
}

function byRecencyDesc(a: Conversation, b: Conversation): number {
  const la = a.lastMessageAt?.getTime() ?? -Infinity;
  const lb = b.lastMessageAt?.getTime() ?? -Infinity;
  if (la !== lb) return lb - la;
  return b.createdAt.getTime() - a.createdAt.getTime();
}

/** Campos do alvo depois do merge (puro — testável). */
export function mergedFields(
  target: Conversation,
  sources: Conversation[],
): { status: ConversationStatus; data: Prisma.ConversationUncheckedUpdateInput } {
  const all = [target, ...sources]; // já ordenado do mais recente pro mais antigo
  const active = all.filter((c) => c.status !== ConversationStatus.CLOSED);

  const data: Prisma.ConversationUncheckedUpdateInput = {};
  let status = target.status;
  if (active.length) {
    status = active.reduce(
      (best, c) => (STATUS_RANK[c.status] > STATUS_RANK[best] ? c.status : best),
      active[0].status,
    );
    data.status = status;
    data.closedAt = null;
    data.assignedToId =
      target.assignedToId ?? active.find((c) => c.assignedToId)?.assignedToId ?? null;
  } else {
    data.closedAt = maxDate(all.map((c) => c.closedAt)) ?? target.closedAt;
  }

  data.lastMessageAt = maxDate(all.map((c) => c.lastMessageAt));
  data.firstResponseAt = minDate(all.map((c) => c.firstResponseAt));
  data.createdAt = minDate(all.map((c) => c.createdAt)) ?? target.createdAt;
  data.externalThreadId =
    target.externalThreadId ?? sources.find((s) => s.externalThreadId)?.externalThreadId ?? null;

  // Rastreio: todos os ids de conversa do members vistos (mais antigo → mais
  // recente) + ids das conversas fundidas.
  const meta = { ...((target.metadata ?? {}) as Record<string, unknown>) };
  let ids: string[] = [];
  for (const c of [...all].reverse()) {
    for (const id of seenMembersIds((c.metadata ?? {}) as Record<string, unknown>, c.externalThreadId)) {
      ids = appendMembersId(ids, id);
    }
  }
  if (data.externalThreadId) ids = appendMembersId(ids, data.externalThreadId as string);
  meta.membersConversationIds = ids;
  const lastActivity = maxDate([
    ...all.map((c) => c.lastMessageAt),
    ...all.map((c) => parseDate(((c.metadata ?? {}) as Record<string, unknown>).membersLastActivityAt)),
  ]);
  if (lastActivity) meta.membersLastActivityAt = lastActivity.toISOString();
  const prevMerged = Array.isArray(meta.mergedConversationIds)
    ? (meta.mergedConversationIds as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  meta.mergedConversationIds = [...prevMerged, ...sources.map((s) => s.id)].slice(-MEMBERS_IDS_CAP);
  data.metadata = meta as Prisma.InputJsonValue;

  return { status, data };
}

function maxDate(dates: (Date | null | undefined)[]): Date | null {
  let best: Date | null = null;
  for (const d of dates) if (d && (!best || d > best)) best = d;
  return best;
}

function minDate(dates: (Date | null | undefined)[]): Date | null {
  let best: Date | null = null;
  for (const d of dates) if (d && (!best || d < best)) best = d;
  return best;
}
