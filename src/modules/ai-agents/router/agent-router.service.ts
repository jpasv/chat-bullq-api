import { Injectable, Logger } from '@nestjs/common';
import { Conversation, Organization } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';

interface BusinessHoursDay {
  enabled: boolean;
  windows?: Array<[string, string]>; // [["09:00","18:00"]]
}
type BusinessHoursConfig = Record<string, BusinessHoursDay>;

const DAY_KEYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

@Injectable()
export class AgentRouterService {
  private readonly logger = new Logger(AgentRouterService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Decides whether the AI should react to an inbound message. Returns
   * `null` if it should not, or the resolved active agent for the run.
   * The runner does the actual execution.
   */
  async shouldHandle(conversation: Conversation): Promise<{
    handle: boolean;
    reason?: string;
  }> {
    // Tri-state conversation override:
    //   conv.aiEnabled === false → forçada OFF, NÃO roda mesmo com tudo ligado
    //   conv.aiEnabled === true  → forçada ON, sobrepõe org/horário
    //   conv.aiEnabled === null  → segue regras globais
    const convOverride = conversation.aiEnabled;

    if (convOverride === false) {
      return { handle: false, reason: 'conversation.aiEnabled=force-off' };
    }

    // Carrega org pra checagens globais (e cap de token mais abaixo).
    const org = await this.prisma.organization.findUnique({
      where: { id: conversation.organizationId },
    });
    if (!org) return { handle: false, reason: 'org-not-found' };

    if (convOverride !== true) {
      // Não tem override pra ON → regras globais valem.
      if (!org.aiEnabled) {
        return { handle: false, reason: 'org.aiEnabled=false' };
      }
      if (!this.isWithinBusinessHours(org)) {
        return { handle: false, reason: 'outside-business-hours' };
      }
    }

    // Mesmo com override pra ON, ainda precisa existir um agente ativo
    // pra atender essa conversa. Sem isso, não tem o que rodar.
    if (!conversation.activeAgentId) {
      const link = await this.prisma.aiAgentChannel.findFirst({
        where: {
          channelId: conversation.channelId,
          mode: 'AUTONOMOUS',
          agent: { isActive: true, deletedAt: null },
        },
      });
      if (!link) {
        return { handle: false, reason: 'no-agent-for-channel' };
      }
    }

    // Cap mensal vale sempre — proteção de orçamento, não dá pra furar.
    if (org.aiMonthlyTokenCap) {
      const startOfMonth = new Date();
      startOfMonth.setDate(1);
      startOfMonth.setHours(0, 0, 0, 0);

      const used = await this.prisma.aiAgentRun.aggregate({
        where: {
          organizationId: org.id,
          startedAt: { gte: startOfMonth },
        },
        _sum: { inputTokens: true, outputTokens: true },
      });
      const total =
        (used._sum.inputTokens ?? 0) + (used._sum.outputTokens ?? 0);
      if (total >= org.aiMonthlyTokenCap) {
        return { handle: false, reason: 'monthly-token-cap-reached' };
      }
    }

    return { handle: true };
  }

  private isWithinBusinessHours(org: Organization): boolean {
    if (!org.aiBusinessHours) return true; // 24/7 default

    const config = org.aiBusinessHours as unknown as BusinessHoursConfig;
    const tz = org.aiTimezone || 'America/Sao_Paulo';

    // Get day-of-week + HH:mm in the org's tz.
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'long',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const parts = fmt.formatToParts(new Date());
    const weekday = parts
      .find((p) => p.type === 'weekday')
      ?.value.toLowerCase() ?? '';
    const hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
    const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
    const nowMinutes = parseInt(hour, 10) * 60 + parseInt(minute, 10);

    if (!DAY_KEYS.includes(weekday as (typeof DAY_KEYS)[number])) {
      return true;
    }
    const day = config[weekday];
    if (!day || !day.enabled) return false;

    const windows = day.windows ?? [];
    if (windows.length === 0) return true;

    return windows.some(([from, to]) => {
      const fromMin = this.parseHourToMinutes(from);
      const toMin = this.parseHourToMinutes(to);
      return nowMinutes >= fromMin && nowMinutes < toMin;
    });
  }

  private parseHourToMinutes(hhmm: string): number {
    const [h, m] = hhmm.split(':').map((v) => parseInt(v, 10));
    return (h || 0) * 60 + (m || 0);
  }
}
