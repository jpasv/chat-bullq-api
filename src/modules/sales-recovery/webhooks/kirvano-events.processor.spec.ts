import { KirvanoEventsProcessor } from './kirvano-events.processor';

// Bravy OS 24/11 (LIDER CTO): DUPLICATE e IGNORED saíam sem organization_id (só o markProcessed gravava a org), e as
// consultas por org (recuperação do 1581, SLA, reembolso) não viam essas vendas. Toda saída grava a org do processador.

const ORG = 'org-recovery';
const CANAL = 'canal-1581';
const PRODUTO = 'prod-rastreado';

function payload(event: string, over: Record<string, unknown> = {}) {
  return { event, sale_id: 'VENDA1', products: [{ id: PRODUTO }], customer: { email: 'a@b.com', phone_number: '5511988887777' }, ...over };
}

function montar(o: { evento?: string; jaProcessado?: boolean; rastreado?: boolean; resultado?: unknown; erro?: Error; org?: string | null } = {}) {
  const record = { id: 'ke1', payload: payload(o.evento ?? 'SALE_APPROVED') };
  const prisma = { kirvanoEvent: { findUnique: jest.fn().mockResolvedValue(record) } };
  const events = {
    alreadyProcessed: jest.fn().mockResolvedValue(o.jaProcessado ?? false),
    markDuplicate: jest.fn().mockResolvedValue(undefined),
    markIgnored: jest.fn().mockResolvedValue(undefined),
    markFailed: jest.fn().mockResolvedValue(undefined),
    markProcessed: jest.fn().mockResolvedValue(undefined),
  };
  const acao = o.erro ? jest.fn().mockRejectedValue(o.erro) : jest.fn().mockResolvedValue(o.resultado ?? { status: 'won', cardId: 'c1' });
  const recovery = { createOpportunity: acao, closeWon: acao, closeRefunded: acao };
  const config = {
    orgId: o.org === undefined ? ORG : o.org,
    outreachChannelId: CANAL,
    isProductTracked: jest.fn().mockReturnValue(o.rastreado ?? true),
  };
  const proc = new KirvanoEventsProcessor(prisma as never, events as never, recovery as never, config as never);
  return { proc, events, job: { data: { kirvanoEventId: 'ke1' } } as never };
}

describe('KirvanoEventsProcessor: organization_id em toda saída', () => {
  it('DUPLICATE grava a org', async () => {
    const { proc, events, job } = montar({ jaProcessado: true });
    await proc.process(job);
    expect(events.markDuplicate).toHaveBeenCalledWith('ke1', ORG);
  });

  it('IGNORED por produto não rastreado grava a org', async () => {
    const { proc, events, job } = montar({ rastreado: false });
    await proc.process(job);
    expect(events.markIgnored).toHaveBeenCalledWith('ke1', expect.stringMatching(/produto não rastreado/), ORG);
  });

  it('IGNORED por evento sem ação e por "sem card" grava a org', async () => {
    const sem = montar({ evento: 'SUBSCRIPTION_RENEWED' });
    await sem.proc.process(sem.job);
    expect(sem.events.markIgnored).toHaveBeenCalledWith('ke1', expect.stringMatching(/evento sem ação/), ORG);
    const semCard = montar({ resultado: { status: 'no_card' } });
    await semCard.proc.process(semCard.job);
    expect(semCard.events.markIgnored).toHaveBeenCalledWith('ke1', expect.stringMatching(/sem card/), ORG);
  });

  it('PROCESSED continua com a org; FAILED da ação grava a org e relança para o BullMQ', async () => {
    const ok = montar();
    await ok.proc.process(ok.job);
    expect(ok.events.markProcessed).toHaveBeenCalledWith('ke1', ORG);
    const falha = montar({ erro: new Error('banco fora') });
    await expect(falha.proc.process(falha.job)).rejects.toThrow('banco fora');
    expect(falha.events.markFailed).toHaveBeenCalledWith('ke1', 'banco fora', ORG);
  });

  it('sem RECOVERY_ORG_ID: DUPLICATE sem org (não inventa) e a falha de configuração como antes', async () => {
    const dup = montar({ jaProcessado: true, org: null });
    await dup.proc.process(dup.job);
    expect(dup.events.markDuplicate).toHaveBeenCalledWith('ke1', undefined);
    const cfg = montar({ org: null });
    await cfg.proc.process(cfg.job);
    expect(cfg.events.markFailed).toHaveBeenCalledWith('ke1', expect.stringMatching(/não configurados/), undefined);
    // RECOVERY_ORG_ID vazio conta como sem config (Revisor 23h05, Minor 2)
    const vazio = montar({ jaProcessado: true, org: '' });
    await vazio.proc.process(vazio.job);
    expect(vazio.events.markDuplicate).toHaveBeenCalledWith('ke1', undefined);
  });
});
