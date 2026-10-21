import { LeadOnboardingService } from './lead-onboarding.service';
import { HumanConversationError } from './onboarding-messenger.service';
import { ATIVIDADE, HOPPE_FIELD, HOPPE_STATUS } from './lead-onboarding.constants';

const brt = (iso: string) => new Date(`${iso}-03:00`);
const TASK = 'c132c764-f2fd-4f8a-bc12-39af873100d8';

const task = (over: Record<string, any> = {}) => ({
  id: TASK,
  name: 'Mayara de Souza e Silva',
  statusName: 'nova oportunidade',
  tags: ['abordar-ia'],
  fields: {
    WhatsApp: '+5511975286081',
    Produtos: ['57 Agents Advocacia'],
    'Progresso com o produto': 'Ainda não tive tempo de começar',
    'Faturamento mensal': 'R$ 50.000 a R$ 200.000',
  },
  ...over,
});

const leadRow = (over: Record<string, any> = {}) => ({
  id: 'lead1',
  organizationId: 'org1',
  hoppeTaskId: TASK,
  state: 'PENDING',
  attempt: 0,
  conversationId: null,
  contactId: null,
  phone: null,
  attemptDates: [],
  snapshot: {},
  nextActionAt: new Date(0),
  pendingReason: null,
  pendingDetail: null,
  resumeSentAt: null,
  ...over,
});

function build(opts: { lead?: any; task?: any; firstAttemptsToday?: number } = {}) {
  const lead = opts.lead ?? leadRow();
  const repo = {
    findDue: jest.fn().mockResolvedValue([lead]),
    findSummaryDue: jest.fn().mockResolvedValue([]),
    countFirstAttemptsSince: jest.fn().mockResolvedValue(opts.firstAttemptsToday ?? 0),
    update: jest.fn(async (_id, data) => ({ ...lead, ...data })),
    findByConversation: jest.fn(),
    claim: jest.fn().mockResolvedValue(true),
    boughtConsultoria: jest.fn().mockResolvedValue(false),
    updateIfState: jest.fn(async (id: string, _states: string[], data: any) => {
      await repo.update(id, data);
      return true;
    }),
  };
  const hoppe = {
    getTask: jest.fn().mockResolvedValue(opts.task === undefined ? task() : opts.task),
    setStatus: jest.fn().mockResolvedValue(undefined),
    setField: jest.fn().mockResolvedValue(undefined),
    addTag: jest.fn().mockResolvedValue(undefined),
    addComment: jest.fn().mockResolvedValue(undefined),
    setAssignees: jest.fn().mockResolvedValue(undefined),
    setDates: jest.fn().mockResolvedValue(undefined),
  };
  const messenger = {
    returnFromSupport: jest.fn().mockResolvedValue(null),
    resolveTarget: jest
      .fn()
      .mockResolvedValue({ digits: '5511975286081', jid: '5511975286081@s.whatsapp.net' }),
    send: jest.fn().mockResolvedValue({ conversationId: 'conv1', contactId: 'ct1' }),
    setPromptContext: jest.fn().mockResolvedValue(undefined),
    pauseConversation: jest.fn().mockResolvedValue(undefined),
    hasRecentSystemOutbound: jest.fn().mockResolvedValue(false),
    conversationGuard: jest.fn().mockResolvedValue(null),
    outreachChannelId: jest.fn().mockReturnValue('oficial'),
    isOfficial: jest.fn().mockResolvedValue(true),
    reclaimOnboardingConversation: jest.fn().mockResolvedValue(false),
    transcript: jest.fn().mockResolvedValue('Lead: oi'),
    channelOf: jest.fn().mockResolvedValue('oficial'),
  };
  const config = {
    templates: { abertura: 'brvy_onb_abertura', lembrete: 'brvy_onb_lembrete', ultima: 'brvy_onb_ultima', retomada: 'brvy_onb_retomada', continuacao: 'brvy_onb_continuacao' },
    enabled: true,
    orgId: 'org1',
    cadenceHours: [4, 24, 24],
    sendWindow: { start: 8, end: 20 },
    dailyCap: 30,
  };
  const summaries = { summarize: jest.fn().mockResolvedValue(undefined) };
  const service = new LeadOnboardingService(
    repo as any,
    hoppe as any,
    messenger as any,
    config as any,
    summaries as any,
  );
  return { service, repo, hoppe, messenger, lead, config };
}

