import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { RealtimeModule } from '../realtime/realtime.module';
import { LlmModule } from '../ai-agents/llm/llm.module';
import { GoogleAuthService } from '../ai-agents/tools/client-ops/google-auth.service';
import { LeadOnboardingConfigService } from './lead-onboarding-config.service';
import { LeadOnboardingRepository } from './lead-onboarding.repository';
import { HoppeLeadsClient } from './hoppe-leads.client';
import { HoppeChatClient } from './hoppe-chat.client';
import { OnboardingHumanAlertService } from './onboarding-human-alert.service';
import { OnboardingHumanResumeService } from './onboarding-human-resume.service';
import { OnboardingMessengerService } from './onboarding-messenger.service';
import { OnboardingSummaryService } from './onboarding-summary.service';
import { LeadOnboardingService } from './lead-onboarding.service';
import { LeadOnboardingTickCron } from './lead-onboarding-tick.cron';
import { DiagnosticCalendarService } from './diagnostic-calendar.service';
import { HoppeWebhookController } from './hoppe-webhook.controller';
import { ONBOARDING_TICK_QUEUE } from './lead-onboarding.constants';

/**
 * Onboarding pós-venda: tag `abordar-ia` no Hoppe → 3 tentativas pelo
 * WhatsApp 1258 → assistente virtual qualifica e agenda o Diagnóstico de IA
 * com o Pedro. Exporta o service (hook de inbound) e a agenda (tools).
 */
@Module({
  imports: [
    BullModule.registerQueue({ name: ONBOARDING_TICK_QUEUE }, { name: 'outbound-messages' }),
    RealtimeModule,
    LlmModule,
  ],
  controllers: [HoppeWebhookController],
  providers: [
    LeadOnboardingConfigService,
    LeadOnboardingRepository,
    HoppeLeadsClient,
    HoppeChatClient,
    OnboardingHumanAlertService,
    OnboardingHumanResumeService,
    OnboardingMessengerService,
    OnboardingSummaryService,
    LeadOnboardingService,
    LeadOnboardingTickCron,
    GoogleAuthService,
    DiagnosticCalendarService,
  ],
  exports: [
    LeadOnboardingService,
    DiagnosticCalendarService,
    LeadOnboardingConfigService,
    OnboardingMessengerService,
  ],
})
export class LeadOnboardingModule {}
