import { InstagramMessageMapper } from './instagram.message-mapper';

const mapper = new InstagramMessageMapper();

describe('InstagramMessageMapper.normalizeComment', () => {
  const base = {
    id: '17890000000000001',
    text: 'Quanto custa?',
    from: { id: '5550001', username: 'maria.s' },
    media: { id: '18000000000000002', media_product_type: 'FEED' },
  };

  it('normaliza comentário raiz', () => {
    const out = mapper.normalizeComment(base, 1758542400);
    expect(out).toEqual({
      externalId: '17890000000000001',
      parentExternalId: undefined,
      mediaId: '18000000000000002',
      mediaProductType: 'FEED',
      authorExternalId: '5550001',
      authorUsername: 'maria.s',
      text: 'Quanto custa?',
      commentedAt: new Date(1758542400 * 1000),
      rawPayload: base,
    });
  });

  it('normaliza reply com parent_id', () => {
    const out = mapper.normalizeComment({ ...base, parent_id: '17890000000000000' });
    expect(out?.parentExternalId).toBe('17890000000000000');
  });

  it('usa agora quando entry.time ausente', () => {
    const before = Date.now();
    const out = mapper.normalizeComment(base);
    expect(out!.commentedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('retorna null sem id, sem from.id ou sem media.id', () => {
    expect(mapper.normalizeComment({ ...base, id: undefined })).toBeNull();
    expect(mapper.normalizeComment({ ...base, from: {} })).toBeNull();
    expect(mapper.normalizeComment({ ...base, media: {} })).toBeNull();
  });

  it('texto ausente vira string vazia', () => {
    expect(mapper.normalizeComment({ ...base, text: undefined })?.text).toBe('');
  });
});
