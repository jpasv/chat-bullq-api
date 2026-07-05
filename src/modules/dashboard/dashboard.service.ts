import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

export interface DateRange {
  from: Date;
  to: Date;
}

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Barreira de atribuição (RN-05): quando `assignedToId` está setado (AGENT),
   * o fragmento força `assignedToId = <userId>` na conversa; quando undefined
   * (OWNER/ADMIN), não adiciona nada e a métrica cobre a org inteira.
   */
  private convScope(assignedToId?: string): { assignedToId?: string } {
    return assignedToId ? { assignedToId } : {};
  }

  /** Mesma barreira aplicada a queries de Message/Rating/Tag via a relação. */
  private relScope(
    assignedToId?: string,
  ): { assignedToId?: string } {
    return assignedToId ? { assignedToId } : {};
  }

  async getOverview(
    organizationId: string,
    range: DateRange,
    assignedToId?: string,
  ) {
    const scope = this.convScope(assignedToId);
    const where = {
      organizationId,
      ...scope,
      createdAt: { gte: range.from, lte: range.to },
    };
    const prevFrom = new Date(range.from.getTime() - (range.to.getTime() - range.from.getTime()));
    const prevWhere = {
      organizationId,
      ...scope,
      createdAt: { gte: prevFrom, lte: range.from },
    };

    const [
      totalConversations,
      prevTotal,
      openConversations,
      pendingConversations,
      waitingConversations,
      botConversations,
      stuckConversations,
      totalMessages,
      prevMessages,
      closedInPeriod,
      prevClosedInPeriod,
    ] = await this.prisma.$transaction([
      this.prisma.conversation.count({ where }),
      this.prisma.conversation.count({ where: prevWhere }),
      this.prisma.conversation.count({ where: { organizationId, ...scope, status: 'OPEN' } }),
      this.prisma.conversation.count({ where: { organizationId, ...scope, status: 'PENDING' } }),
      this.prisma.conversation.count({ where: { organizationId, ...scope, status: 'WAITING' } }),
      this.prisma.conversation.count({ where: { organizationId, ...scope, status: 'BOT' } }),
      this.prisma.conversation.count({
        where: { organizationId, ...scope, isStuck: true, deletedAt: null },
      }),
      this.prisma.message.count({ where: { conversation: { organizationId, ...scope }, createdAt: { gte: range.from, lte: range.to } } }),
      this.prisma.message.count({ where: { conversation: { organizationId, ...scope }, createdAt: { gte: prevFrom, lte: range.from } } }),
      this.prisma.conversation.count({
        where: { organizationId, ...scope, status: 'CLOSED', closedAt: { gte: range.from, lte: range.to } },
      }),
      this.prisma.conversation.count({
        where: { organizationId, ...scope, status: 'CLOSED', closedAt: { gte: prevFrom, lte: range.from } },
      }),
    ]);

    const [avgFirstResponse, prevAvgFirstResponse] = await Promise.all([
      this.getAvgFirstResponseTime(organizationId, range, assignedToId),
      this.getAvgFirstResponseTime(organizationId, { from: prevFrom, to: range.from }, assignedToId),
    ]);
    const avgResolution = await this.getAvgResolutionTime(organizationId, range, assignedToId);
    const [slaCompliance, prevSlaCompliance] = await Promise.all([
      this.getSlaCompliance(organizationId, range, assignedToId),
      this.getSlaCompliance(organizationId, { from: prevFrom, to: range.from }, assignedToId),
    ]);

    const [closedNoReopen, csatAgg, prevCsatAgg] = await Promise.all([
      this.prisma.conversation.count({
        where: {
          organizationId, ...scope, status: 'CLOSED',
          closedAt: { gte: range.from, lte: range.to },
          reopenedCount: 0,
        },
      }),
      this.prisma.conversationRating.aggregate({
        where: { organizationId, conversation: this.relScope(assignedToId), respondedAt: { gte: range.from, lte: range.to } },
        _avg: { score: true },
        _count: { _all: true },
      }),
      this.prisma.conversationRating.aggregate({
        where: { organizationId, conversation: this.relScope(assignedToId), respondedAt: { gte: prevFrom, lte: range.from } },
        _avg: { score: true },
      }),
    ]);

    const fcrPercent =
      closedInPeriod > 0 ? Math.round((closedNoReopen / closedInPeriod) * 100) : null;
    const csatScore = csatAgg._avg.score !== null ? Math.round(csatAgg._avg.score * 10) / 10 : null;
    const prevCsatScore = prevCsatAgg._avg.score;
    const csatTrend =
      csatScore !== null && prevCsatScore !== null
        ? Math.round((csatScore - prevCsatScore) * 10) / 10
        : 0;

    const activeConversations = openConversations + pendingConversations + waitingConversations;

    const resolutionRatePercent =
      totalConversations > 0 ? Math.round((closedInPeriod / totalConversations) * 100) : null;
    const prevResolutionRatePercent = prevTotal > 0 ? (prevClosedInPeriod / prevTotal) * 100 : null;

    return {
      activeConversations,
      activeBreakdown: {
        pending: pendingConversations,
        open: openConversations,
        waiting: waitingConversations,
        bot: botConversations,
      },
      stuckConversations,

      avgFirstResponseMinutes: avgFirstResponse,
      avgFirstResponseTrend:
        avgFirstResponse !== null && prevAvgFirstResponse !== null
          ? this.calcTrend(avgFirstResponse, prevAvgFirstResponse)
          : 0,

      slaCompliancePercent: slaCompliance,
      slaTrend:
        slaCompliance !== null && prevSlaCompliance !== null
          ? slaCompliance - prevSlaCompliance
          : 0,

      resolutionRatePercent,
      resolutionTrend:
        resolutionRatePercent !== null && prevResolutionRatePercent !== null
          ? Math.round(resolutionRatePercent - prevResolutionRatePercent)
          : 0,

      fcrPercent,
      csatScore,
      csatResponses: csatAgg._count._all,
      csatTrend,

      totalConversations,
      conversationsTrend: this.calcTrend(totalConversations, prevTotal),
      openConversations,
      pendingConversations,
      totalMessages,
      messagesTrend: this.calcTrend(totalMessages, prevMessages),
      avgResolutionMinutes: avgResolution,
    };
  }

  async getKpiSparklines(
    organizationId: string,
    range: DateRange,
    assignedToId?: string,
  ) {
    const dept = await this.prisma.department.findFirst({
      where: { organizationId, isDefault: true },
      select: { slaFirstResponse: true },
    });
    const slaMinutes = dept?.slaFirstResponse ?? null;

    const conversations = await this.prisma.conversation.findMany({
      where: { organizationId, ...this.convScope(assignedToId), createdAt: { gte: range.from, lte: range.to } },
      select: { createdAt: true, firstResponseAt: true, closedAt: true, status: true },
    });

    const dayKeys = this.eachDay(range.from, range.to);
    const buckets = new Map<
      string,
      { created: number; closed: number; tmrSum: number; tmrCount: number; slaWithin: number; slaCount: number }
    >();
    for (const k of dayKeys) {
      buckets.set(k, { created: 0, closed: 0, tmrSum: 0, tmrCount: 0, slaWithin: 0, slaCount: 0 });
    }

    for (const c of conversations) {
      const k = c.createdAt.toISOString().slice(0, 10);
      const b = buckets.get(k);
      if (!b) continue;
      b.created++;
      if (c.firstResponseAt) {
        const minutes = (c.firstResponseAt.getTime() - c.createdAt.getTime()) / 60000;
        b.tmrSum += minutes;
        b.tmrCount++;
        if (slaMinutes !== null) {
          b.slaCount++;
          if (minutes <= slaMinutes) b.slaWithin++;
        }
      }
      if (c.status === 'CLOSED' && c.closedAt && c.closedAt >= range.from && c.closedAt <= range.to) {
        b.closed++;
      }
    }

    const active = dayKeys.map((d) => ({ date: d, value: buckets.get(d)!.created }));
    const firstResponse = dayKeys.map((d) => {
      const b = buckets.get(d)!;
      return { date: d, value: b.tmrCount > 0 ? Math.round(b.tmrSum / b.tmrCount) : 0 };
    });
    const sla = dayKeys.map((d) => {
      const b = buckets.get(d)!;
      return { date: d, value: b.slaCount > 0 ? Math.round((b.slaWithin / b.slaCount) * 100) : 0 };
    });
    const resolution = dayKeys.map((d) => {
      const b = buckets.get(d)!;
      return { date: d, value: b.created > 0 ? Math.round((b.closed / b.created) * 100) : 0 };
    });

    return { active, firstResponse, sla, resolution };
  }

  async getCsatBreakdown(
    organizationId: string,
    range: DateRange,
    assignedToId?: string,
  ) {
    const convFilter = this.relScope(assignedToId);
    const [agg, ratings, recent] = await Promise.all([
      this.prisma.conversationRating.aggregate({
        where: { organizationId, conversation: convFilter, respondedAt: { gte: range.from, lte: range.to } },
        _avg: { score: true },
        _count: { _all: true },
      }),
      this.prisma.conversationRating.groupBy({
        by: ['score'],
        where: { organizationId, conversation: convFilter, respondedAt: { gte: range.from, lte: range.to } },
        _count: true,
      }),
      this.prisma.conversationRating.findMany({
        where: {
          organizationId,
          conversation: convFilter,
          respondedAt: { gte: range.from, lte: range.to },
          comment: { not: null },
        },
        orderBy: { respondedAt: 'desc' },
        take: 5,
        select: {
          id: true, score: true, comment: true, respondedAt: true,
          conversation: { select: { contact: { select: { name: true } } } },
        },
      }),
    ]);

    const totalRequested = await this.prisma.conversationRating.count({
      where: { organizationId, conversation: convFilter, requestedAt: { gte: range.from, lte: range.to } },
    });

    const distribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const r of ratings) distribution[r.score] = r._count;

    return {
      avgScore: agg._avg.score !== null ? Math.round(agg._avg.score * 10) / 10 : null,
      totalResponses: agg._count._all,
      totalRequested,
      responseRate: totalRequested > 0
        ? Math.round((agg._count._all / totalRequested) * 100)
        : null,
      distribution,
      recentComments: recent.map((r) => ({
        id: r.id,
        score: r.score,
        comment: r.comment,
        respondedAt: r.respondedAt,
        contactName: r.conversation.contact.name,
      })),
    };
  }

  async getReopens(
    organizationId: string,
    range: DateRange,
    assignedToId?: string,
  ) {
    const scope = this.convScope(assignedToId);
    const reopened = await this.prisma.conversation.findMany({
      where: {
        organizationId,
        ...scope,
        reopenedCount: { gt: 0 },
        reopenedAt: { gte: range.from, lte: range.to },
      },
      select: {
        id: true,
        reopenedAt: true,
        reopenedCount: true,
        assignedTo: { select: { id: true, name: true } },
        contact: { select: { id: true, name: true } },
      },
    });

    const closedInPeriod = await this.prisma.conversation.count({
      where: { organizationId, ...scope, status: 'CLOSED', closedAt: { gte: range.from, lte: range.to } },
    });

    const dayKeys = this.eachDay(range.from, range.to);
    const series = new Map<string, number>(dayKeys.map((d) => [d, 0]));
    for (const c of reopened) {
      if (!c.reopenedAt) continue;
      const k = c.reopenedAt.toISOString().slice(0, 10);
      if (series.has(k)) series.set(k, series.get(k)! + 1);
    }

    const totalReopens = reopened.reduce((s, r) => s + r.reopenedCount, 0);
    const reopenRate = closedInPeriod > 0
      ? Math.round((reopened.length / (closedInPeriod + reopened.length)) * 100)
      : null;

    return {
      totalReopens,
      uniqueConversationsReopened: reopened.length,
      reopenRate,
      series: dayKeys.map((d) => ({ date: d, value: series.get(d)! })),
      worstOffenders: reopened
        .sort((a, b) => b.reopenedCount - a.reopenedCount)
        .slice(0, 5)
        .map((c) => ({
          conversationId: c.id,
          contactName: c.contact.name,
          agentName: c.assignedTo?.name ?? null,
          reopenedCount: c.reopenedCount,
        })),
    };
  }

  private eachDay(from: Date, to: Date): string[] {
    const days: string[] = [];
    const cur = new Date(from);
    cur.setUTCHours(0, 0, 0, 0);
    const end = new Date(to);
    end.setUTCHours(0, 0, 0, 0);
    while (cur <= end) {
      days.push(cur.toISOString().slice(0, 10));
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return days;
  }

  async getVolumeByDay(
    organizationId: string,
    range: DateRange,
    assignedToId?: string,
  ) {
    const conversations = await this.prisma.conversation.findMany({
      where: { organizationId, ...this.convScope(assignedToId), createdAt: { gte: range.from, lte: range.to } },
      select: { createdAt: true },
    });

    const byDay = new Map<string, number>();
    for (const c of conversations) {
      const day = c.createdAt.toISOString().slice(0, 10);
      byDay.set(day, (byDay.get(day) || 0) + 1);
    }

    return Array.from(byDay.entries())
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  async getVolumeByChannel(
    organizationId: string,
    range: DateRange,
    assignedToId?: string,
  ) {
    const result = await this.prisma.conversation.groupBy({
      by: ['channelId'],
      where: { organizationId, ...this.convScope(assignedToId), createdAt: { gte: range.from, lte: range.to } },
      _count: true,
    });

    const channels = await this.prisma.channel.findMany({
      where: { organizationId },
      select: { id: true, name: true, type: true },
    });

    return result.map((r) => {
      const ch = channels.find((c) => c.id === r.channelId);
      return { channelId: r.channelId, channelName: ch?.name || 'Unknown', channelType: ch?.type, count: r._count };
    });
  }

  async getVolumeByStatus(organizationId: string, assignedToId?: string) {
    const result = await this.prisma.conversation.groupBy({
      by: ['status'],
      where: { organizationId, ...this.convScope(assignedToId) },
      _count: true,
    });
    return result.map((r) => ({ status: r.status, count: r._count }));
  }

  async getAgentPerformance(
    organizationId: string,
    range: DateRange,
    assignedToId?: string,
  ) {
    // Barreira (RN-05): AGENT só vê a própria linha. `assignedToId: { not: null }`
    // já exclui não-atribuídas; quando escopado, força a igualdade ao userId.
    const assignedFilter: Prisma.StringNullableFilter | string = assignedToId
      ? assignedToId
      : { not: null };
    const [conversations, currentLoadGroups] = await Promise.all([
      this.prisma.conversation.findMany({
        where: {
          organizationId,
          assignedToId: assignedFilter,
          createdAt: { gte: range.from, lte: range.to },
        },
        select: {
          assignedToId: true,
          status: true,
          firstResponseAt: true,
          closedAt: true,
          createdAt: true,
          assignedTo: { select: { id: true, name: true, avatarUrl: true } },
        },
      }),
      this.prisma.conversation.groupBy({
        by: ['assignedToId'],
        where: {
          organizationId,
          assignedToId: assignedFilter,
          status: { in: ['OPEN', 'PENDING', 'WAITING'] },
        },
        _count: true,
      }),
    ]);

    const currentLoad = new Map<string, number>();
    for (const g of currentLoadGroups) {
      if (g.assignedToId) currentLoad.set(g.assignedToId, g._count);
    }

    const agentMap = new Map<string, {
      agent: { id: string; name: string; avatarUrl: string | null };
      total: number;
      closed: number;
      responseTimes: number[];
      resolutionTimes: number[];
    }>();

    for (const c of conversations) {
      if (!c.assignedToId || !c.assignedTo) continue;
      if (!agentMap.has(c.assignedToId)) {
        agentMap.set(c.assignedToId, {
          agent: c.assignedTo, total: 0, closed: 0, responseTimes: [], resolutionTimes: [],
        });
      }
      const a = agentMap.get(c.assignedToId)!;
      a.total++;
      if (c.status === 'CLOSED') {
        a.closed++;
        if (c.closedAt) {
          a.resolutionTimes.push((c.closedAt.getTime() - c.createdAt.getTime()) / 60000);
        }
      }
      if (c.firstResponseAt) {
        a.responseTimes.push((c.firstResponseAt.getTime() - c.createdAt.getTime()) / 60000);
      }
    }

    return Array.from(agentMap.values()).map((a) => ({
      agent: a.agent,
      totalConversations: a.total,
      closedConversations: a.closed,
      activeConversations: currentLoad.get(a.agent.id) ?? 0,
      resolutionRate: a.total > 0 ? Math.round((a.closed / a.total) * 100) : 0,
      avgFirstResponseMinutes: a.responseTimes.length
        ? Math.round(a.responseTimes.reduce((s, v) => s + v, 0) / a.responseTimes.length)
        : null,
      avgResolutionMinutes: a.resolutionTimes.length
        ? Math.round(a.resolutionTimes.reduce((s, v) => s + v, 0) / a.resolutionTimes.length)
        : null,
    }));
  }

  async getVolumeFlow(
    organizationId: string,
    range: DateRange,
    assignedToId?: string,
  ) {
    const conversations = await this.prisma.conversation.findMany({
      where: {
        organizationId,
        ...this.convScope(assignedToId),
        OR: [
          { createdAt: { gte: range.from, lte: range.to } },
          { closedAt: { gte: range.from, lte: range.to } },
        ],
      },
      select: { createdAt: true, closedAt: true },
    });

    const dayKeys = this.eachDay(range.from, range.to);
    const buckets = new Map<string, { created: number; closed: number }>();
    for (const k of dayKeys) buckets.set(k, { created: 0, closed: 0 });

    for (const c of conversations) {
      const ck = c.createdAt.toISOString().slice(0, 10);
      if (buckets.has(ck)) buckets.get(ck)!.created++;
      if (c.closedAt) {
        const dk = c.closedAt.toISOString().slice(0, 10);
        if (buckets.has(dk)) buckets.get(dk)!.closed++;
      }
    }

    return dayKeys.map((d) => ({ date: d, ...buckets.get(d)! }));
  }

  async getPeakHours(
    organizationId: string,
    range: DateRange,
    assignedToId?: string,
  ) {
    const conversations = await this.prisma.conversation.findMany({
      where: { organizationId, ...this.convScope(assignedToId), createdAt: { gte: range.from, lte: range.to } },
      select: { createdAt: true },
    });

    const matrix: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
    let max = 0;
    for (const c of conversations) {
      const dow = c.createdAt.getUTCDay();
      const hour = c.createdAt.getUTCHours();
      matrix[dow][hour]++;
      if (matrix[dow][hour] > max) max = matrix[dow][hour];
    }
    return { matrix, max };
  }

  async getMessagesFlow(
    organizationId: string,
    range: DateRange,
    assignedToId?: string,
  ) {
    const messages = await this.prisma.message.findMany({
      where: {
        conversation: { organizationId, ...this.relScope(assignedToId) },
        createdAt: { gte: range.from, lte: range.to },
      },
      select: { createdAt: true, direction: true },
    });

    const dayKeys = this.eachDay(range.from, range.to);
    const buckets = new Map<string, { inbound: number; outbound: number }>();
    for (const k of dayKeys) buckets.set(k, { inbound: 0, outbound: 0 });

    for (const m of messages) {
      const k = m.createdAt.toISOString().slice(0, 10);
      const b = buckets.get(k);
      if (!b) continue;
      if (m.direction === 'INBOUND') b.inbound++;
      else b.outbound++;
    }

    return dayKeys.map((d) => ({ date: d, ...buckets.get(d)! }));
  }

  async getBotPerformance(
    organizationId: string,
    range: DateRange,
    assignedToId?: string,
  ) {
    // Nota: pra um AGENT escopado, "botResolved" (conversas sem assignedTo)
    // será sempre 0 por construção — o AGENT só enxerga as próprias conversas
    // atribuídas. É o comportamento correto sob RN-05: ele não pode ver
    // métricas de bot que abrangem conversas de terceiros. OWNER/ADMIN veem
    // o quadro completo da org.
    const conversations = await this.prisma.conversation.findMany({
      where: { organizationId, ...this.convScope(assignedToId), createdAt: { gte: range.from, lte: range.to } },
      select: { status: true, assignedToId: true, closedAt: true },
    });

    let botResolved = 0;
    let humanHandled = 0;
    let inFlight = 0;

    for (const c of conversations) {
      if (c.assignedToId) {
        humanHandled++;
      } else if (c.status === 'CLOSED' && c.closedAt) {
        botResolved++;
      } else {
        inFlight++;
      }
    }

    const total = conversations.length;
    const totalCompleted = botResolved + humanHandled;

    return {
      botResolved,
      humanHandled,
      inFlight,
      total,
      botResolutionRate: totalCompleted > 0 ? Math.round((botResolved / totalCompleted) * 100) : null,
      escalationRate: totalCompleted > 0 ? Math.round((humanHandled / totalCompleted) * 100) : null,
    };
  }

  async getTopTags(
    organizationId: string,
    range: DateRange,
    assignedToId?: string,
    limit = 5,
  ) {
    const tagged = await this.prisma.conversationTag.findMany({
      where: {
        conversation: {
          organizationId,
          ...this.relScope(assignedToId),
          createdAt: { gte: range.from, lte: range.to },
        },
      },
      select: { tag: { select: { id: true, name: true, color: true } } },
    });

    const counts = new Map<string, { id: string; name: string; color: string; count: number }>();
    for (const t of tagged) {
      const k = t.tag.id;
      if (!counts.has(k)) counts.set(k, { id: t.tag.id, name: t.tag.name, color: t.tag.color, count: 0 });
      counts.get(k)!.count++;
    }

    return Array.from(counts.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }

  private async getAvgFirstResponseTime(organizationId: string, range: DateRange, assignedToId?: string): Promise<number | null> {
    const convs = await this.prisma.conversation.findMany({
      where: {
        organizationId,
        ...this.convScope(assignedToId),
        firstResponseAt: { not: null },
        createdAt: { gte: range.from, lte: range.to },
      },
      select: { createdAt: true, firstResponseAt: true },
    });
    if (convs.length === 0) return null;
    const total = convs.reduce((s, c) => s + (c.firstResponseAt!.getTime() - c.createdAt.getTime()), 0);
    return Math.round(total / convs.length / 60000);
  }

  private async getAvgResolutionTime(organizationId: string, range: DateRange, assignedToId?: string): Promise<number | null> {
    const convs = await this.prisma.conversation.findMany({
      where: {
        organizationId,
        ...this.convScope(assignedToId),
        closedAt: { not: null },
        createdAt: { gte: range.from, lte: range.to },
      },
      select: { createdAt: true, closedAt: true },
    });
    if (convs.length === 0) return null;
    const total = convs.reduce((s, c) => s + (c.closedAt!.getTime() - c.createdAt.getTime()), 0);
    return Math.round(total / convs.length / 60000);
  }

  private async getSlaCompliance(organizationId: string, range: DateRange, assignedToId?: string): Promise<number | null> {
    const dept = await this.prisma.department.findFirst({
      where: { organizationId, isDefault: true },
      select: { slaFirstResponse: true },
    });
    if (!dept?.slaFirstResponse) return null;

    const slaMinutes = dept.slaFirstResponse;
    const convs = await this.prisma.conversation.findMany({
      where: {
        organizationId,
        ...this.convScope(assignedToId),
        firstResponseAt: { not: null },
        createdAt: { gte: range.from, lte: range.to },
      },
      select: { createdAt: true, firstResponseAt: true },
    });
    if (convs.length === 0) return null;

    const withinSla = convs.filter(
      (c) => (c.firstResponseAt!.getTime() - c.createdAt.getTime()) / 60000 <= slaMinutes,
    ).length;

    return Math.round((withinSla / convs.length) * 100);
  }

  private calcTrend(current: number, previous: number): number {
    if (previous === 0) return current > 0 ? 100 : 0;
    return Math.round(((current - previous) / previous) * 100);
  }
}
