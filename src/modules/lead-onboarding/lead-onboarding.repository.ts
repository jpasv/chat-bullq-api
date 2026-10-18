import { Injectable } from '@nestjs/common';
import { OnboardingLead, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { OnboardingState } from './lead-onboarding.constants';

/** Acesso à tabela onboarding_leads. Sem regra de negócio — isso é do service. */
@Injectable()
export class LeadOnboardingRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Registra o lead vindo da tag `abordar-ia`. Idempotente por task: se já
   * existe (em qualquer estado, inclusive OPTED_OUT/PAUSED), não mexe.
   */
  async enqueueFromTag(
    organizationId: string,
    hoppeTaskId: string,
  ): Promise<'created' | 'exists'> {
    const existing = await this.prisma.onboardingLead.findUnique({
      where: { hoppeTaskId },
    });
    if (existing) return 'exists';
    try {
      await this.prisma.onboardingLead.create({
        data: {
          organizationId,
          hoppeTaskId,
          state: 'PENDING',
          nextActionAt: new Date(),
        },
      });
      return 'created';
    } catch (err) {
      // Corrida entre duas entregas do mesmo webhook.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        return 'exists';
      }
      throw err;
    }
  }

  findDue(states: OnboardingState[], now: Date, take = 50): Promise<OnboardingLead[]> {
    return this.prisma.onboardingLead.findMany({
      where: { state: { in: states }, nextActionAt: { lte: now } },
      orderBy: { nextActionAt: 'asc' },
      take,
    });
  }

  findSummaryDue(now: Date, take = 20): Promise<OnboardingLead[]> {
    return this.prisma.onboardingLead.findMany({
      where: {
        state: { in: ['REPLIED', 'SCHEDULED', 'DISQUALIFIED', 'PAUSED', 'OPTED_OUT'] },
        summaryDueAt: { lte: now },
      },
      orderBy: { summaryDueAt: 'asc' },
      take,
    });
  }

  findByConversation(conversationId: string): Promise<OnboardingLead | null> {
    return this.prisma.onboardingLead.findFirst({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
    });
  }

  findById(id: string): Promise<OnboardingLead | null> {
    return this.prisma.onboardingLead.findUnique({ where: { id } });
  }

  /** Quantas 1ªs mensagens já saíram desde `since` (teto diário). */
  countFirstAttemptsSince(since: Date): Promise<number> {
    return this.prisma.onboardingLead.count({
      where: { firstAttemptAt: { gte: since } },
    });
  }

  update(id: string, data: Prisma.OnboardingLeadUpdateInput): Promise<OnboardingLead> {
    return this.prisma.onboardingLead.update({ where: { id }, data });
  }
}
