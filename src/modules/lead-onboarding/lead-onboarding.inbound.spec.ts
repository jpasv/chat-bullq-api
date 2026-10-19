import { LeadOnboardingService } from './lead-onboarding.service';
import { ATIVIDADE, HOPPE_FIELD, HOPPE_STATUS } from './lead-onboarding.constants';

const TASK = 'c132c764-f2fd-4f8a-bc12-39af873100d8';

function build(lead: Record<string, any> | null, opts: { recentSystem?: boolean } = {}) {
  const repo = {
    findByConversation: jest.fn().mockResolvedValue(lead),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const hoppe = {
    setStatus: jest.fn().mockResolvedValue(undefined),
    setField: jest.fn().mockResolvedValue(undefined),
    addComment: jest.fn().mockResolvedValue(undefined),
  };
  const messenger = {
    hasRecentSystemOutbound: jest.fn().mockResolvedValue(opts.recentSystem ?? false),
    pauseConversation: jest.fn().mockResolvedValue(undefined),
  };
  const service = new LeadOnboardingService(
    repo as any,
    hoppe as any,
    messenger as any,
    { enabled: true } as any,
    {} as any,
  );
  return { service, repo, hoppe, messenger };
}

const lead = (state: string) => ({ id: 'l1', hoppeTaskId: TASK, state, repliedAt: null });

describe('LeadOnboardingService.onInbound', () => {
  it('conversa sem lead não faz nada', async () => {
    const { service, repo } = build(null);
    await service.onInbound('conv1', { isEcho: false, isNew: true, text: 'oi' });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('resposta em CONTACTED → REPLIED e em qualificação', async () => {
    const { service, repo, hoppe } = build(lead('CONTACTED'));
    await service.onInbound('conv1', { isEcho: false, isNew: true, text: 'oi' });
    const data = repo.update.mock.calls[0][1];
    expect(data.state).toBe('REPLIED');
    expect(data.nextActionAt).toBeNull();
    expect(data.summaryDueAt).toBeInstanceOf(Date);
    expect(hoppe.setStatus).toHaveBeenCalledWith(TASK, HOPPE_STATUS.EM_QUALIFICACAO);
    expect(hoppe.addComment).toHaveBeenCalledWith(TASK, expect.stringContaining('Lead respondeu'));
  });

  it('resposta em INACTIVE reativa', async () => {
    const { service, repo, hoppe } = build(lead('INACTIVE'));
    await service.onInbound('conv1', { isEcho: false, isNew: true, text: 'oi' });
    expect(repo.update.mock.calls[0][1].state).toBe('REPLIED');
    expect(hoppe.setField).toHaveBeenCalledWith(TASK, HOPPE_FIELD.ATIVIDADE, ATIVIDADE.ATIVO);
    expect(hoppe.addComment).toHaveBeenCalledWith(TASK, expect.stringContaining('voltou a responder'));
  });

  it('nova mensagem em REPLIED cancela a retomada e empurra o resumo', async () => {
    const { service, repo, hoppe } = build(lead('REPLIED'));
    await service.onInbound('conv1', { isEcho: false, isNew: true, text: 'beleza' });
    const data = repo.update.mock.calls[0][1];
    expect(data.nextActionAt).toBeNull();
    expect(data.state).toBeUndefined();
    expect(hoppe.setStatus).not.toHaveBeenCalled();
  });

  it('eco nova que não é do sistema → Tiago assumiu, IA pausada', async () => {
    const { service, repo, messenger, hoppe } = build(lead('REPLIED'));
    await service.onInbound('conv1', { isEcho: true, isNew: true, text: 'fala, aqui é o Tiago' });
    expect(repo.update.mock.calls[0][1].state).toBe('PAUSED');
    expect(messenger.pauseConversation).toHaveBeenCalledWith('conv1');
    expect(hoppe.addComment).toHaveBeenCalledWith(TASK, expect.stringContaining('IA pausada'));
  });

  it('eco de mensagem da própria IA não pausa', async () => {
    const { service, repo, messenger } = build(lead('REPLIED'), { recentSystem: true });
    await service.onInbound('conv1', { isEcho: true, isNew: true, text: 'texto da IA' });
    expect(repo.update).not.toHaveBeenCalled();
    expect(messenger.pauseConversation).not.toHaveBeenCalled();
  });

  it('eco repetida (isNew=false) não pausa', async () => {
    const { service, messenger } = build(lead('CONTACTED'));
    await service.onInbound('conv1', { isEcho: true, isNew: false, text: 'x' });
    expect(messenger.pauseConversation).not.toHaveBeenCalled();
  });
});

describe('onInbound — datas no Hoppe', () => {
  it('resposta: start = agora, due limpo', async () => {
    const { service, hoppe } = build({ id: 'l1', hoppeTaskId: TASK, state: 'CONTACTED' });
    (hoppe as any).setDates = jest.fn().mockResolvedValue(undefined);
    await service.onInbound('conv1', { isEcho: false, isNew: true, text: 'oi' });
    expect((hoppe as any).setDates).toHaveBeenCalledWith(TASK, { start: expect.any(Date), due: null });
  });

  it('reunião agendada: mensagem do lead não mexe nas datas da reunião', async () => {
    const { service, hoppe } = build({ id: 'l1', hoppeTaskId: TASK, state: 'SCHEDULED' });
    (hoppe as any).setDates = jest.fn().mockResolvedValue(undefined);
    await service.onInbound('conv1', { isEcho: false, isNew: true, text: 'ok, até lá' });
    expect((hoppe as any).setDates).not.toHaveBeenCalled();
  });
});
