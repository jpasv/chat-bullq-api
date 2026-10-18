import { EncaminharSuporteTool } from '../ai-agents/tools/builtin/encaminhar-suporte.tool';
import { HandBackToOrchestratorTool } from '../ai-agents/tools/builtin/hand-back-to-orchestrator.tool';
import { OnboardingMessengerService } from './onboarding-messenger.service';
import { SUPPORT_RETURN_NOTE } from './lead-onboarding.constants';

const ctx = { conversationId: 'conv1', organizationId: 'org1', contactId: 'ct1', channelId: 'ch1', agentId: 'agent_onboarding_001', runId: 'r1' };

function prismaWith(conv: Record<string, any>) {
  const state: { conv: Record<string, any> } = { conv: { id: 'conv1', ...conv } };
  const prisma: any = {
    conversation: {
      findUnique: jest.fn(async () => state.conv),
      update: jest.fn(async ({ data }) => {
        state.conv = { ...state.conv, ...data };
        return state.conv;
      }),
    },
    aiAgentHandoff: { create: jest.fn(async () => ({})) },
    conversationAuditLog: { create: jest.fn(async () => ({})) },
    $transaction: jest.fn(async (ops: any[]) => Promise.all(ops)),
  };
  return { prisma, state };
}

function messengerOf(prisma: any) {
  const config = { agentId: 'agent_onboarding_001', supportAgentId: 'agent_livia_001' };
  return new OnboardingMessengerService(prisma, {} as any, config as any, {} as any);
}

describe('suporte no onboarding (Lívia e volta)', () => {
  it('encaminharSuporte passa pra Lívia, guarda a volta e dispara o próximo agente', async () => {
    const { prisma, state } = prismaWith({ activeAgentId: 'agent_onboarding_001', metadata: { promptContext: 'Lead X' } });
    const messenger = messengerOf(prisma);
    const onboarding = { findByConversation: jest.fn().mockResolvedValue({ id: 'l1', hoppeTaskId: 't1' }), noteSupport: jest.fn() };
    const tool = new EncaminharSuporteTool(onboarding as any, messenger);
    const r = await tool.execute({ motivo: 'curso não aparece na área de membros' }, ctx);
    expect(r.finalAction).toBe('DELEGATED');
    expect(state.conv.activeAgentId).toBe('agent_livia_001');
    expect(state.conv.metadata.returnToAgentId).toBe('agent_onboarding_001');
    expect(state.conv.metadata.promptContext).toContain(SUPPORT_RETURN_NOTE);
    expect(onboarding.noteSupport).toHaveBeenCalledWith(expect.objectContaining({ id: 'l1' }), 'curso não aparece na área de membros');
  });

  it('handBack da Lívia numa conversa do onboarding devolve pro agente de onboarding', async () => {
    const { prisma, state } = prismaWith({
      activeAgentId: 'agent_livia_001',
      metadata: { promptContext: `Lead X\n\n${SUPPORT_RETURN_NOTE}`, returnToAgentId: 'agent_onboarding_001' },
    });
    const tool = new HandBackToOrchestratorTool(prisma, { emitToConversation: jest.fn() } as any, messengerOf(prisma));
    const r = await tool.execute({ reason: 'acesso resolvido' }, { ...ctx, agentId: 'agent_livia_001' });
    expect(state.conv.activeAgentId).toBe('agent_onboarding_001');
    expect(state.conv.metadata.returnToAgentId).toBeUndefined();
    expect(state.conv.metadata.promptContext).toBe('Lead X');
    expect((r.output as any).returnedTo).toBe('agent_onboarding_001');
  });

  it('handBack fora do onboarding continua zerando o agente', async () => {
    const { prisma, state } = prismaWith({ activeAgentId: 'agent_livia_001', metadata: {} });
    const tool = new HandBackToOrchestratorTool(prisma, { emitToConversation: jest.fn() } as any, messengerOf(prisma));
    await tool.execute({ reason: 'mudou de assunto' }, { ...ctx, agentId: 'agent_livia_001' });
    expect(state.conv.activeAgentId).toBeNull();
  });
});
