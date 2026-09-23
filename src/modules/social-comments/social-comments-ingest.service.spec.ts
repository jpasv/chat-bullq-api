import { SocialCommentsIngestService } from './social-comments-ingest.service';

const channel = { id: 'ch1', organizationId: 'org1', config: { igBusinessId: '1784' } };

function build() {
  const prisma = { channel: { findUnique: jest.fn().mockResolvedValue(channel) } };
  const repo = {
    findByExternal: jest.fn().mockResolvedValue(null),
    upsertFromWebhook: jest.fn(),
    markParentReplied: jest.fn().mockResolvedValue(undefined),
    findEnrichedSibling: jest.fn().mockResolvedValue(null),
    applyMediaToAll: jest.fn().mockResolvedValue(undefined),
    findThread: jest.fn(),
  };
  const http = { getMedia: jest.fn() };
  const realtime = { emitToChannel: jest.fn() };
  const service = new SocialCommentsIngestService(
    prisma as any,
    repo as any,
    http as any,
    realtime as any,
  );
  return { service, prisma, repo, http, realtime };
}

const comment = {
  externalId: 'c1',
  mediaId: 'm1',
  authorExternalId: '5550001',
  authorUsername: 'maria.s',
  text: 'Quanto custa?',
  commentedAt: new Date('2026-09-22T12:00:00Z'),
  rawPayload: {},
};

describe('SocialCommentsIngestService.ingest', () => {
  it('comentário raiz novo: upsert, enriquece mídia e emite comment:new', async () => {
    const { service, repo, http, realtime } = build();
    const saved = { id: 's1', ...comment, channelId: 'ch1', parentExternalId: null, isFromPage: false };
    repo.upsertFromWebhook.mockResolvedValue(saved);
    http.getMedia.mockResolvedValue({ id: 'm1', permalink: 'https://ig/p/x', caption: 'Promo', media_type: 'IMAGE', media_url: 'https://cdn/x.jpg' });
    repo.findThread.mockResolvedValue({ ...saved, mediaPermalink: 'https://ig/p/x', replies: [] });

    const out = await service.ingest({ channelId: 'ch1', organizationId: 'org1', comment });

    expect(out).toEqual({ created: true });
    expect(repo.upsertFromWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: 'ch1', externalId: 'c1', isFromPage: false }),
    );
    expect(repo.applyMediaToAll).toHaveBeenCalledWith('ch1', 'm1', {
      mediaPermalink: 'https://ig/p/x',
      mediaCaption: 'Promo',
      mediaThumbnailUrl: 'https://cdn/x.jpg',
    });
    expect(realtime.emitToChannel).toHaveBeenCalledWith('ch1', 'comment:new', expect.objectContaining({ id: 's1' }));
  });

  it('reprocessar o mesmo comentário não cria de novo e não emite', async () => {
    const { service, repo, realtime } = build();
    repo.findByExternal.mockResolvedValue({ id: 's1' });
    repo.upsertFromWebhook.mockResolvedValue({ id: 's1', ...comment, channelId: 'ch1', parentExternalId: null, isFromPage: false });
    repo.findEnrichedSibling.mockResolvedValue({ mediaPermalink: 'x' });

    const out = await service.ingest({ channelId: 'ch1', organizationId: 'org1', comment });

    expect(out).toEqual({ created: false });
    expect(realtime.emitToChannel).not.toHaveBeenCalled();
  });

  it('reply da própria página marca o pai como respondido e emite comment:updated', async () => {
    const { service, repo, realtime } = build();
    const reply = { ...comment, externalId: 'c2', parentExternalId: 'c1', authorExternalId: '1784' };
    repo.upsertFromWebhook.mockResolvedValue({ id: 's2', ...reply, channelId: 'ch1', isFromPage: true });
    repo.findEnrichedSibling.mockResolvedValue({ mediaPermalink: 'x' });
    repo.findThread.mockResolvedValue({ id: 's1', externalId: 'c1', replies: [{ id: 's2' }] });

    await service.ingest({ channelId: 'ch1', organizationId: 'org1', comment: reply });

    expect(repo.upsertFromWebhook).toHaveBeenCalledWith(expect.objectContaining({ isFromPage: true }));
    expect(repo.markParentReplied).toHaveBeenCalledWith('ch1', 'c1', null);
    expect(realtime.emitToChannel).toHaveBeenCalledWith('ch1', 'comment:updated', expect.objectContaining({ id: 's1' }));
  });

  it('falha no getMedia não derruba o ingest', async () => {
    const { service, repo, http } = build();
    repo.upsertFromWebhook.mockResolvedValue({ id: 's1', ...comment, channelId: 'ch1', parentExternalId: null, isFromPage: false });
    http.getMedia.mockRejectedValue(new Error('boom'));
    repo.findThread.mockResolvedValue({ id: 's1', replies: [] });

    await expect(service.ingest({ channelId: 'ch1', organizationId: 'org1', comment })).resolves.toEqual({ created: true });
    expect(repo.applyMediaToAll).not.toHaveBeenCalled();
  });

  it('canal inexistente: ignora', async () => {
    const { service, prisma, repo } = build();
    prisma.channel.findUnique.mockResolvedValue(null);
    await expect(service.ingest({ channelId: 'nope', organizationId: 'org1', comment })).resolves.toEqual({ created: false });
    expect(repo.upsertFromWebhook).not.toHaveBeenCalled();
  });
});
