import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { OutboxEventStatus } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { AUTOMATION_QUEUE } from '../automations.constants';
import { AutomationJobData } from '../automations.types';
import { KillSwitchService } from '../kill-switch.service';
import { AutomationExecutorService } from '../engine/automation-executor.service';
import { WebhookDispatchService } from '../../webhooks/webhook-dispatch.service';

// PR2 worker: full executor wired in. The poller fed us the event; we
// hand it to the executor which finds matching rules, evaluates conditions,
// acquires per-contact lock, runs actions, writes a run row.
//
// Marking the outbox row PROCESSED is the LAST thing we do — if the
// executor throws (transient lock contention, DB blip), we re-throw so
// BullMQ retries with backoff. Outbox status only flips on clean exit.
@Processor(AUTOMATION_QUEUE, { concurrency: 4 })
export class AutomationEventProcessor extends WorkerHost {
  private readonly logger = new Logger(AutomationEventProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly killSwitch: KillSwitchService,
    private readonly executor: AutomationExecutorService,
    private readonly webhookDispatch: WebhookDispatchService,
  ) {
    super();
  }

  async process(job: Job<AutomationJobData>): Promise<void> {
    const { outboxEventId } = job.data;

    // Non-blocking fan-out: notify external webhook subscribers of this
    // outbox event in parallel with automation processing. Must never
    // throw out of process() — a webhook delivery failure is not an
    // automation failure and must not trigger BullMQ retries here.
    try {
      await this.webhookDispatch.dispatch({
        outboxEventId: job.data.outboxEventId,
        organizationId: job.data.organizationId,
        trigger: job.data.trigger,
        payload: job.data.payload,
      });
    } catch (err) {
      this.logger.warn(`webhook dispatch falhou (outbox=${job.data.outboxEventId}): ${(err as Error).message}`);
    }

    if (!this.killSwitch.isEnabled()) {
      await this.markProcessed(outboxEventId, 'kill_switch_disabled');
      return;
    }

    try {
      await this.executor.execute(job.data);
      await this.markProcessed(outboxEventId, null);
    } catch (err) {
      const msg = (err as Error).message;
      this.logger.warn(
        `executor threw for outbox=${outboxEventId}, will retry: ${msg}`,
      );
      // Bubble up — BullMQ retries (3 attempts, exp backoff). After
      // attempts exhausted, the job lands in failed state and the
      // outbox row stays PROCESSING with an expired lease, eligible
      // to be re-claimed by the poller. That's the recovery path.
      await this.prisma.outboxEvent.updateMany({
        where: { id: outboxEventId },
        data: { lastError: msg.slice(0, 500) },
      });
      throw err;
    }
  }

  private async markProcessed(outboxEventId: string, note: string | null) {
    await this.prisma.outboxEvent.update({
      where: { id: outboxEventId },
      data: {
        status: OutboxEventStatus.PROCESSED,
        processedAt: new Date(),
        lastError: note,
      },
    });
  }
}
