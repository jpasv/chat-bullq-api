import { ChannelType } from '@prisma/client';
import { InstagramInboundAdapter } from './instagram.inbound-adapter';
import { InstagramMessageMapper } from './instagram.message-mapper';

const adapter = new InstagramInboundAdapter(new InstagramMessageMapper());

const channel = {
  id: 'ch1',
  type: ChannelType.INSTAGRAM,
  config: { igBusinessId: '1784' },
} as any;

const commentChange = {
  field: 'comments',
  value: {
    id: '17890000000000001',
    text: 'Quanto custa?',
    from: { id: '5550001', username: 'maria.s' },
    media: { id: '18000000000000002', media_product_type: 'FEED' },
  },
};

describe('InstagramInboundAdapter.parseWebhook — comments', () => {
  it('extrai comentários de entry.changes junto com mensagens', () => {
    const payload = {
      object: 'instagram',
      entry: [
        {
          id: '1784',
          time: 1758542400,
          changes: [commentChange],
          messaging: [
            {
              sender: { id: '999' },
              recipient: { id: '1784' },
              timestamp: 1758542400000,
              message: { mid: 'm1', text: 'oi' },
            },
          ],
        },
      ],
    };

    const out = adapter.parseWebhook(payload, channel);
    expect(out.messages).toHaveLength(1);
    expect(out.comments).toHaveLength(1);
    expect(out.comments![0]).toMatchObject({
      externalId: '17890000000000001',
      mediaId: '18000000000000002',
      authorExternalId: '5550001',
      commentedAt: new Date(1758542400 * 1000),
    });
  });

  it('ignora changes de outro entry.id', () => {
    const out = adapter.parseWebhook(
      { entry: [{ id: '0000', changes: [commentChange] }] },
      channel,
    );
    expect(out.comments).toEqual([]);
  });

  it('ignora changes com field diferente de comments', () => {
    const out = adapter.parseWebhook(
      { entry: [{ id: '1784', changes: [{ ...commentChange, field: 'mentions' }] }] },
      channel,
    );
    expect(out.comments).toEqual([]);
  });

  it('payload sem changes retorna comments vazio', () => {
    const out = adapter.parseWebhook({ entry: [{ id: '1784' }] }, channel);
    expect(out.comments).toEqual([]);
  });
});
