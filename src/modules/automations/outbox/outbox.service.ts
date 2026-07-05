import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AutomationTrigger, Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import {
  AutomationEventPayload,
  TriggerToPayload,
} from '../automations.types';

// Subset of PrismaClient that the outbox needs. Accepting this instead of
// the full client lets callers pass either `this.prisma` or a transactional
// client `tx` from inside `prisma.$transaction(async tx => ...)` — both
// work without type gymnastics.
type PrismaTxOrClient = Prisma.TransactionClient | PrismaService;

interface EnqueueOptions {
  // Forwarded from a parent event when this enqueue happens inside an
  // automation action handler (cascade). Otherwise the service generates
  // a fresh trace and starts at depth 0.
  traceId?: string;
  cascadeDepth?: number;
  // Optional override. If not provided we derive a sane key per trigger
  // (see `deriveDedupKey`). The unique index on `dedup_key` makes
  // re-deliveries collapse — webhook retries, double clicks, etc.
  dedupKey?: string | null;
}

@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  constructor(private readonly prisma: PrismaService) {}

  // Primary API: write an event row inside a domain transaction so the
  // event only "exists" if the mutation that produced it commits. The poll
  // loop picks it up shortly after.
  //
  // Usage from a service:
  //   await this.prisma.$transaction(async (tx) => {
  //     await tx.conversationTag.create({ ... });
  //     await this.outbox.enqueue(tx, AutomationTrigger.TAG_ADDED, payload);
  //   });
  async enqueue<T extends AutomationTrigger>(
    txOrClient: PrismaTxOrClient,
    trigger: T,
    payload: TriggerToPayload[T],
    options: EnqueueOptions = {},
  ): Promise<void> {
    if (!payload.organizationId) {
      // Hard fail: events without org would be impossible to filter at the
      // worker. Surface this loudly during dev rather than silently drop.
      throw new Error(`Outbox payload missing organizationId for ${trigger}`);
    }
    if (!payload.contactId) {
      // contactId is the lock key. Without it the worker can't serialize
      // executions on the lead — better to fail at write time.
      throw new Error(
        `Outbox payload missing contactId for ${trigger} — every event MUST resolve to a contact`,
      );
    }

    const traceId = options.traceId ?? randomUUID();
    const cascadeDepth = options.cascadeDepth ?? 0;
    const dedupKey =
      options.dedupKey === undefined
        ? this.deriveDedupKey(trigger, payload)
        : options.dedupKey;

    try {
      await txOrClient.outboxEvent.create({
        data: {
          organizationId: payload.organizationId,
          trigger,
          payload: payload as unknown as Prisma.InputJsonValue,
          dedupKey,
          traceId,
          cascadeDepth,
          actorId: payload.actorId ?? null,
        },
      });
    } catch (err) {
      // Unique violation on dedupKey = re-delivery, intentionally silent.
      // Anything else bubbles up so the caller's transaction rolls back.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        this.logger.debug(
          `outbox dedup hit ${trigger} key=${dedupKey ?? 'null'} — skipping`,
        );
        return;
      }
      throw err;
    }
  }

  // Best-effort variant for legacy call sites that don't yet wrap their
  // mutations in a Prisma transaction. Marked deprecated so future readers
  // know to migrate. Kept narrow on purpose: only used during PR 1
  // rollout when retrofitting transactions everywhere is too risky.
  /** @deprecated Prefer `enqueue` inside `prisma.$transaction`. */
  async enqueuePostCommit<T extends AutomationTrigger>(
    trigger: T,
    payload: TriggerToPayload[T],
    options: EnqueueOptions = {},
  ): Promise<void> {
    return this.enqueue(this.prisma, trigger, payload, options);
  }

  // Conservative defaults. Each trigger picks a key that should be unique
  // per "logical occurrence", so a webhook re-delivery produces the same
  // key and the unique index drops the duplicate.
  //
  // We DO NOT include a timestamp here — that would defeat dedup. We DO
  // include enough entity ids to discriminate between distinct events.
  private deriveDedupKey<T extends AutomationTrigger>(
    trigger: T,
    payload: TriggerToPayload[T],
  ): string | null {
    switch (trigger) {
      case AutomationTrigger.TAG_ADDED:
      case AutomationTrigger.TAG_REMOVED: {
        const p = payload as TriggerToPayload[
          | typeof AutomationTrigger.TAG_ADDED
          | typeof AutomationTrigger.TAG_REMOVED];
        // Adding/removing a (tag, target) pair is naturally idempotent —
        // doing it twice is a no-op at the domain layer too.
        return `${trigger}:${p.target}:${p.target === 'conversation' ? p.conversationId : p.contactId}:${p.tagId}`;
      }
      case AutomationTrigger.MESSAGE_RECEIVED: {
        const p = payload as TriggerToPayload[typeof AutomationTrigger.MESSAGE_RECEIVED];
        // messageId is unique in our DB — perfect dedup key.
        return `MESSAGE_RECEIVED:${p.messageId}`;
      }
      case AutomationTrigger.CONVERSATION_STATUS_CHANGED: {
        const p = payload as TriggerToPayload[typeof AutomationTrigger.CONVERSATION_STATUS_CHANGED];
        // Two real, sequential status changes need to fire as distinct
        // events. Including a fresh UUID here means dedup is OFF for this
        // trigger and we rely on the FSM to enforce uniqueness — there's
        // no double-emit path that I can see today, and a future bug here
        // would surface as duplicate runs (visible) instead of lost ones.
        return null;
      }
      case AutomationTrigger.CONVERSATION_ASSIGNED: {
        return null;
      }
      case AutomationTrigger.CONVERSATION_CREATED: {
        const p = payload as TriggerToPayload[typeof AutomationTrigger.CONVERSATION_CREATED];
        return `CONVERSATION_CREATED:${p.conversationId}`;
      }
    }
    return null;
  }
}
