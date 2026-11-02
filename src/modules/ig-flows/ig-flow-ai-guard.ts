import { PrismaService } from '../../database/prisma.service';
import { matchesKeywords } from './ig-flows.validator';
import { IgFlowTriggerConfig } from './ig-flows.types';

type ConversationRef = { id: string; channelId: string; organizationId: string; contactId: string };

/** Derived pause: never changes manual AI settings and releases on completion/failure. */
export async function isIgFlowHandlingConversation(prisma: PrismaService, conversation: ConversationRef): Promise<boolean> {
  const channel = await prisma.channel.findUnique({ where: { id: conversation.channelId }, select: { type: true } });
  if (channel?.type !== 'INSTAGRAM') return false;
  const contact = await prisma.contactChannel.findFirst({
    where: { channelId: conversation.channelId, contactId: conversation.contactId },
    select: { externalId: true },
  });
  if (!contact) return false;
  const runs = await prisma.igFlowRun.findMany({
    where: {
      organizationId: conversation.organizationId, channelId: conversation.channelId,
      contactExternalId: contact.externalId, status: { in: ['RUNNING', 'WAITING'] },
      flow: { isActive: true, deletedAt: null },
    },
    include: { flow: { select: { nodes: true } } },
  });
  if (runs.some(run => run.status === 'RUNNING' ||
    (run.flow.nodes as any[]).some(node => node.id === run.currentNodeId && node.type === 'delay'))) return true;

  // Covers the gap before the queue creates a run, and prevents responding
  // to the consumed keyword after a short sequence already finished.
  const message = await prisma.message.findFirst({
    where: { conversationId: conversation.id, direction: 'INBOUND', type: { notIn: ['REACTION', 'SYSTEM'] } },
    orderBy: { createdAt: 'desc' },
  });
  const text = (message?.content as any)?.text;
  if (typeof text !== 'string' || !text.trim()) return false;
  const story = (message?.metadata as any)?.replyTo?.story?.kind === 'reply';
  const flows = await prisma.igFlow.findMany({
    where: { organizationId: conversation.organizationId, isActive: true, deletedAt: null,
      triggerType: { in: story ? ['STORY_REPLY', 'DM_KEYWORD'] : ['DM_KEYWORD'] } },
  });
  return flows.some(flow => {
    if (flow.channelIds.length && !flow.channelIds.includes(conversation.channelId)) return false;
    const cfg = (flow.triggerConfig ?? {}) as IgFlowTriggerConfig;
    if (flow.triggerType === 'DM_KEYWORD' && !cfg.keywords?.length) return false;
    return matchesKeywords(text, cfg.keywords, cfg.match);
  });
}
