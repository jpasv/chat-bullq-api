import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Logger, OnModuleInit } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { SalesRecoveryService } from './sales-recovery.service';
import { RecoveryCardsRepository } from './recovery-cards.repository';
import { RecoveryConfigService } from './recovery-config.service';
import {
  RECOVERY_WATCHDOG_QUEUE,
  RECOVERY_WATCHDOG_JOB,
} from './sales-recovery.constants';

/**
 * Varre periodicamente os cards parados nas stages "vivas" (Tentativa de
 * Contato, Em Contato, Follow Up) e os escala: manda follow-up e move pra
 * "Follow Up" ou, esgotadas as tentativas, pra "Perdido".
 *
 * Mesmo padrão do WatchdogCronService: registra um job repeat no boot e
 * processa o scan no worker (não processa no onModuleInit).
 */
@Processor(RECOVERY_WATCHDOG_QUEUE, { concurrency: 1 })
export class RecoveryWatchdogCron extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(RecoveryWatchdogCron.name);

  constructor(
    private readonly recovery: SalesRecoveryService,
    private readonly repo: RecoveryCardsRepository,
    private readonly config: RecoveryConfigService,
    @InjectQueue(RECOVERY_WATCHDOG_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.queue.add(
        RECOVERY_WATCHDOG_JOB,
        {},
        {
          repeat: { pattern: this.config.watchdogPattern },
          jobId: 'recovery-watchdog-cron',
          removeOnComplete: 10,
          removeOnFail: 10,
        },
      );
      this.logger.log(
        `recovery_watchdog_cron_registered pattern=${this.config.watchdogPattern}`,
      );
    } catch (err) {
      this.logger.error(
        `Falha registrando cron do recovery watchdog: ${(err as Error).message}`,
      );
    }
  }

  async process(_job: Job): Promise<{ scanned: number; escalated: number }> {
    const organizationId = this.config.orgId;
    if (!organizationId) return { scanned: 0, escalated: 0 };

    // Stages "vivas" + threshold de silêncio (1ª cadência de follow-up).
    let stageIds: string[];
    try {
      stageIds = await Promise.all([
        this.repo.resolveStageId(organizationId, 'contact_attempt'),
        this.repo.resolveStageId(organizationId, 'in_contact'),
        this.repo.resolveStageId(organizationId, 'follow_up'),
      ]);
    } catch (err) {
      this.logger.warn(
        `Recovery watchdog sem pipeline configurado: ${(err as Error).message}`,
      );
      return { scanned: 0, escalated: 0 };
    }

    const hours = this.config.followUpHours[0] ?? 24;
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);

    const cards = await this.repo.findStuckCards(
      organizationId,
      stageIds,
      cutoff,
    );

    let escalated = 0;
    for (const card of cards) {
      try {
        const r = await this.recovery.escalateStuckCard(organizationId, card.id);
        if (r !== 'skipped') escalated++;
      } catch (err) {
        this.logger.warn(
          `Escalada falhou pro card ${card.id}: ${(err as Error).message}`,
        );
      }
    }

    if (cards.length > 0) {
      this.logger.log(
        `Recovery watchdog: scanned=${cards.length} escalated=${escalated}`,
      );
    }
    return { scanned: cards.length, escalated };
  }
}
