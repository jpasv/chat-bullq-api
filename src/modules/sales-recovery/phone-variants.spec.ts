import { phoneVariants } from './sales-recovery.service';

describe('phoneVariants', () => {
  it('celular BR com 9 gera também sem 9 e com +', () => {
    expect(phoneVariants('+55 (21) 99045-1258').sort()).toEqual(
      ['+552190451258', '+5521990451258', '552190451258', '5521990451258'].sort(),
    );
  });

  it('celular BR sem 9 gera também com 9', () => {
    expect(phoneVariants('552190451258')).toContain('5521990451258');
  });

  it('vazio não gera nada', () => {
    expect(phoneVariants(null)).toEqual([]);
    expect(phoneVariants('')).toEqual([]);
  });
});
