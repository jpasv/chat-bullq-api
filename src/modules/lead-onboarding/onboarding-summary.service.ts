import { Injectable } from '@nestjs/common';
import { MessageDirection, OnboardingLead } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { LlmService } from '../ai-agents/llm/llm.service';
import { SAKANA_SIMPLE_MODEL } from '../ai-agents/llm/llm.constants';
import { HoppeLeadsClient } from './hoppe-leads.client';

const SYSTEM = [
  'Você resume conversas de WhatsApp entre o assistente virtual da Bravy e um cliente que comprou um produto low ticket.',
  'Escreva em português corrido, no máximo 5 frases, sem listas e sem copiar mensagens.',
  'Registre o que o cliente trouxe (dúvida, objetivo, rotina, gargalo), o que já foi confirmado (nível, faturamento, se decide, sócios, prioridade) e o que ficou pendente.',
  'Não invente nada que não esteja na conversa.',
].join(' ');

/**
 * Resumo do bloco de conversa desde o último resumo, comentado na task do
 * Hoppe. Roda com debounce (30min sem mensagem nova) pelo tick.
 */
@Injectable()
export class OnboardingSummaryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly hoppe: HoppeLeadsClient,
  ) {}

  async summarize(lead: OnboardingLead): Promise<void> {
    if (!lead.conversationId) return;
    const since = lead.lastSummaryAt ?? lead.repliedAt ?? lead.createdAt;
    const messages = await this.prisma.message.findMany({
      where: { conversationId: lead.conversationId, createdAt: { gt: since } },
      orderBy: { createdAt: 'asc' },
      take: 40,
      select: { direction: true, content: true, type: true },
    });
    if (messages.length === 0) return;

    const transcript = messages
      .map((m) => {
        const who = m.direction === MessageDirection.INBOUND ? 'Cliente' : 'Assistente';
        const text = (m.content as any)?.text ?? (m.content as any)?.caption ?? `[${m.type}]`;
        return `${who}: ${text}`;
      })
      .join('\n');

    const resp = await this.llm.complete({
      modelId: SAKANA_SIMPLE_MODEL,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: transcript },
      ],
      temperature: 0.2,
      maxTokens: 300,
    });
    const raw =
      typeof resp.message.content === 'string'
        ? resp.message.content
        : resp.message.content
            .filter((p) => p.type === 'text')
            .map((p) => p.text)
            .join('');
    const summary = raw.trim();
    if (!summary) return;
    await this.hoppe.addComment(lead.hoppeTaskId, `Resumo da conversa: ${summary}`);
  }
}
