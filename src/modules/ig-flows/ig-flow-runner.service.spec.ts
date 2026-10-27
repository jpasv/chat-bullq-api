import { IgFlowRunnerService } from './ig-flow-runner.service';

const FLOW_NODES = [
  { id: 'c', type: 'condition', check: 'follows', onTrue: 'm1', onFalse: 'm2' },
  {
    id: 'm1',
    type: 'message',
    text: 'Live às 20h, {{username}}',
    buttons: [{ id: 'b1', title: 'Acessar grupo', type: 'url', url: 'https://grupo', next: 'h' }],
  },
  { id: 'm2', type: 'message', text: 'Só pra seguidores', buttons: [{ id: 'b2', title: 'Tô seguindo', type: 'postback', next: 'c' }] },
  { id: 'h', type: 'http', url: 'https://hook', next: 'd' },
  { id: 'd', type: 'delay', seconds: 600, next: 'm3' },
  { id: 'm3', type: 'message', text: 'Conseguiu entrar?' },
];

function build(runOverrides: Record<string, any> = {}) {
  const flow = {
    id: 'f1',
    name: 'Live',
    isActive: true,
    deletedAt: null,
    nodes: FLOW_NODES,
    startNodeId: 'c',
    triggerConfig: { keywords: ['live'], publicReplies: ['Te mandei na DM'] },
    channelIds: [],
    createdAt: new Date(),
  };
  let run: any = {
    id: 'r1',
    flowId: 'f1',
    organizationId: 'org1',
    channelId: 'ch1',
    contactExternalId: 'u1',
    contactUsername: 'maria',
    commentExternalId: 'cm1',
    privateReplyUsed: false,
    lastInteractionAt: null,
    status: 'RUNNING',
    log: [],
    flow,
    ...runOverrides,
  };
  const prisma: any = {
    igFlow: { findMany: jest.fn().mockResolvedValue([flow]) },
    igFlowRun: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation(({ data }) => {
        run = { ...run, ...data, flow };
        return run;
      }),
      findUnique: jest.fn().mockImplementation(() => run),
      update: jest.fn().mockImplementation(({ data }) => {
        run = { ...run, ...data, flow };
        return run;
      }),
      updateMany: jest.fn(),
    },
    channel: { findUnique: jest.fn().mockResolvedValue({ id: 'ch1' }) },
    conversation: { update: jest.fn() },
  };
  const instagram = {
    sendMessage: jest.fn().mockResolvedValue({ message_id: 'mid' }),
    replyToComment: jest.fn().mockResolvedValue({ id: 'r' }),
    getFollowsBusiness: jest.fn().mockResolvedValue(null),
  };
  const contactResolver = { resolveByExternalId: jest.fn().mockResolvedValue({ contactId: 'ct1' }) };
  const conversationResolver = { resolve: jest.fn().mockResolvedValue({ conversationId: 'cv1' }) };
  const messagesRepo = { create: jest.fn().mockResolvedValue({ id: 'msg' }) };
  const realtime = { emitToChannel: jest.fn(), emitToConversation: jest.fn() };
  const config = { get: jest.fn().mockReturnValue('https://api.test') };
  const queue = { add: jest.fn() };
  const service = new IgFlowRunnerService(
    prisma,
    instagram as any,
    contactResolver as any,
    conversationResolver as any,
    messagesRepo as any,
    realtime as any,
    config as any,
    queue as any,
  );
  return { service, prisma, instagram, queue, getRun: () => run };
}

const commentJob = {
  channelId: 'ch1',
  organizationId: 'org1',
  commentExternalId: 'cm1',
  mediaId: 'md1',
  authorExternalId: 'u1',
  authorUsername: 'maria',
  text: 'Quero a LIVE',
};

