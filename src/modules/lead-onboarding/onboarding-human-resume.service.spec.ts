import { OnboardingHumanResumeService } from './onboarding-human-resume.service';

const brt = (iso: string) => new Date(`${iso}-03:00`);

function build(rows: any[]) {
  const runner = { run: jest.fn().mockResolvedValue(undefined) };
  const prisma = {
    $queryRaw: jest.fn().mockResolvedValue(rows),
    conversation: { update: jest.fn().mockResolvedValue({ id: 'conv1' }) },
    onboardingLead: { update: jest.fn().mockResolvedValue({}) },
    message: { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'm1' }) },
  };
  const hoppe = { addComment: jest.fn().mockResolvedValue(undefined) };
  const config = { enabled: true, sendWindow: { start: 8, end: 20 }, agentId: 'agent_onboarding_001' };
  const moduleRef = { get: jest.fn().mockReturnValue(runner) };
  const svc = new OnboardingHumanResumeService(prisma as any, hoppe as any, config as any, moduleRef as any);
  return { svc, prisma, runner, hoppe };
}

jest.mock('../ai-agents/runner/agent-runner.service', () => ({ AiAgentRunnerService: class {} }));

describe('OnboardingHumanResumeService', () => {
  const row = { id: 'l1', conversation_id: 'conv1', hoppe_task_id: 'task1', trigger_id: 'm1' };

  it('religa a IA, volta o lead pra REPLIED e roda o agente na resposta do lead', async () => {
    const { svc, prisma, runner, hoppe } = build([row]);
    expect(await svc.run(brt('2026-10-20T08:02:00'))).toBe(1);
    expect(prisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 'conv1' },
      data: { aiEnabled: true, activeAgentId: 'agent_onboarding_001', assignedToId: null },
    });
    expect(prisma.onboardingLead.update.mock.calls[0][0].data.state).toBe('REPLIED');
    expect(runner.run).toHaveBeenCalledWith({ conversation: { id: 'conv1' }, triggerMessage: { id: 'm1' } });
    expect(hoppe.addComment).toHaveBeenCalled();
  });

  it('fora da janela de envio não faz nada', async () => {
    const { svc, prisma } = build([row]);
    expect(await svc.run(brt('2026-10-20T00:49:00'))).toBe(0);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});
