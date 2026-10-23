import { BadRequestException } from '@nestjs/common';
import { matchesKeywords, validateIgFlowNodes } from './ig-flows.validator';

describe('matchesKeywords', () => {
  it('sem palavras-chave casa qualquer texto', () => {
    expect(matchesKeywords('qualquer coisa', [])).toBe(true);
    expect(matchesKeywords('qualquer coisa', undefined)).toBe(true);
  });

  it('ignora acento e caixa, contains por padrão', () => {
    expect(matchesKeywords('Quero a AULA grátis!', ['gratis'])).toBe(true);
    expect(matchesKeywords('Quero', ['aula'])).toBe(false);
  });

  it('exact exige o texto inteiro', () => {
    expect(matchesKeywords(' Live ', ['live'], 'exact')).toBe(true);
    expect(matchesKeywords('quero a live', ['live'], 'exact')).toBe(false);
  });
});

describe('validateIgFlowNodes', () => {
  const ok = [
    { id: 'c', type: 'condition', check: 'follows', onTrue: 'm1', onFalse: 'm2' },
    { id: 'm1', type: 'message', text: 'oi', buttons: [{ id: 'b1', title: 'Grupo', type: 'url', url: 'https://x.com', next: 'h' }] },
    { id: 'm2', type: 'message', text: 'segue', buttons: [{ id: 'b2', title: 'Tô seguindo', type: 'postback', next: 'c' }] },
    { id: 'h', type: 'http', url: 'https://hook', next: 'd' },
    { id: 'd', type: 'delay', seconds: 600 },
  ];

  it('aceita o fluxo do exemplo', () => {
    expect(validateIgFlowNodes(ok, 'c')).toHaveLength(5);
  });

  it('rejeita referência quebrada', () => {
    const bad = [...ok.slice(0, 4), { id: 'd', type: 'delay', seconds: 1, next: 'nao-existe' }];
    expect(() => validateIgFlowNodes(bad, 'c')).toThrow(BadRequestException);
  });

  it('rejeita postback sem next e título longo', () => {
    expect(() =>
      validateIgFlowNodes([{ id: 'm', type: 'message', text: 'x', buttons: [{ id: 'b', title: 'ok', type: 'postback' }] }], 'm'),
    ).toThrow(/next/);
    expect(() =>
      validateIgFlowNodes([{ id: 'm', type: 'message', text: 'x', buttons: [{ id: 'b', title: 'x'.repeat(21), type: 'url', url: 'https://a' }] }], 'm'),
    ).toThrow(/20/);
  });

  it('rejeita startNodeId inexistente', () => {
    expect(() => validateIgFlowNodes(ok, 'zzz')).toThrow(/startNodeId/);
  });
});
