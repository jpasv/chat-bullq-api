import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Logger, OnModuleInit } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { LeadOnboardingService } from './lead-onboarding.service';
import { LeadOnboardingConfigService } from './lead-onboarding-config.service';
import { OnboardingHumanAlertService } from './onboarding-human-alert.service';
import { ONBOARDING_TICK_JOB, ONBOARDING_TICK_QUEUE } from './lead-onboarding.constants';

/**
 * Repeat job que executa as ações vencidas dos leads (1ª tentativa, follow-ups,
 * inativação, retomada e resumo). Estado todo no banco → sobrevive a restart
 * sem precisar cancelar jobs atrasados quando o lead responde.
 */
@Processor(ONBOARDING_TICK_QUEUE, { concurrency: 1 })
export class LeadOnboardingTickCron extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(LeadOnboardingTickCron.name);

  constructor(
    private readonly onboarding: LeadOnboardingService,
    private readonly config: LeadOnboardingConfigService,
    private readonly alerts: OnboardingHumanAlertService,
    @InjectQueue(ONBOARDING_TICK_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.queue.add(
        ONBOARDING_TICK_JOB,
        {},
        {
          repeat: { pattern: this.config.tickPattern },
          jobId: 'lead-onboarding-tick-cron',
          removeOnComplete: 10,
          removeOnFail: 10,
        },
      );
      this.logger.log(`lead_onboarding_tick_registered pattern=${this.config.tickPattern}`);
    } catch (err) {
      this.logger.error(`Falha registrando cron do onboarding: ${(err as Error).message}`);
    }
  }

  async process(_job: Job): Promise<{ processed: number }> {
    const r = await this.onboarding.tick();
    if (r.processed > 0) this.logger.log(`Onboarding tick: processed=${r.processed}`);
    try {
      const alerted = await this.alerts.run();
      if (alerted > 0) this.logger.log(`Onboarding tick: human_alerts=${alerted}`);
    } catch (err) {
      this.logger.warn(`Alertas humanos falharam: ${(err as Error).message}`);
    }
    return r;
  }
}
