import {
  adjustToSendWindow,
  onboardingReplyDelayMs,
  stripTrailingPeriod,
  firstName,
  isRio,
  LeadSnapshot,
  nextAttemptDelayHours,
  renderAttempt,
  revenueQualifies,
} from './onboarding-rules';

// Horários em Brasília (UTC-3, sem horário de verão).
const brt = (iso: string) => new Date(`${iso}-03:00`);

const lead = (over: Partial<LeadSnapshot> = {}): LeadSnapshot => ({
  name: 'Mayara de Souza e Silva',
  firstName: 'Mayara',
  phone: '5511975286081',
  email: null,
  produto: '57 Agents Advocacia',
  progresso: null,
  atuacao: null,
  equipe: null,
  faturamento: null,
  estado: null,
  gargalo: null,
  meta: null,
  ...over,
});

describe('adjustToSendWindow', () => {
  it('23h vai pras 8h do dia seguinte', () => {
    expect(adjustToSendWindow(brt('2026-10-18T23:00:00')).toISOString()).toBe(
      brt('2026-10-19T08:00:00').toISOString(),
    );
  });
  it('10h fica como está', () => {
    const at = brt('2026-10-18T10:00:00');
    expect(adjustToSendWindow(at).toISOString()).toBe(at.toISOString());
  });
  it('7h59 vai pras 8h do mesmo dia', () => {
    expect(adjustToSendWindow(brt('2026-10-18T07:59:00')).toISOString()).toBe(
      brt('2026-10-18T08:00:00').toISOString(),
    );
  });
  it('20h em ponto já está fora da janela', () => {
    expect(adjustToSendWindow(brt('2026-10-18T20:00:00')).toISOString()).toBe(
      brt('2026-10-19T08:00:00').toISOString(),
    );
  });
});

describe('nextAttemptDelayHours', () => {
  it('segue a cadência 4, 24, 24 e para depois', () => {
    expect(nextAttemptDelayHours(1, [4, 24, 24])).toBe(4);
    expect(nextAttemptDelayHours(2, [4, 24, 24])).toBe(24);
    expect(nextAttemptDelayHours(3, [4, 24, 24])).toBe(24);
    expect(nextAttemptDelayHours(4, [4, 24, 24])).toBeNull();
  });
});

describe('isRio', () => {
  it('DDD 21 é Rio', () => {
    expect(isRio('5521990451258')).toBe(true);
    expect(isRio('+55 (21) 99045-1258')).toBe(true);
    expect(isRio('5511975286081')).toBe(false);
    expect(isRio(null)).toBe(false);
  });
});

describe('revenueQualifies', () => {
  it('corte em R$ 50 mil/mês', () => {
    expect(revenueQualifies('R$ 10.000 a R$ 50.000')).toBe(false);
    expect(revenueQualifies('Até R$ 10.000')).toBe(false);
    expect(revenueQualifies('R$ 50.000 a R$ 200.000')).toBe(true);
    expect(revenueQualifies('R$ 200.000 a R$ 1 milhão')).toBe(true);
    expect(revenueQualifies('Acima de R$ 1 milhão')).toBe(true);
    expect(revenueQualifies('Prefiro não informar')).toBeNull();
    expect(revenueQualifies(null)).toBeNull();
  });
});

describe('renderAttempt', () => {
  it('mensagem 1 varia pelo progresso do formulário', () => {
    const msg = renderAttempt(
      1,
      lead({ progresso: 'Ainda não tive tempo de começar' }),
    );
    expect(msg).toBe(
      'Oi, Mayara! Aqui é da Bravy. Você comentou no formulário que ainda não tinha começado com o 57 Agents Advocacia. Conseguiu olhar desde então?',
    );
  });
  it('mensagem 1 sem progresso usa a abertura geral', () => {
    expect(renderAttempt(1, lead())).toBe(
      'Oi, Mayara! Aqui é da Bravy. Você conseguiu começar a usar o 57 Agents Advocacia ou ficou alguma dúvida?',
    );
  });
  it('mensagens 2 e 3 são as do spec', () => {
    expect(renderAttempt(2, lead())).toBe(
      'Mayara, ficou alguma dúvida para começar a usar o 57 Agents Advocacia? Pode me contar por aqui',
    );
    expect(renderAttempt(3, lead())).toBe(
      'Vou encerrar esse acompanhamento por aqui, Mayara. Se precisar de ajuda com o 57 Agents Advocacia, pode escrever neste número',
    );
  });
  it('nunca envia placeholder vazio', () => {
    const msg = renderAttempt(2, lead({ firstName: '', name: null, produto: null }));
    expect(msg).not.toMatch(/\{|\}/);
    expect(msg).toBe(
      'Ficou alguma dúvida para começar a usar o produto? Pode me contar por aqui',
    );
  });
});

describe('firstName', () => {
  it('pega o primeiro nome capitalizado', () => {
    expect(firstName('RHIANN brigido pereira')).toBe('Rhiann');
    expect(firstName(null)).toBe('');
  });
});

describe('stripTrailingPeriod', () => {
  it('tira o ponto final de cada linha e mantém o resto', () => {
    expect(stripTrailingPeriod('Pode olhar com calma.')).toBe('Pode olhar com calma');
    expect(stripTrailingPeriod('Tudo bem. Me chama aqui.\nAbraço.')).toBe('Tudo bem. Me chama aqui\nAbraço');
    expect(stripTrailingPeriod('Conseguiu olhar?')).toBe('Conseguiu olhar?');
    expect(stripTrailingPeriod('Deixa eu ver...')).toBe('Deixa eu ver...');
    expect(stripTrailingPeriod('Link: https://bravy.com.br.')).toBe('Link: https://bravy.com.br');
  });
});

describe('onboardingReplyDelayMs', () => {
  it('fica entre 30 e 45 segundos', () => {
    expect(onboardingReplyDelayMs(() => 0)).toBe(30_000);
    expect(onboardingReplyDelayMs(() => 0.999999)).toBeLessThanOrEqual(45_000);
    expect(onboardingReplyDelayMs(() => 0.5)).toBe(37_500);
  });
});
