import { toPublicPage } from './public-page';

describe('toPublicPage', () => {
  it('monta a página pública com hasMore=true quando há mais itens', () => {
    const res = toPublicPage([{ id: 'a' }, { id: 'b' }], 10, 1, 2);
    expect(res).toEqual({ items: [{ id: 'a' }, { id: 'b' }], page: 1, limit: 2, total: 10, hasMore: true });
  });

  it('hasMore=false na última página', () => {
    const res = toPublicPage([{ id: 'a' }], 3, 2, 2);
    expect(res.hasMore).toBe(false);
  });

  it('hasMore=false quando total=0', () => {
    expect(toPublicPage([], 0, 1, 20).hasMore).toBe(false);
  });
});
