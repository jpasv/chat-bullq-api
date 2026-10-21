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

  /**
   * Claim atômico da ação vencida: só um tick (ou réplica) passa daqui pro
   * mesmo lead. Compara com o retrato lido — se o estado mudou no meio do
   * lote (respondeu, opt-out, pausa), não processa.
   */
  /** Comprou a Consultoria Individual (Kirvano, venda aprovada) pelo e-mail ou telefone? */
  async boughtConsultoria(email: string | null, phone: string | null): Promise<boolean> {
    const tail = (phone ?? '').replace(/\D/g, '').slice(-8) || '---';
    const rows = await this.prisma.$queryRaw<Array<{ ok: number }>>`
      SELECT 1 AS ok FROM kirvano_events k
      WHERE k.event = 'SALE_APPROVED'
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(k.payload->'products') p WHERE p->>'name' ILIKE '%consultoria individual%')
        AND (lower(k.payload->'customer'->>'email') = lower(${email ?? '---'}) OR right(k.payload->'customer'->>'phone_number', 8) = ${tail})
      LIMIT 1`;
    return rows.length > 0;
  }

  async claim(lead: OnboardingLead): Promise<boolean> {
    const r = await this.prisma.onboardingLead.updateMany({
      where: {
        id: lead.id,
        state: lead.state,
        attempt: lead.attempt,
        nextActionAt: lead.nextActionAt,
      },
      data: { nextActionAt: null },
    });
    return r.count === 1;
  }

  /** Update condicional ao estado atual. Retorna false se o estado já mudou. */
  async updateIfState(
    id: string,
    states: OnboardingState[],
    data: Prisma.OnboardingLeadUpdateManyMutationInput,
  ): Promise<boolean> {
    const r = await this.prisma.onboardingLead.updateMany({
      where: { id, state: { in: states } },
      data,
    });
    return r.count === 1;
  }

  update(id: string, data: Prisma.OnboardingLeadUpdateInput): Promise<OnboardingLead> {
    return this.prisma.onboardingLead.update({ where: { id }, data });
  }
}
