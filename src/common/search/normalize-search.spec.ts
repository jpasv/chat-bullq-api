import { normalizeSearchText, toPhoneSearch } from './normalize-search';

describe('normalizeSearchText', () => {
  it('ignora maiúscula, acento e espaço sobrando', () => {
    for (const input of ['joao', 'João', 'JOÃO', '  joão  ', 'Jo\u0061\u0303o']) {
      expect(normalizeSearchText(input)).toBe('joao');
    }
  });

  it('normaliza cedilha e letras sem decomposição', () => {
    expect(normalizeSearchText('Conceição Ørsted Łódź')).toBe('conceicao orsted lodz');
  });

  it('junta espaços repetidos', () => {
    expect(normalizeSearchText('maria   da  silva')).toBe('maria da silva');
  });
});

describe('toPhoneSearch', () => {
  it('tira a formatação de quem digita telefone', () => {
    expect(toPhoneSearch('(21) 99045-1258')).toBe('21990451258');
    expect(toPhoneSearch('+55 21 99045')).toBe('552199045');
  });

  it('não trata nome como telefone', () => {
    expect(toPhoneSearch('joão 2')).toBeNull();
    expect(toPhoneSearch('   ')).toBeNull();
  });
});
