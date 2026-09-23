import { Prisma } from '@prisma/client';
import { SocialCommentsRepository } from './social-comments.repository';

function build() {
  const prisma = {
    socialComment: {
      create: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
  };
  const repo = new SocialCommentsRepository(prisma as any);
  return { repo, prisma };
}

const webhookData = {
  organizationId: 'org1',
  channelId: 'ch1',
  externalId: 'c1',
  mediaId: 'm1',
  authorExternalId: '5550001',
  text: 'Quanto custa?',
  isFromPage: false,
  commentedAt: new Date('2026-09-22T12:00:00Z'),
};

describe('SocialCommentsRepository', () => {
  describe('createOrUpdateFromWebhook', () => {
    it('create resolve: created true', async () => {
      const { repo, prisma } = build();
      prisma.socialComment.create.mockResolvedValue({ id: 's1' });

      const out = await repo.createOrUpdateFromWebhook(webhookData);

      expect(out).toEqual({ row: { id: 's1' }, created: true });
      expect(prisma.socialComment.update).not.toHaveBeenCalled();
    });

    it('create rejeita com P2002: cai pro update e created false', async () => {
      const { repo, prisma } = build();
      const p2002 = new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'x',
      });
      prisma.socialComment.create.mockRejectedValue(p2002);
      prisma.socialComment.update.mockResolvedValue({ id: 's1', text: webhookData.text });

      const out = await repo.createOrUpdateFromWebhook(webhookData);

      expect(prisma.socialComment.update).toHaveBeenCalledWith({
        where: {
          uq_social_comment_external: { channelId: 'ch1', externalId: 'c1' },
        },
        data: { text: webhookData.text, authorUsername: undefined },
      });
      expect(out).toEqual({ row: { id: 's1', text: webhookData.text }, created: false });
    });

    it('create rejeita com erro genérico: rejoga e não chama update', async () => {
      const { repo, prisma } = build();
      const err = new Error('boom');
      prisma.socialComment.create.mockRejectedValue(err);

      await expect(repo.createOrUpdateFromWebhook(webhookData)).rejects.toBe(err);
      expect(prisma.socialComment.update).not.toHaveBeenCalled();
    });
  });

  describe('listRoots — construção do where', () => {
    it('channelIds + channelId incluso: usa o channelId', async () => {
      const { repo, prisma } = build();
      prisma.socialComment.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      await repo.listRoots({
        organizationId: 'org1',
        channelIds: ['a', 'b'],
        channelId: 'b',
        limit: 10,
      });

      const where = prisma.socialComment.findMany.mock.calls[0][0].where;
      expect(where.channelId).toBe('b');
    });

    it('channelIds sem o channelId pedido: where.channelId vira { in: [] }', async () => {
      const { repo, prisma } = build();
      prisma.socialComment.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      await repo.listRoots({
        organizationId: 'org1',
        channelIds: ['a'],
        channelId: 'b',
        limit: 10,
      });

      const where = prisma.socialComment.findMany.mock.calls[0][0].where;
      expect(where.channelId).toEqual({ in: [] });
    });

    it('unreplied: repliedAt null, status VISIBLE, isFromPage false', async () => {
      const { repo, prisma } = build();
      prisma.socialComment.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      await repo.listRoots({
        organizationId: 'org1',
        unreplied: true,
        limit: 10,
      });

      const where = prisma.socialComment.findMany.mock.calls[0][0].where;
      expect(where.repliedAt).toBeNull();
      expect(where.status).toBe('VISIBLE');
      expect(where.isFromPage).toBe(false);
    });
  });

  describe('listRoots — paginação keyset', () => {
    it('com cursor: monta where.OR e não usa cursor/skip do Prisma', async () => {
      const { repo, prisma } = build();
      prisma.socialComment.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      await repo.listRoots({
        organizationId: 'org1',
        cursor: '1758542400000_s9',
        limit: 10,
      });

      const args = prisma.socialComment.findMany.mock.calls[0][0];
      expect(args.where.OR).toEqual([
        { commentedAt: { lt: new Date(1758542400000) } },
        { commentedAt: new Date(1758542400000), id: { lt: 's9' } },
      ]);
      expect(args).not.toHaveProperty('cursor');
      expect(args).not.toHaveProperty('skip');
    });

    it('limit 2 e 3 linhas retornadas: 2 itens e nextCursor da segunda linha', async () => {
      const { repo, prisma } = build();
      const rows = [
        { id: 'r1', channelId: 'ch1', externalId: 'e1', commentedAt: new Date(3000) },
        { id: 'r2', channelId: 'ch1', externalId: 'e2', commentedAt: new Date(2000) },
        { id: 'r3', channelId: 'ch1', externalId: 'e3', commentedAt: new Date(1000) },
      ];
      prisma.socialComment.findMany.mockResolvedValueOnce(rows).mockResolvedValueOnce([]);

      const out = await repo.listRoots({ organizationId: 'org1', limit: 2 });

      expect(out.items).toHaveLength(2);
      expect(out.nextCursor).toBe(`${new Date(2000).getTime()}_r2`);
    });

    it('2 linhas retornadas com limit 2: nextCursor null', async () => {
      const { repo, prisma } = build();
      const rows = [
        { id: 'r1', channelId: 'ch1', externalId: 'e1', commentedAt: new Date(3000) },
        { id: 'r2', channelId: 'ch1', externalId: 'e2', commentedAt: new Date(2000) },
      ];
      prisma.socialComment.findMany.mockResolvedValueOnce(rows).mockResolvedValueOnce([]);

      const out = await repo.listRoots({ organizationId: 'org1', limit: 2 });

      expect(out.items).toHaveLength(2);
      expect(out.nextCursor).toBeNull();
    });
  });
});
