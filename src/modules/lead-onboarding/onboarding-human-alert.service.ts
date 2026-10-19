import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { HoppeChatClient } from './hoppe-chat.client';
import { HoppeLeadsClient } from './hoppe-leads.client';
import { LeadOnboardingConfigService } from './lead-onboarding-config.service';
import { HUMAN_TAG } from './lead-onboarding.constants';

export interface HumanAlertRow {
  leadId: string;
  hoppeTaskId: string;
  leadName: string | null;
  agentId: string;
  toolName: string;
  reason: string | null;
  createdAt: Date;
}

const TOOL_LABEL: Record<string, string> = {
  transferToHuman: 'pediu transferência para humano',
};

/**
 * Avisa o canal "Leads onboarding" do chat do Hoppe quando um agente pede
 * aprovação humana (PendingAction) numa conversa do onboarding. Sem o aviso a
 * aprovação expira em silêncio e o lead fica sem resposta.
 *
 * Também põe a tag `aguardando-humano` e start/due = hora do pedido. Cada
 * PendingAction é avisada uma vez: `human_alert_at` guarda a criação da
 * última já avisada.
 */
@Injectable()
export class OnboardingHumanAlertService {
  private readonly logger = new Logger(OnboardingHumanAlertService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly chat: HoppeChatClient,
    private readonly hoppe: HoppeLeadsClient,
    private readonly config: LeadOnboardingConfigService,
  ) {}

  async run(): Promise<number> {
    const channelId = this.config.alertChannelId;
    if (!this.config.enabled || !channelId || !this.chat.configured) return 0;

    const rows = await this.prisma.$queryRaw<HumanAlertRow[]>`
      SELECT ol.id AS "leadId", ol.hoppe_task_id AS "hoppeTaskId", ol.snapshot->>'name' AS "leadName",
             pa.agent_id AS "agentId", pa.tool_name AS "toolName", pa.args->>'reason' AS "reason",
             pa.created_at AS "createdAt"
      FROM ai_pending_actions pa
      JOIN onboarding_leads ol ON ol.conversation_id = pa.conversation_id
      WHERE pa.status::text = 'PENDING'
        AND pa.created_at > COALESCE(ol.human_alert_at, ol.created_at)
      ORDER BY pa.created_at ASC
      LIMIT 20`;

    let sent = 0;
    for (const row of rows) {
      try {
        await this.chat.postToChannel(channelId, renderHumanAlert(row));
        await this.prisma.onboardingLead.update({
          where: { id: row.leadId },
          data: { humanAlertAt: row.createdAt },
        });
        // Tag + datas na hora do pedido: a task fica atrasada até alguém agir.
        await this.bestEffort(() => this.hoppe.addTag(row.hoppeTaskId, HUMAN_TAG));
        await this.bestEffort(() =>
          this.hoppe.setDates(row.hoppeTaskId, { start: row.createdAt, due: row.createdAt }),
        );
        await this.bestEffort(() =>
          this.hoppe.addComment(row.hoppeTaskId, `Precisa de humano: ${describe(row)}. Avisado no canal Leads onboarding.`),
        );
        sent++;
      } catch (err) {
        this.logger.warn(`Alerta humano do lead ${row.leadId} falhou: ${(err as Error).message}`);
      }
    }
    return sent;
  }

  private async bestEffort(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.logger.warn(`Escrita no Hoppe do alerta falhou: ${(err as Error).message}`);
    }
  }
}

function describe(row: HumanAlertRow): string {
  const who = row.agentId === 'agent_livia_001' ? 'a Lívia (suporte)' : 'o agente de onboarding';
  const what = TOOL_LABEL[row.toolName] ?? `pediu aprovação para ${row.toolName}`;
  return `${who} ${what}${row.reason ? `. Motivo: ${row.reason}` : ''}`;
}

export function renderHumanAlert(row: HumanAlertRow): string {
  const name = escapeHtml(row.leadName || 'Lead sem nome');
  return [
    `<p><strong>Precisa de humano: ${name}</strong></p>`,
    `<p>${escapeHtml(describe(row))}.</p>`,
    '<p>A aprovação fica pendente no chat-bullq e expira se ninguém agir. Detalhes no comentário da task na Leads onboarding.</p>',
  ].join('\n');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