describe('LeadOnboardingService.tick', () => {
  it('PENDING dentro da janela envia a tentativa 1 e atualiza o Hoppe', async () => {
    const { service, repo, hoppe, messenger } = build();
    const now = brt('2026-10-18T16:00:00');
    await service.tick(now);

    expect(messenger.send).toHaveBeenCalledTimes(1);
    expect(messenger.send.mock.calls[0][0].text[1]).toContain('ainda não tinha começado com o 57 Agents Advocacia');
    expect(hoppe.addTag).toHaveBeenCalledWith(TASK, '1º mensagem');
    expect(hoppe.setAssignees).toHaveBeenCalledWith(TASK, { add: ['f16655b4-ad1c-4a12-998f-c29c319c1307'] });
    expect(hoppe.setDates).toHaveBeenCalledWith(TASK, expect.objectContaining({ start: now }));
    expect(hoppe.setField).toHaveBeenCalledWith(TASK, HOPPE_FIELD.ATIVIDADE, ATIVIDADE.ATIVO);
    expect(hoppe.addComment).toHaveBeenCalledWith(TASK, expect.stringContaining('1ª tentativa'));
    const data = repo.update.mock.calls.at(-1)![1];
    expect(data.state).toBe('CONTACTED');
    expect(data.attempt).toBe(1);
    expect(data.firstAttemptAt).toEqual(now);
    // 16h + 4h = 20h, fora da janela → 8h do dia seguinte.
    expect((data.nextActionAt as Date).toISOString()).toBe(brt('2026-10-19T08:00:00').toISOString());
  });

  it('PENDING às 22h só reagenda pras 8h', async () => {
    const { service, repo, messenger } = build();
    await service.tick(brt('2026-10-18T22:00:00'));
    expect(messenger.send).not.toHaveBeenCalled();
    expect(repo.update.mock.calls[0][1].nextActionAt.toISOString()).toBe(
      brt('2026-10-19T08:00:00').toISOString(),
    );
  });

  it('teto diário atingido só reagenda', async () => {
    const { service, repo, messenger } = build({ firstAttemptsToday: 30 });
    await service.tick(brt('2026-10-18T10:00:00'));
    expect(messenger.send).not.toHaveBeenCalled();
    expect(repo.update.mock.calls[0][1].nextActionAt.toISOString()).toBe(
      brt('2026-10-19T08:00:00').toISOString(),
    );
  });

  it('task fora de "nova oportunidade" vira SKIPPED com comentário', async () => {
    const { service, repo, hoppe, messenger } = build({ task: task({ statusName: 'em qualificação' }) });
    await service.tick(brt('2026-10-18T10:00:00'));
    expect(messenger.send).not.toHaveBeenCalled();
    expect(repo.update.mock.calls[0][1].state).toBe('SKIPPED');
    expect(hoppe.addComment).toHaveBeenCalledWith(TASK, expect.stringContaining('ignorado'));
  });

  it('número sem WhatsApp vira SKIPPED e Atividade Inativo', async () => {
    const { service, repo, hoppe, messenger } = build();
    messenger.resolveTarget.mockResolvedValue(null);
    await service.tick(brt('2026-10-18T10:00:00'));
    expect(messenger.send).not.toHaveBeenCalled();
    expect(repo.update.mock.calls[0][1].state).toBe('SKIPPED');
    expect(hoppe.setField).toHaveBeenCalledWith(TASK, HOPPE_FIELD.ATIVIDADE, ATIVIDADE.INATIVO);
  });

  it('conversa existente com o Tiago vira SKIPPED sem sequestrar', async () => {
    const { service, repo, hoppe, messenger } = build();
    messenger.send.mockRejectedValue(new HumanConversationError('conv9'));
    await service.tick(brt('2026-10-18T10:00:00'));
    expect(repo.update.mock.calls.at(-1)![1].state).toBe('SKIPPED');
    expect(hoppe.addComment).toHaveBeenCalledWith(TASK, expect.stringContaining('conversa existente'));
  });

  it('lead com conversa em outro canal recebe a tentativa pelo canal de abordagem, em conversa nova', async () => {
    const lead = leadRow({ state: 'CONTACTED', attempt: 1, conversationId: 'convOutro', phone: '5511975286081', snapshot: { firstName: 'Mayara', phone: '5511975286081', produto: '57 Agents Advocacia' } });
    const { service, messenger, repo } = build({ lead });
    messenger.channelOf.mockResolvedValue('outroCanal');
    messenger.send.mockResolvedValue({ conversationId: 'convNova', contactId: 'ct2' });
    await service.tick(brt('2026-10-20T10:00:00'));
    expect(messenger.send.mock.calls[0][0].conversationId).toBeUndefined();
    expect(messenger.pauseConversation).toHaveBeenCalledWith('convOutro');
    expect(repo.update.mock.calls.at(-1)![1].conversationId).toBe('convNova');
  });

  it('volta pra conversa antiga do onboarding no canal de abordagem em vez de pular', async () => {
    const { HumanConversationError } = jest.requireActual('./onboarding-messenger.service');
    const lead = leadRow({ state: 'CONTACTED', attempt: 1, conversationId: 'convOficial', phone: '5511975286081', snapshot: { firstName: 'Mayara', phone: '5511975286081' } });
    const { service, messenger, repo } = build({ lead });
    messenger.channelOf.mockResolvedValue('outroCanal');
    messenger.send
      .mockRejectedValueOnce(new HumanConversationError('conv1258Antiga'))
      .mockResolvedValueOnce({ conversationId: 'conv1258Antiga', contactId: 'ct1' });
    messenger.reclaimOnboardingConversation.mockResolvedValue(true);
    await service.tick(brt('2026-10-20T10:00:00'));
    expect(messenger.send.mock.calls[1][0].conversationId).toBe('conv1258Antiga');
    expect(repo.update.mock.calls.at(-1)![1].conversationId).toBe('conv1258Antiga');
  });

  it('respeita o teto de leads por tick', async () => {
    const leads = [leadRow({ id: 'a' }), leadRow({ id: 'b' }), leadRow({ id: 'c' })];
    const { service, repo, messenger, config } = build() as any;
    repo.findDue.mockResolvedValue(leads);
    config.maxSendsPerTick = 2;
    await service.tick(brt('2026-10-18T16:00:00'));
    expect(messenger.send).toHaveBeenCalledTimes(2);
  });

  it('1258 restringido: ação na conversa de lá só reagenda pro fim da restrição', async () => {
    const lead = leadRow({ state: 'CONTACTED', attempt: 1, conversationId: 'conv1258', phone: '5511975286081', snapshot: { firstName: 'Mayara' } });
    const { service, messenger, repo, config } = build({ lead }) as any;
    messenger.channelOf.mockResolvedValue('canal1258');
    const resumeAt = new Date('2026-10-21T12:00:00Z');
    config.legacyResumeAt = resumeAt;
    await service.tick(brt('2026-10-20T10:00:00'));
    expect(messenger.send).not.toHaveBeenCalled();
    expect(repo.update.mock.calls.at(-1)[1]).toEqual({ nextActionAt: resumeAt });
  });

  it('CONTACTED attempt 1 vencido manda a 2ª', async () => {
    const lead = leadRow({ state: 'CONTACTED', attempt: 1, conversationId: 'conv1', phone: '5511975286081', snapshot: { firstName: 'Mayara', produto: '57 Agents Advocacia' } });
    const { service, repo, hoppe, messenger } = build({ lead });
    await service.tick(brt('2026-10-18T14:00:00'));
    expect(messenger.send.mock.calls[0][0].text).toEqual([
      'Mayara, conseguiu começar a usar? se travou em alguma parte, me conta que eu te ajudo',
    ]);
    expect(hoppe.addTag).toHaveBeenCalledWith(TASK, '2º mensagem');
    expect(repo.update.mock.calls.at(-1)![1].attempt).toBe(2);
  });

  it('attempt 3 vencido vira INACTIVE sem desqualificar', async () => {
    const lead = leadRow({ state: 'CONTACTED', attempt: 3, conversationId: 'conv1', attemptDates: ['2026-10-16T13:00:00.000Z'] });
    const { service, repo, hoppe, messenger } = build({ lead });
    await service.tick(brt('2026-10-18T14:00:00'));
    expect(messenger.send).not.toHaveBeenCalled();
    expect(repo.update.mock.calls.at(-1)![1].state).toBe('INACTIVE');
    expect(hoppe.setField).toHaveBeenCalledWith(TASK, HOPPE_FIELD.ATIVIDADE, ATIVIDADE.INATIVO);
    expect(hoppe.setStatus).not.toHaveBeenCalled();
  });

  it('só busca estados acionáveis (nunca OPTED_OUT/PAUSED)', async () => {
    const { service, repo } = build();
    await service.tick(brt('2026-10-18T10:00:00'));
    const states: string[] = repo.findDue.mock.calls[0][0];
    expect(states).not.toContain('OPTED_OUT');
    expect(states).not.toContain('PAUSED');
  });

  it('desligado não faz nada', async () => {
    const { service, repo } = build();
    (service as any).config.enabled = false;
    await service.tick(brt('2026-10-18T10:00:00'));
    expect(repo.findDue).not.toHaveBeenCalled();
  });

  it('falha no Hoppe depois do envio não reverte o estado', async () => {
    const { service, repo, hoppe } = build();
    hoppe.addTag.mockRejectedValue(new Error('500'));
    await service.tick(brt('2026-10-18T10:00:00'));
    expect(repo.update.mock.calls.at(-1)![1].state).toBe('CONTACTED');
  });

  it('retomada única pra lead aguardando sócio', async () => {
    const lead = leadRow({ state: 'REPLIED', attempt: 1, conversationId: 'conv1', phone: '5511975286081', pendingReason: 'socios', pendingDetail: 'Carlos', snapshot: { firstName: 'Mayara' } });
    const { service, repo, messenger } = build({ lead });
    (messenger as any).followupGuard = jest.fn().mockResolvedValue(null);
    await service.tick(brt('2026-10-18T14:00:00'));
    expect(messenger.send.mock.calls[0][0].text).toBe(
      'Mayara, conseguiu combinar com Carlos a participação no diagnóstico?',
    );
    const data = repo.update.mock.calls.at(-1)![1];
    expect(data.resumeSentAt).toBeInstanceOf(Date);
    expect(data.silentFollowups).toBe(1);
    expect(data.nextActionAt).toBeInstanceOf(Date);
  });

  it('retomada de silêncio: 2ª mensagem genérica; depois da 2ª vira Inativo', async () => {
    const lead = leadRow({ state: 'REPLIED', attempt: 1, conversationId: 'conv1', phone: '5511975286081', silentFollowups: 1, snapshot: { firstName: 'Mayara' } });
    const { service, messenger } = build({ lead });
    (messenger as any).followupGuard = jest.fn().mockResolvedValue(null);
    await service.tick(brt('2026-10-18T14:00:00'));
    expect(messenger.send.mock.calls[0][0].text).toContain('Mayara, vou deixar quieto por aqui');
    const done = build({ lead: { ...lead, silentFollowups: 2 } });
    (done.messenger as any).followupGuard = jest.fn().mockResolvedValue(null);
    await done.service.tick(brt('2026-10-18T14:00:00'));
    expect(done.messenger.send).not.toHaveBeenCalled();
    expect(done.hoppe.setField).toHaveBeenCalledWith(TASK, HOPPE_FIELD.ATIVIDADE, ATIVIDADE.INATIVO);
  });

  it('retomada de quem parou com o suporte devolve pro onboarding e pergunta se deu certo', async () => {
    const lead = leadRow({ state: 'REPLIED', attempt: 1, conversationId: 'conv1', phone: '5511975286081', snapshot: { firstName: 'Mayara' } });
    const { service, messenger } = build({ lead });
    (messenger as any).followupGuard = jest.fn().mockResolvedValue(null);
    (messenger as any).returnFromSupport = jest.fn().mockResolvedValue('agent_onboarding_001');
    await service.tick(brt('2026-10-18T14:00:00'));
    expect((messenger as any).returnFromSupport).toHaveBeenCalledWith('conv1');
    expect(messenger.send.mock.calls[0][0].text).toBe('Mayara, deu certo por aí depois daquilo?');
  });

  it('retomada não sai com a bola no time (humano/aprovação pendente)', async () => {
    const lead = leadRow({ state: 'REPLIED', attempt: 1, conversationId: 'conv1', phone: '5511975286081', snapshot: { firstName: 'Mayara' } });
    const { service, messenger } = build({ lead });
    (messenger as any).followupGuard = jest.fn().mockResolvedValue('human');
    await service.tick(brt('2026-10-18T14:00:00'));
    expect(messenger.send).not.toHaveBeenCalled();
  });
});

