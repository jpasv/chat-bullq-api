import { isIgFlowHandlingConversation } from './ig-flow-ai-guard';
const conversation = { id: 'cv', channelId: 'ch', organizationId: 'org', contactId: 'ct' };
function setup() {
  return {
    channel: { findUnique: jest.fn().mockResolvedValue({ type: 'INSTAGRAM' }) },
    contactChannel: { findFirst: jest.fn().mockResolvedValue({ externalId: 'ig' }) },
    igFlowRun: { findMany: jest.fn().mockResolvedValue([]) },
    message: { findFirst: jest.fn().mockResolvedValue({ content: { text: 'IA' }, metadata: { replyTo: { story: { kind: 'reply' } } } }) },
    igFlow: { findMany: jest.fn().mockResolvedValue([{ channelIds: [], triggerType: 'DM_KEYWORD', triggerConfig: { keywords: ['ia'], match: 'exact' } }]) },
  };
}
describe('Instagram flow AI pause', () => {
  it('blocks a story keyword before the flow worker creates its run', async () => {
    expect(await isIgFlowHandlingConversation(setup() as any, conversation)).toBe(true);
  });
  it('blocks during the initial delay even if the person sends another message', async () => {
    const p = setup();
    p.igFlowRun.findMany.mockResolvedValue([{ status: 'WAITING', currentNodeId: 'delay', flow: { nodes: [{ id: 'delay', type: 'delay', seconds: 30 }] } }]);
    p.message.findFirst.mockResolvedValue({ content: { text: 'oi' } });
    expect(await isIgFlowHandlingConversation(p as any, conversation)).toBe(true);
  });
  it('releases a new question after all runs complete or fail', async () => {
    const p = setup(); p.message.findFirst.mockResolvedValue({ content: { text: 'Como funciona o pix?' } });
    expect(await isIgFlowHandlingConversation(p as any, conversation)).toBe(false);
    expect(p.igFlowRun.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: { in: ['RUNNING', 'WAITING'] } }) }));
  });
  it('does not answer an already consumed keyword after completion', async () => {
    expect(await isIgFlowHandlingConversation(setup() as any, conversation)).toBe(true);
  });
  it('does not pause other channels', async () => {
    const p = setup(); p.channel.findUnique.mockResolvedValue({ type: 'WHATSAPP' });
    expect(await isIgFlowHandlingConversation(p as any, conversation)).toBe(false);
    expect(p.igFlowRun.findMany).not.toHaveBeenCalled();
  });
  it('does not match a keyword belonging to another Instagram', async () => {
    const p = setup(); p.igFlow.findMany.mockResolvedValue([{ channelIds: ['other'], triggerType: 'DM_KEYWORD', triggerConfig: { keywords: ['ia'] } }]);
    expect(await isIgFlowHandlingConversation(p as any, conversation)).toBe(false);
  });
  it('allows questions while waiting for a button, without a scheduled sequence', async () => {
    const p = setup(); p.message.findFirst.mockResolvedValue({ content: { text: 'Tenho uma dúvida' } });
    p.igFlowRun.findMany.mockResolvedValue([{ status: 'WAITING', currentNodeId: 'button', flow: { nodes: [{ id: 'button', type: 'message' }] } }]);
    expect(await isIgFlowHandlingConversation(p as any, conversation)).toBe(false);
  });
});
