import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PrismaService } from '../../database/prisma.service';
import { HoppeLeadsClient } from './hoppe-leads.client';
import { LeadOnboardingConfigService } from './lead-onboarding-config.service';
import { adjustToSendWindow } from './onboarding-rules';

const HOUR = 3_600_000;
/** Quanto tempo o lead espera resposta humana antes da IA retomar. */
export const HUMAN_GRACE_MS = HOUR;
/** Resposta mais velha que isso não é retomada (assunto esfriou). */
const MAX_AGE_MS = 3 * 24 * HOUR;

/**
 * Tiago (ou alguém do time) respondeu pelo celular, a IA pausou, o lead
 * respondeu e ninguém voltou em 1h: a IA retoma a conversa a partir da
 * resposta do lead (pedido de 20/10, caso Esmeraldo). Só dentro da janela de
 * envio e só em conversa pausada por mensagem humana (eco do celular ou envio
 * pela tela), nunca em pausa manual nem em lead com reunião marcada.
 */
@Injectable()
export class OnboardingHumanResumeService {
  private readonly logger = new Logger(OnboardingHumanResumeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly hoppe: HoppeLeadsClient,
    private readonly config: LeadOnboardingConfigService,
    private readonly moduleRef: ModuleRef,
  ) {}

  async run(now = new Date()): Promise<number> {
    if (!this.config.enabled) return 0;
    const { start, end } = this.config.sendWindow;
    if (adjustToSendWindow(now, start, end).getTime() !== now.getTime()) return 0;

    const graceBefore = new Date(now.getTime() - HUMAN_GRACE_MS);
    const oldest = new Date(now.getTime() - MAX_AGE_MS);
    const rows = await this.prisma.$queryRaw<Array<{ id: string; conversation_id: string; hoppe_task_id: string; trigger_id: string }>>`
      SELECT l.id, l.conversation_id, l.hoppe_task_id, last_in.id AS trigger_id
      FROM onboarding_leads l
      JOIN conversations c ON c.id = l.conversation_id
      JOIN LATERAL (
        SELECT m.id, m.direction, m.created_at, m.metadata
        FROM messages m
        WHERE m.conversation_id = l.conversation_id AND m.type <> 'SYSTEM'
        ORDER BY m.created_at DESC LIMIT 1
      ) last_in ON TRUE
      JOIN LATERAL (
        SELECT m.sender_id, m.metadata
        FROM messages m
        WHERE m.conversation_id = l.conversation_id AND m.direction = 'OUTBOUND' AND m.type <> 'SYSTEM'
        ORDER BY m.created_at DESC LIMIT 1
      ) last_out ON TRUE
      WHERE l.state = 'PAUSED'
        AND l.meeting_event_id IS NULL
        AND c.ai_enabled = false
        AND last_in.direction = 'INBOUND'
        AND last_in.created_at < ${graceBefore}
        AND last_in.created_at > ${oldest}
        AND COALESCE(last_in.metadata->>'onboardingAutoReply', '') <> 'true'
        AND (last_out.sender_id IS NOT NULL OR last_out.metadata->>'isEcho' = 'true')
      LIMIT 10`;

    let resumed = 0;
    for (const row of rows) {
      try {
        await this.resume(row, now);
        resumed++;
      } catch (err) {
        this.logger.warn(`Retomada pós-humano falhou no lead ${row.id}: ${(err as Error).message}`);
      }
    }
    return resumed;
  }

  private async resume(
    row: { id: string; conversation_id: string; hoppe_task_id: string; trigger_id: string },
    now: Date,
  ): Promise<void> {
    const conversation = await this.prisma.conversation.update({
      where: { id: row.conversation_id },
      data: { aiEnabled: true, activeAgentId: this.config.agentId, assignedToId: null },
    });
    const { start, end } = this.config.sendWindow;
    await this.prisma.onboardingLead.update({
      where: { id: row.id },
      data: {
        state: 'REPLIED',
        silentFollowups: 0,
        nextActionAt: adjustToSendWindow(new Date(now.getTime() + 24 * HOUR), start, end),
      },
    });
    try {
      await this.hoppe.addComment(
        row.hoppe_task_id,
        'O lead respondeu depois da mensagem do Tiago e ficou mais de 1h sem retorno; a IA retomou a conversa.',
      );
    } catch {
      /* comentário é best-effort */
    }

    const trigger = await this.prisma.message.findUniqueOrThrow({ where: { id: row.trigger_id } });
    // Import tardio: o runner depende das tools, que dependem deste módulo.
    const { AiAgentRunnerService } = await import('../ai-agents/runner/agent-runner.service');
    const runner = this.moduleRef.get(AiAgentRunnerService, { strict: false });
    await runner.run({ conversation, triggerMessage: trigger });
    this.logger.log(`IA retomou a conversa ${row.conversation_id} depois de resposta humana sem retorno`);
  }
}
