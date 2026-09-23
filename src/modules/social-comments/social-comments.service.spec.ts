import { BadGatewayException, BadRequestException, NotFoundException } from '@nestjs/common';
import { SocialCommentsService } from './social-comments.service';

const channel = { id: 'ch1', organizationId: 'org1', config: { igBusinessId: '1784' } };
const root = {
  id: 's1', organizationId: 'org1', channelId: 'ch1', externalId: 'c1', parentExternalId: null,
  mediaId: 'm1', authorExternalId: '5550001', authorUsername: 'maria.s', text: 'Quanto custa?',
  status: 'VISIBLE', isFromPage: false, repliedAt: null, privateReplyConversationId: null,
  commentedAt: new Date('2026-09-22T12:00:00Z'),
};

function build() {
  const prisma = {
    channel: { findUnique: jest.fn().mockResolvedValue(channel) },
  };
  const repo = {
    findById: jest.fn().mockResolvedValue(root),
    listRoots: jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
    createOrUpdateFromWebhook: jest.fn(),
    update: jest.fn().mockImplementation(async (_id, data) => ({ ...root, ...data })),
    markParentReplied: jest.fn().mockResolvedValue(undefined),
    findThread: jest.fn().mockResolvedValue({ ...root, replies: [] }),
  };
  const http = {
    replyToComment: jest.fn().mockResolvedValue({ id: 'c2' }),
    deleteComment: jest.fn().mockResolvedValue(undefined),
    setCommentHidden: jest.fn().mockResolvedValue(undefined),
  };
  const channelAccess = {
    hasAccess: jest.fn().mockReturnValue(true),
    assertChannelAccess: jest.fn(),
  };
  const realtime = { emitToChannel: jest.fn() };
  const service = new SocialCommentsService(
    prisma as any, repo as any, http as any, channelAccess as any, realtime as any,
    {} as any, {} as any, {} as any, {} as any,
  );
  return { service, prisma, repo, http, channelAccess, realtime };
}

describe('SocialCommentsService', () => {
  describe('list', () => {
    it('AGENT com Set de canais filtra por channelIds', async () => {
      const { service, repo } = build();
      await service.list('org1', new Set(['ch1', 'ch2']), { limit: 10 });
      expect(repo.listRoots).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: 'org1', channelIds: ['ch1', 'ch2'], limit: 10 }),
      );
    });

    it('unreplied="true" vira boolean', async () => {
      const { service, repo } = build();
      await service.list('org1', 'ALL', { unreplied: 'true' });
      expect(repo.listRoots).toHaveBeenCalledWith(expect.objectContaining({ unreplied: true, channelIds: undefined, limit: 30 }));
    });
  });

  describe('reply', () => {
    it('chama Graph, grava reply isFromPage e marca pai', async () => {
      const { service, repo, http, realtime } = build();
      repo.createOrUpdateFromWebhook.mockResolvedValue({ row: { id: 's2' }, created: true });

      const out = await service.reply('s1', 'org1', 'u1', 'ALL', 'Custa R$ 99');

      expect(http.replyToComment).toHaveBeenCalledWith(channel, 'c1', 'Custa R$ 99');
      expect(repo.createOrUpdateFromWebhook).toHaveBeenCalledWith(expect.objectContaining({
        externalId: 'c2', parentExternalId: 'c1', authorExternalId: '1784', isFromPage: true, text: 'Custa R$ 99',
      }));
      expect(repo.markParentReplied).toHaveBeenCalledWith('ch1', 'c1', 'u1');
      expect(realtime.emitToChannel).toHaveBeenCalledWith('ch1', 'comment:updated', expect.objectContaining({ id: 's1' }));
      expect(out.id).toBe('s1');
    });

    it('Graph falhou: não persiste e sobe BadGateway', async () => {
      const { service, repo, http } = build();
      http.replyToComment.mockRejectedValue(new Error('[#10] permission denied'));
      await expect(service.reply('s1', 'org1', 'u1', 'ALL', 'x')).rejects.toBeInstanceOf(BadGatewayException);
      expect(repo.createOrUpdateFromWebhook).not.toHaveBeenCalled();
    });

    it('comentário de outra org: 404', async () => {
      const { service } = build();
      await expect(service.reply('s1', 'org2', 'u1', 'ALL', 'x')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('comentário DELETED: 400', async () => {
      const { service, repo } = build();
      repo.findById.mockResolvedValue({ ...root, status: 'DELETED' });
      await expect(service.reply('s1', 'org1', 'u1', 'ALL', 'x')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('setHidden', () => {
    it('true => HIDDEN, false => VISIBLE', async () => {
      const { service, repo, http } = build();
      await service.setHidden('s1', 'org1', 'ALL', true);
      expect(http.setCommentHidden).toHaveBeenCalledWith(channel, 'c1', true);
      expect(repo.update).toHaveBeenCalledWith('s1', { status: 'HIDDEN' });
      await service.setHidden('s1', 'org1', 'ALL', false);
      expect(repo.update).toHaveBeenCalledWith('s1', { status: 'VISIBLE' });
    });
  });

  describe('remove', () => {
    it('chama Graph e marca DELETED', async () => {
      const { service, repo, http } = build();
      await service.remove('s1', 'org1', 'ALL');
      expect(http.deleteComment).toHaveBeenCalledWith(channel, 'c1');
      expect(repo.update).toHaveBeenCalledWith('s1', { status: 'DELETED' });
    });
  });
});
