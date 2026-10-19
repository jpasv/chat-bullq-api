import { OnboardingHumanAlertService, renderHumanAlert, HumanAlertRow } from './onboarding-human-alert.service';
import { jwtExpiry } from './hoppe-chat.client';

const row = (over: Partial<HumanAlertRow> = {}): HumanAlertRow => ({
  leadId: 'l1',
  hoppeTaskId: 't1',
  leadName: 'Sérgio Alves',
  agentId: 'agent_livia_001',
  toolName: 'transferToHuman',
  reason: 'Simples Nacional não implantou',
  createdAt: new Date('2026-10-19T12:42:43.000Z'),
  ...over,
});

function build(rows: HumanAlertRow[], opts: { configured?: boolean; postFails?: boolean } = {}) {
  const prisma = {
    $queryRaw: jest.fn().mockResolvedValue(rows),
    onboardingLead: { update: jest.fn().mockResolvedValue({}) },
  };
  const chat = {
    configured: opts.configured ?? true,
    postToChannel: opts.postFails
      ? jest.fn().mockRejectedValue(new Error('401'))
      : jest.fn().mockResolvedValue(undefined),
  };
  const hoppe = {
    addComment: jest.fn().mockResolvedValue(undefined),
    addTag: jest.fn().mockResolvedValue(undefined),
    setDates: jest.fn().mockResolvedValue(undefined),
  };
  const config = { enabled: true, alertChannelId: 'ch1' };
  const svc = new OnboardingHumanAlertService(prisma as any, chat as any, hoppe as any, config as any);
  return { svc, prisma, chat, hoppe };
}

describe('OnboardingHumanAlertService', () => {
  it('posta no canal, marca o lead e comenta na task', async () => {
    const r = row();
    const { svc, prisma, chat, hoppe } = build([r]);
    expect(await svc.run()).toBe(1);
    expect(chat.postToChannel).toHaveBeenCalledWith('ch1', expect.stringContaining('Precisa de humano: Sérgio Alves'));
    expect(prisma.onboardingLead.update).toHaveBeenCalledWith({ where: { id: 'l1' }, data: { humanAlertAt: r.createdAt } });
    expect(hoppe.addComment).toHaveBeenCalledWith('t1', expect.stringContaining('Simples Nacional'));
    expect(hoppe.addTag).toHaveBeenCalledWith('t1', 'aguardando-humano');
    expect(hoppe.setDates).toHaveBeenCalledWith('t1', { start: r.createdAt, due: r.createdAt });
  });

  it('falha no post não marca o lead (tenta de novo no próximo tick)', async () => {
    const { svc, prisma } = build([row()], { postFails: true });
    expect(await svc.run()).toBe(0);
    expect(prisma.onboardingLead.update).not.toHaveBeenCalled();
  });

  it('sem login configurado não consulta nada', async () => {
    const { svc, prisma } = build([row()], { configured: false });
    expect(await svc.run()).toBe(0);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('renderiza agente e motivo, escapando HTML', () => {
    const html = renderHumanAlert(row({ agentId: 'agent_onboarding_001', leadName: 'A <b>', reason: 'quer reembolso' }));
    expect(html).toContain('A &lt;b&gt;');
    expect(html).toContain('o agente de onboarding pediu transferência para humano. Motivo: quer reembolso');
  });
});

describe('jwtExpiry', () => {
  it('lê o exp do JWT', () => {
    const payload = Buffer.from(JSON.stringify({ exp: 1792513381 })).toString('base64url');
    expect(jwtExpiry(`x.${payload}.y`)).toBe(1792513381000);
  });
  it('token ilegível assume 1h', () => {
    expect(jwtExpiry('lixo', 1000)).toBe(1000 + 3_600_000);
  });
});