describe('LeadOnboardingService.tick — correções da revisão', () => {
  it('I1: lead que mudou de estado no meio do lote não é reenviado (claim atômico)', async () => {
    const lead = leadRow({ state: 'CONTACTED', attempt: 1, conversationId: 'conv1', phone: '5511975286081', snapshot: { firstName: 'Mayara' } });
    const { service, repo, messenger } = build({ lead });
    (repo as any).claim = jest.fn().mockResolvedValue(false);
    await service.tick(brt('2026-10-18T14:00:00'));
    expect(messenger.send).not.toHaveBeenCalled();
  });

  it('I1: estado mudou durante o envio → não sobrescreve com CONTACTED', async () => {
    const lead = leadRow({ state: 'CONTACTED', attempt: 1, conversationId: 'conv1', phone: '5511975286081', snapshot: { firstName: 'Mayara' } });
    const { service, repo } = build({ lead });
    (repo as any).updateIfState = jest.fn().mockResolvedValue(false);
    await service.tick(brt('2026-10-18T14:00:00'));
    expect((repo as any).updateIfState).toHaveBeenCalledWith('lead1', ['PENDING', 'CONTACTED'], expect.objectContaining({ state: 'CONTACTED' }));
    const states = repo.update.mock.calls.map((c: any[]) => c[1].state).filter(Boolean);
    expect(states).not.toContain('CONTACTED');
  });

  it('I2: lead respondeu e o hook falhou → tentativa 2 não sai, vira REPLIED', async () => {
    const lead = leadRow({ state: 'CONTACTED', attempt: 1, conversationId: 'conv1', phone: '5511975286081', lastAttemptAt: brt('2026-10-18T09:00:00'), snapshot: { firstName: 'Mayara' } });
    const { service, repo, messenger } = build({ lead });
    messenger.conversationGuard = jest.fn().mockResolvedValue('replied');
    await service.tick(brt('2026-10-18T14:00:00'));
    expect(messenger.send).not.toHaveBeenCalled();
    expect(repo.update.mock.calls.at(-1)![1].state).toBe('REPLIED');
  });

  it('I2: IA desligada na conversa pela UI → PAUSED sem enviar', async () => {
    const lead = leadRow({ state: 'CONTACTED', attempt: 2, conversationId: 'conv1', phone: '5511975286081', snapshot: { firstName: 'Mayara' } });
    const { service, repo, messenger } = build({ lead });
    messenger.conversationGuard = jest.fn().mockResolvedValue('human');
    await service.tick(brt('2026-10-18T14:00:00'));
    expect(messenger.send).not.toHaveBeenCalled();
    expect(repo.update.mock.calls.at(-1)![1].state).toBe('PAUSED');
  });
});

