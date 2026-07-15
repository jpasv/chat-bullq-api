import { ChannelType } from '@prisma/client';
import { GmailPollingCron } from './gmail-polling.cron';
import { GmailMessageMapper } from './gmail.message-mapper';
import { GmailMessage } from './gmail.http-client';

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

function gmailMessage(
  id: string,
  labelIds: string[],
  overrides: Partial<GmailMessage> = {},
): GmailMessage {
  return {
    id,
    threadId: `t_${id}`,
    labelIds,
    internalDate: '1750000000000',
    snippet: 'snippet',
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: `Cliente <cliente-${id}@x.com>` },
        { name: 'Subject', value: 'Assunto' },
        { name: 'Message-ID', value: `<${id}@mail>` },
      ],
      body: { data: b64url('corpo do email') },
    },
    ...overrides,
  };
}

function buildCron(opts: {
  channels: any[];
  history?: any;
  messages?: Record<string, GmailMessage>;
  profile?: any;
  list?: any;
  historyError?: any;
}) {
  const prisma = {
    channel: {
      findMany: jest.fn().mockResolvedValue(opts.channels),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const httpClient = {
    listHistory: opts.historyError
      ? jest.fn().mockRejectedValue(opts.historyError)
      : jest.fn().mockResolvedValue(opts.history ?? { history: [], historyId: '100' }),
    listMessages: jest.fn().mockResolvedValue(opts.list ?? { messages: [] }),
    getMessage: jest.fn((_ch: any, id: string) => {
      const msg = opts.messages?.[id];
      if (!msg) throw new Error(`sem mock pra msg ${id}`);
      return Promise.resolve(msg);
    }),
    getProfile: jest
      .fn()
      .mockResolvedValue(opts.profile ?? { emailAddress: 'x@y.z', historyId: '50' }),
  };
  const config = { get: jest.fn().mockReturnValue(undefined) };
  const pollQueue = { add: jest.fn().mockResolvedValue({}) };
  const inboundQueue = { add: jest.fn().mockResolvedValue({}) };

  const cron = new GmailPollingCron(
    prisma as any,
    httpClient as any,
    new GmailMessageMapper(),
    config as any,
    pollQueue as any,
    inboundQueue as any,
  );
  return { cron, prisma, httpClient, inboundQueue };
}

const channelRow = (config: Record<string, any>) => ({
  id: 'ch_1',
  organizationId: 'org_1',
  type: ChannelType.GMAIL,
  isActive: true,
  deletedAt: null,
  config,
});

describe('GmailPollingCron.process', () => {
  it('sem canais GMAIL: retorna zerado sem chamar a API', async () => {
    const { cron, httpClient } = buildCron({ channels: [] });
    const result = await cron.process({} as any);
    expect(result).toEqual({ channels: 0, ingested: 0 });
    expect(httpClient.listHistory).not.toHaveBeenCalled();
  });

  it('incremental: ingere email novo e avança o watermark', async () => {
    const { cron, prisma, inboundQueue } = buildCron({
      channels: [
        channelRow({ email: 'sup@x.com', refreshToken: 'rt', lastHistoryId: '10' }),
      ],
      history: {
        history: [
          { id: '11', messagesAdded: [{ message: { id: 'm1', threadId: 't1', labelIds: ['INBOX'] } }] },
        ],
        historyId: '12',
      },
      messages: { m1: gmailMessage('m1', ['INBOX', 'UNREAD']) },
    });

    const result = await cron.process({} as any);

    expect(result.ingested).toBe(1);
    expect(inboundQueue.add).toHaveBeenCalledWith(
      'process-inbound',
      expect.objectContaining({
        channelId: 'ch_1',
        organizationId: 'org_1',
        message: expect.objectContaining({
          externalMessageId: 'm1',
          threadExternalId: 't_m1',
          channelType: ChannelType.GMAIL,
        }),
      }),
      expect.objectContaining({ attempts: 5 }),
    );
    // Watermark avançou pro historyId da página
    expect(prisma.channel.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          config: expect.objectContaining({ lastHistoryId: '12' }),
        }),
      }),
    );
  });

  it('loop-safety: SENT/DRAFT/SPAM/TRASH nunca são ingeridos', async () => {
    const { cron, inboundQueue } = buildCron({
      channels: [
        channelRow({ email: 'sup@x.com', refreshToken: 'rt', lastHistoryId: '10' }),
      ],
      history: {
        history: [
          {
            id: '11',
            messagesAdded: [
              { message: { id: 'sent1', threadId: 't', labelIds: ['SENT'] } },
              { message: { id: 'draft1', threadId: 't', labelIds: ['DRAFT'] } },
              { message: { id: 'spam1', threadId: 't', labelIds: ['SPAM'] } },
              { message: { id: 'trash1', threadId: 't', labelIds: ['TRASH'] } },
            ],
          },
        ],
        historyId: '12',
      },
    });

    const result = await cron.process({} as any);
    expect(result.ingested).toBe(0);
    expect(inboundQueue.add).not.toHaveBeenCalled();
  });

  it('re-checa labels no messages.get (stub do history pode vir sem)', async () => {
    const { cron, inboundQueue } = buildCron({
      channels: [
        channelRow({ email: 'sup@x.com', refreshToken: 'rt', lastHistoryId: '10' }),
      ],
      history: {
        history: [
          // stub SEM labelIds — engana o primeiro filtro
          { id: '11', messagesAdded: [{ message: { id: 'echo1', threadId: 't' } as any }] },
        ],
        historyId: '12',
      },
      messages: { echo1: gmailMessage('echo1', ['SENT']) },
    });

    const result = await cron.process({} as any);
    expect(result.ingested).toBe(0);
    expect(inboundQueue.add).not.toHaveBeenCalled();
  });

  it('primeira varredura (sem watermark): semeia historyId via profile', async () => {
    const { cron, prisma, httpClient } = buildCron({
      channels: [channelRow({ email: 'sup@x.com', refreshToken: 'rt' })],
      profile: { emailAddress: 'sup@x.com', historyId: '77' },
      list: { messages: [] },
    });

    await cron.process({} as any);

    expect(httpClient.getProfile).toHaveBeenCalled();
    expect(httpClient.listMessages).toHaveBeenCalled();
    expect(prisma.channel.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          config: expect.objectContaining({ lastHistoryId: '77' }),
        }),
      }),
    );
  });

  it('historyId expirado (404): cai pro full sync sem quebrar', async () => {
    const err: any = new Error('not found');
    err.response = { status: 404 };
    const { cron, httpClient } = buildCron({
      channels: [
        channelRow({ email: 'sup@x.com', refreshToken: 'rt', lastHistoryId: '1' }),
      ],
      historyError: err,
      profile: { emailAddress: 'sup@x.com', historyId: '200' },
      list: { messages: [{ id: 'm9', threadId: 't9' }] },
      messages: { m9: gmailMessage('m9', ['INBOX']) },
    });

    const result = await cron.process({} as any);
    expect(httpClient.getProfile).toHaveBeenCalled();
    expect(result.ingested).toBe(1);
  });

  it('erro num canal não derruba a varredura dos outros', async () => {
    const boom: any = new Error('token revogado');
    boom.response = { status: 400 };
    const { cron, inboundQueue } = buildCron({
      channels: [
        { ...channelRow({ email: 'a@x.com', refreshToken: 'rt', lastHistoryId: '1' }), id: 'ch_a' },
        { ...channelRow({ email: 'b@x.com', refreshToken: 'rt', lastHistoryId: '1' }), id: 'ch_b' },
      ],
      history: {
        history: [
          { id: '2', messagesAdded: [{ message: { id: 'ok1', threadId: 't', labelIds: ['INBOX'] } }] },
        ],
        historyId: '3',
      },
      messages: { ok1: gmailMessage('ok1', ['INBOX']) },
    });
    // 1º canal falha, 2º segue
    (cron as any).httpClient.listHistory = jest
      .fn()
      .mockRejectedValueOnce(boom)
      .mockResolvedValue({
        history: [
          { id: '2', messagesAdded: [{ message: { id: 'ok1', threadId: 't', labelIds: ['INBOX'] } }] },
        ],
        historyId: '3',
      });

    const result = await cron.process({} as any);
    expect(result.channels).toBe(2);
    expect(result.ingested).toBe(1);
    expect(inboundQueue.add).toHaveBeenCalledTimes(1);
  });

  it('canal sem refreshToken é pulado com warning', async () => {
    const { cron, httpClient } = buildCron({
      channels: [channelRow({ email: 'sup@x.com' })],
    });
    const result = await cron.process({} as any);
    expect(result.ingested).toBe(0);
    expect(httpClient.listHistory).not.toHaveBeenCalled();
    expect(httpClient.getProfile).not.toHaveBeenCalled();
  });
});
