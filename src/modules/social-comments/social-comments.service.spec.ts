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
    sendPrivateReply: jest.fn().mockResolvedValue({ recipient_id: '5550001', message_id: 'mid1' }),
  };
  const channelAccess = {
    hasAccess: jest.fn().mockReturnValue(true),
    assertChannelAccess: jest.fn(),
  };
  const realtime = { emitToChannel: jest.fn(), emitToConversation: jest.fn() };
  const contactResolver = {
    resolveByExternalId: jest.fn().mockResolvedValue({ contactId: 'ct1', contactChannelId: 'cc1', isNew: true }),
  };
  const conversationResolver = {
    resolveForOperator: jest.fn().mockResolvedValue({ conversationId: 'conv1', status: 'OPEN', isNew: true, wasReopened: false }),
  };
  const messagesRepo = { create: jest.fn().mockResolvedValue({ id: 'msg1' }) };
  const llm = { complete: jest.fn() };
  (prisma as any).conversation = { update: jest.fn().mockResolvedValue({}) };
  const service = new SocialCommentsService(
    prisma as any, repo as any, http as any, channelAccess as any, realtime as any,
    contactResolver as any, conversationResolver as any, messagesRepo as any, llm as any,
  );
  return {
    service, prisma, repo, http, channelAccess, realtime,
    contactResolver, conversationResolver, messagesRepo, llm,
  };
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

  describe('privateReply', () => {
    it('envia DM, cria contato/conversa/mensagem e grava conversationId', async () => {
      const { service, http, contactResolver, conversationResolver, messagesRepo, repo, realtime } = build();

      const out = await service.privateReply('s1', 'org1', 'u1', 'ALL', 'Oi Maria, te chamei no direct');

      expect(http.sendPrivateReply).toHaveBeenCalledWith(channel, 'c1', 'Oi Maria, te chamei no direct');
      expect(contactResolver.resolveByExternalId).toHaveBeenCalledWith('org1', 'ch1', '5550001', 'maria.s');
      expect(conversationResolver.resolveForOperator).toHaveBeenCalledWith('org1', 'ch1', 'ct1', 'u1');
      expect(messagesRepo.create).toHaveBeenCalledWith(expect.objectContaining({
        conversationId: 'conv1', direction: 'OUTBOUND', type: 'TEXT', status: 'SENT',
        externalId: 'mid1', senderId: 'u1', content: { text: 'Oi Maria, te chamei no direct' },
      }));
      expect(repo.update).toHaveBeenCalledWith('s1', { privateReplyConversationId: 'conv1' });
      expect(realtime.emitToChannel).toHaveBeenCalledWith('ch1', 'message:new', expect.objectContaining({ conversationId: 'conv1' }));
      expect(realtime.emitToConversation).toHaveBeenCalledWith(
        'conv1', 'message:new', expect.objectContaining({ message: expect.anything() }),
      );
      expect(out).toEqual({ conversationId: 'conv1' });

      // Idempotência: contato/conversa resolvidos ANTES do envio real da DM
      // (get-or-create, seguro repetir), e o guard durável (repo.update)
      // gravado logo após o envio, antes de qualquer outro passo que possa
      // falhar — assim um retry cai no 409 em vez de mandar 2ª DM.
      expect(conversationResolver.resolveForOperator.mock.invocationCallOrder[0])
        .toBeLessThan(http.sendPrivateReply.mock.invocationCallOrder[0]);
      expect(repo.update.mock.invocationCallOrder[0])
        .toBeLessThan(messagesRepo.create.mock.invocationCallOrder[0]);
    });

    it('segunda tentativa: 409 com conversationId', async () => {
      const { service, repo, http } = build();
      repo.findById.mockResolvedValue({ ...root, privateReplyConversationId: 'conv0' });
      await expect(service.privateReply('s1', 'org1', 'u1', 'ALL', 'x')).rejects.toMatchObject({
        status: 409,
        response: expect.objectContaining({ conversationId: 'conv0' }),
      });
      expect(http.sendPrivateReply).not.toHaveBeenCalled();
    });
  });
});
