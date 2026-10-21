import {
  buildPromptContext,
  isAcknowledgement,
  adjustToSendWindow,
  onboardingReplyDelayMs,
  stripTrailingPeriod,
  firstName,
  isLikelyAutoReply,
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
  it('mensagem 1: dois balões, segundo varia pelo progresso', () => {
    expect(renderAttempt(1, lead({ progresso: 'Ainda não tive tempo de começar' }))).toEqual([
      'Oi Mayara, tudo bem? Aqui é da Bravy',
      'vi no formulário que você ainda não tinha começado com o 57 Agents Advocacia, conseguiu mexer?',
    ]);
  });
  it('mensagem 1 sem progresso usa a abertura geral', () => {
    expect(renderAttempt(1, lead())[1]).toBe('vi que você pegou o 57 Agents Advocacia, conseguiu começar?');
  });
  it('nome de vitrine do produto vira "o curso"', () => {
    expect(renderAttempt(1, lead({ produto: 'Gravação Masterclass Vibecoding' }))[1]).toBe(
      'vi que você pegou o curso, conseguiu começar?',
    );
  });
  it('mensagens 2 e 3', () => {
    expect(renderAttempt(2, lead())).toEqual([
      'Mayara, conseguiu dar uma olhada? se travou em alguma coisa me fala que eu te ajudo',
    ]);
    expect(renderAttempt(3, lead())).toEqual([
      'Mayara, como você é cliente, tem um diagnóstico de IA de 1h com o Tiago, sem custo, pra olhar o seu dia a dia e sair sabendo o que automatizar primeiro',
      'essa semana ainda tem horário, quer que eu separe um pra você?',
    ]);
  });
  it('nunca envia placeholder vazio nem ponto final', () => {
    const msgs = renderAttempt(1, lead({ firstName: '', name: null, produto: null }));
    expect(msgs).toEqual(['Oi, tudo bem? Aqui é da Bravy', 'vi que você começou com a gente, conseguiu mexer?']);
    for (const m of [...msgs, ...renderAttempt(2, lead()), ...renderAttempt(3, lead())]) {
      expect(m).not.toMatch(/[{}]|\.$/);
    }
  });
});

describe('consultoria comprada', () => {
  it('1ª mensagem fala da consultoria, não do diagnóstico', () => {
    const msgs = renderAttempt(1, lead({ consultoria: true }));
    expect(msgs[0]).toBe('Oi Mayara, tudo bem? Aqui é o Tiago, da Bravy');
    expect(msgs[1]).toContain('consultoria individual de 90 min');
  });
  it('contexto manda agendar sem qualificar', () => {
    expect(buildPromptContext(lead({ consultoria: true }), { attempt: 1, state: 'CONTACTED' })).toContain('NÃO qualifique');
  });
});

describe('isAcknowledgement', () => {
  it('reconhece fechamentos curtos', () => {
    for (const t of ['Ok', 'ok!', 'Blz', 'valeu', 'Obrigado!', 'ok, obrigado', 'tá bom', 'pode deixar', '👍', 'Beleza.']) {
      expect(isAcknowledgement(t)).toBe(true);
    }
  });
  it('não confunde resposta de verdade', () => {
    for (const t of ['Ainda não tentei. Só amanhã', 'sim', 'ok mas não achei a aula', 'quinta às 10h', '', null]) {
      expect(isAcknowledgement(t as any)).toBe(false);
    }
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

describe('isLikelyAutoReply', () => {
  const sent = new Date('2026-10-19T17:14:01.000Z');
  const at = (s: number) => new Date(sent.getTime() + s * 1000);
  it('chegou em segundos depois da tentativa', () => {
    expect(isLikelyAutoReply('Olá! Como posso ajudar?', sent, at(3))).toBe(true);
  });
  it('frase típica de WhatsApp Business nos primeiros minutos (casos reais)', () => {
    expect(isLikelyAutoReply('Leandro Crispim (Empresário Contábil) agradece seu contato. Como podemos ajudar?', sent, at(60))).toBe(true);
    expect(isLikelyAutoReply('Aline Sales Contadora agradece seu contato. Preenche o formulário e me conte sua dúvida', sent, at(90))).toBe(true);
    expect(isLikelyAutoReply('Olá, Tiago! Sou o assistente do Dr. Alexandre Ramalho.', sent, at(40))).toBe(true);
  });
  it('resposta de gente não é automática', () => {
    expect(isLikelyAutoReply('Ainda não / Quero instalar de noite', sent, at(60))).toBe(false);
    expect(isLikelyAutoReply('obrigado pelo contato, vou olhar hoje', sent, at(3 * 3600))).toBe(false);
  });
});