describe('LeadOnboardingService — start/due date no Hoppe', () => {
  it('tentativa enviada: start = agora, due = próxima tentativa', async () => {
    const { service, hoppe } = build();
    (hoppe as any).setDates = jest.fn().mockResolvedValue(undefined);
    const now = brt('2026-10-18T10:00:00');
    await service.tick(now);
    expect((hoppe as any).setDates).toHaveBeenCalledWith(TASK, {
      start: now,
      due: brt('2026-10-18T14:00:00'),
    });
  });

  it('inativação: start = agora, due limpo', async () => {
    const lead = leadRow({ state: 'CONTACTED', attempt: 3, conversationId: 'conv1' });
    const { service, hoppe } = build({ lead });
    (hoppe as any).setDates = jest.fn().mockResolvedValue(undefined);
    const now = brt('2026-10-18T14:00:00');
    await service.tick(now);
    expect((hoppe as any).setDates).toHaveBeenCalledWith(TASK, { start: now, due: null });
  });

  it('fora da janela: só move o due, mantém o start', async () => {
    const { service, hoppe } = build();
    (hoppe as any).setDates = jest.fn().mockResolvedValue(undefined);
    await service.tick(brt('2026-10-18T22:00:00'));
    expect((hoppe as any).setDates).toHaveBeenCalledWith(TASK, {
      start: undefined,
      due: brt('2026-10-19T08:00:00'),
    });
  });

  it('reunião agendada: start = início, due = fim (1h)', async () => {
    const { service, hoppe, lead } = build({ lead: leadRow({ state: 'REPLIED' }) });
    (hoppe as any).setDates = jest.fn().mockResolvedValue(undefined);
    await service.recordScheduled(lead as any, {
      eventId: 'ev1',
      startIso: '2026-10-21T13:00:00.000Z',
      attendees: ['a@b.com'],
      meetLink: null,
    });
    expect((hoppe as any).setDates).toHaveBeenCalledWith(TASK, {
      start: new Date('2026-10-21T13:00:00.000Z'),
      due: new Date('2026-10-21T14:00:00.000Z'),
    });
  });

  it('falha ao gravar datas não quebra o fluxo', async () => {
    const { service, repo, hoppe } = build();
    (hoppe as any).setDates = jest.fn().mockRejectedValue(new Error('500'));
    await service.tick(brt('2026-10-18T10:00:00'));
    expect(repo.update.mock.calls.at(-1)![1].state).toBe('CONTACTED');
  });
});
