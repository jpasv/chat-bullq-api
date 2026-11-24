import { cleanKirvanoId, normalizeKirvano } from './kirvano-payload';

describe('cleanKirvanoId', () => {
  it('"null"/vazio viram null', () => {
    expect(cleanKirvanoId('null')).toBeNull();
    expect(cleanKirvanoId(' NULL ')).toBeNull();
    expect(cleanKirvanoId('')).toBeNull();
    expect(cleanKirvanoId(null)).toBeNull();
    expect(cleanKirvanoId(undefined)).toBeNull();
  });

  it('id de verdade passa', () => {
    expect(cleanKirvanoId('8315809b')).toBe('8315809b');
    expect(cleanKirvanoId(123)).toBe('123');
  });
});

describe('normalizeKirvano', () => {
  it('carrinho abandonado com checkout_id "null" não tem checkoutId', () => {
    const k = normalizeKirvano({
      event: 'ABANDONED_CART',
      checkout_id: 'null',
      sale_id: null,
      customer: { name: 'Jessica', phone_number: '5548999884434' },
      products: [{ id: 'p1', name: 'Curso' }],
    });
    expect(k.checkoutId).toBeNull();
    expect(k.saleId).toBeNull();
    expect(k.customerPhone).toBe('5548999884434');
  });
});