describe('IgFlowRunnerService', () => {
  it('comentário com palavra-chave: resposta pública + private reply do ramo "não segue"', async () => {
    const { service, instagram, getRun } = build();
    await service.startFromComment(commentJob);

    expect(instagram.replyToComment).toHaveBeenCalledWith({ id: 'ch1' }, 'cm1', 'Te mandei na DM');
    expect(instagram.sendMessage).toHaveBeenCalledTimes(1);
    const payload = instagram.sendMessage.mock.calls[0][1];
    expect(payload.recipient).toEqual({ comment_id: 'cm1' });
    expect(payload.message.attachment.payload.buttons[0]).toEqual({ type: 'postback', title: 'Tô seguindo', payload: 'IGF:r1:b2' });
    expect(getRun().privateReplyUsed).toBe(true);
    expect(getRun().status).toBe('WAITING');
  });

  it('comentário sem palavra-chave não dispara', async () => {
    const { service, prisma, instagram } = build();
    await service.startFromComment({ ...commentJob, text: 'top' });
    expect(prisma.igFlowRun.create).not.toHaveBeenCalled();
    expect(instagram.sendMessage).not.toHaveBeenCalled();
  });

  it('mesma pessoa não entra duas vezes', async () => {
    const { service, prisma, instagram } = build();
    prisma.igFlowRun.findFirst.mockResolvedValue({ id: 'old' });
    await service.startFromComment(commentJob);
    expect(instagram.sendMessage).not.toHaveBeenCalled();
  });

  it('clique em "Tô seguindo" recheca e manda o link via redirect pra DM', async () => {
    const { service, instagram, getRun } = build({ privateReplyUsed: true });
    instagram.getFollowsBusiness.mockResolvedValue(true);

    await service.handlePostback({ channelId: 'ch1', contactExternalId: 'u1', payload: 'IGF:r1:b2' });

    const payload = instagram.sendMessage.mock.calls[0][1];
    expect(payload.recipient).toEqual({ id: 'u1' });
    expect(payload.message.attachment.payload.text).toBe('Live às 20h, maria');
    expect(payload.message.attachment.payload.buttons[0]).toEqual({
      type: 'web_url',
      title: 'Acessar grupo',
      url: 'https://api.test/api/v1/ig-flows/r/r1/b1',
    });
    expect(getRun().status).toBe('WAITING');
  });

  it('depois do private reply, mensagem sem interação fica esperando', async () => {
    const { service, instagram, getRun } = build({ privateReplyUsed: true, lastInteractionAt: null });
    await service.execute('r1', 'm3');
    expect(instagram.sendMessage).not.toHaveBeenCalled();
    expect(getRun().status).toBe('WAITING_INTERACTION');
  });

  it('fora da janela de 24h pula a mensagem', async () => {
    const { service, instagram, getRun } = build({
      privateReplyUsed: true,
      lastInteractionAt: new Date(Date.now() - 25 * 3600 * 1000),
    });
    await service.execute('r1', 'm3');
    expect(instagram.sendMessage).not.toHaveBeenCalled();
    expect(getRun().status).toBe('DONE');
  });

  it('delay agenda o próximo nó na fila', async () => {
    const { service, queue, getRun } = build({ privateReplyUsed: true, lastInteractionAt: new Date() });
    await service.execute('r1', 'd');
    expect(queue.add).toHaveBeenCalledWith(
      'resume',
      { runId: 'r1', nodeId: 'm3' },
      expect.objectContaining({ delay: 600000, jobId: 'delay-r1-d' }),
    );
    expect(getRun().status).toBe('WAITING');
  });

  it('delay diário agenda pro próximo horário e {{dia_aula}} acompanha', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-27T21:00:00-03:00'));
    const { service, queue, prisma, instagram } = build({ privateReplyUsed: true, lastInteractionAt: new Date() });
    const flow = (await prisma.igFlow.findMany())[0];
    flow.nodes = [
      { id: 'm', type: 'message', text: 'Aula {{dia_aula}} às 20h', next: 'd' },
      { id: 'd', type: 'delay', dailyAt: '20:00', next: 'm2' },
      { id: 'm2', type: 'message', text: 'Ao vivo' },
    ];
    await service.execute('r1', 'm');
    expect(instagram.sendMessage.mock.calls[0][1].message.text).toBe('Aula amanhã às 20h');
    expect(queue.add).toHaveBeenCalledWith('resume', { runId: 'r1', nodeId: 'm2' }, expect.objectContaining({ delay: 23 * 3600_000 }));
    jest.useRealTimers();
  });

  it('clique no link devolve a URL e enfileira a continuação uma vez', async () => {
    const { service, queue } = build();
    const url = await service.handleLinkClick('r1', 'b1');
    expect(url).toBe('https://grupo');
    expect(queue.add).toHaveBeenCalledWith('resume', { runId: 'r1', nodeId: 'h' }, expect.objectContaining({ jobId: 'click-r1-b1' }));
  });
});
