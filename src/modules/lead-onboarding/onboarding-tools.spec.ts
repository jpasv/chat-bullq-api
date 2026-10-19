import { AgendarDiagnosticoTool } from '../ai-agents/tools/builtin/agendar-diagnostico.tool';
import { ConsultarHorariosDiagnosticoTool } from '../ai-agents/tools/builtin/consultar-horarios-diagnostico.tool';
import { RegistrarQualificacaoTool } from '../ai-agents/tools/builtin/registrar-qualificacao.tool';
import { RegistrarOptOutTool } from '../ai-agents/tools/builtin/registrar-opt-out.tool';
import { LeadOnboardingService } from './lead-onboarding.service';
import { SlotTakenError } from './diagnostic-calendar.service';
import { HOPPE_STATUS } from './lead-onboarding.constants';

const ctx = { conversationId: 'conv1', organizationId: 'org1', contactId: 'ct1', channelId: 'ch1', agentId: 'ag1', runId: 'r1' };
const TASK = 'c132c764-f2fd-4f8a-bc12-39af873100d8';
const lead = (snapshot: Record<string, any> = {}) => ({
  id: 'l1',
  hoppeTaskId: TASK,
  state: 'REPLIED',
  phone: '5521990451258',
  snapshot: { firstName: 'Mayara', name: 'Mayara Silva', phone: '5521990451258', faturamento: 'Acima de R$ 1 milhão', ...snapshot },
});

function realService(found: any) {
  const repo = { findByConversation: jest.fn().mockResolvedValue(found), update: jest.fn() };
  const hoppe = { setStatus: jest.fn(), setField: jest.fn(), addComment: jest.fn(), addTag: jest.fn() };
  const svc = new LeadOnboardingService(repo as any, hoppe as any, {} as any, {} as any, {} as any);
  return { svc, repo, hoppe };
}

describe('tools do onboarding', () => {
  it('sem lead na conversa → conversa_sem_lead', async () => {
    const { svc } = realService(null);
    const tool = new RegistrarOptOutTool(svc);
    expect((await tool.execute({ motivo: 'x' }, ctx)).output).toEqual({ ok: false, error: 'conversa_sem_lead' });
  });

  it('consultarHorarios devolve os slots da agenda', async () => {
    const { svc } = realService(lead());
    const calendar = { freeSlots: jest.fn().mockResolvedValue([{ startIso: 'a', label: 'seg, 19/10 às 9h' }]) };
    const tool = new ConsultarHorariosDiagnosticoTool(svc, calendar as any);
    expect((await tool.execute({}, ctx)).output).toEqual({ ok: true, slots: [{ startIso: 'a', label: 'seg, 19/10 às 9h' }] });
  });

  it('agendar com horário ocupado → horario_ocupado, sem marcar reunião', async () => {
    const { svc, hoppe } = realService(lead());
    const calendar = { create: jest.fn().mockRejectedValue(new SlotTakenError('x')) };
    const config = { closerEmail: 'produtos@asv.digital' };
    const tool = new AgendarDiagnosticoTool(svc, calendar as any, config as any);
    const r = await tool.execute({ inicioIso: '2099-10-19T13:00:00.000Z', emails: ['m@x.com'], participantes: ['Mayara'] }, ctx);
    expect(r.output).toEqual({ ok: false, error: 'horario_ocupado' });
    expect(hoppe.setStatus).not.toHaveBeenCalled();
  });

  it('agendar cria evento sem dados comerciais e marca reunião agendada', async () => {
    const { svc, hoppe } = realService(lead());
    const calendar = { create: jest.fn().mockResolvedValue({ eventId: 'ev1', meetLink: 'https://meet' }) };
    const config = { closerEmail: 'produtos@asv.digital' };
    const tool = new AgendarDiagnosticoTool(svc, calendar as any, config as any);
    const r = await tool.execute({ inicioIso: '2099-10-19T13:00:00.000Z', emails: ['m@x.com'], participantes: ['Mayara', 'Carlos'] }, ctx);
    expect(r.output).toEqual({ ok: true, meetLink: 'https://meet', inicioIso: '2099-10-19T13:00:00.000Z' });
    const arg = calendar.create.mock.calls[0][0];
    expect(arg.attendees).toEqual(['m@x.com', 'produtos@asv.digital']);
    expect(arg.title).toBe('Diagnóstico de IA – Mayara Silva');
    expect(arg.description).not.toMatch(/fatura|milhão|Maestria|presencial/i);
    expect(hoppe.setStatus).toHaveBeenCalledWith(TASK, HOPPE_STATUS.REUNIAO_AGENDADA);
  });

  it('agendar com início no passado é recusado', async () => {
    const { svc } = realService(lead());
    const calendar = { create: jest.fn() };
    const tool = new AgendarDiagnosticoTool(svc, calendar as any, { closerEmail: 'p@x' } as any);
    const r = await tool.execute({ inicioIso: '2020-01-01T13:00:00.000Z', emails: ['m@x.com'], participantes: ['M'] }, ctx);
    expect((r.output as any).ok).toBe(false);
    expect(calendar.create).not.toHaveBeenCalled();
  });

  it('desqualificado muda o status', async () => {
    const { svc, hoppe } = realService(lead());
    const tool = new RegistrarQualificacaoTool(svc);
    await tool.execute({ resultado: 'desqualificado', motivo: 'prioridade baixa' }, ctx);
    expect(hoppe.setStatus).toHaveBeenCalledWith(TASK, HOPPE_STATUS.DESQUALIFICADO);
  });

  it('qualificado no Rio acima de 500k/ano sugere presencial no comentário', async () => {
    const { svc, hoppe } = realService(lead());
    const tool = new RegistrarQualificacaoTool(svc);
    await tool.execute({ resultado: 'qualificado', motivo: 'decide sozinho, prioridade alta', decisor: true }, ctx);
    expect(hoppe.setStatus).not.toHaveBeenCalled();
    expect(hoppe.addComment.mock.calls[0][1]).toContain('presencial');
  });

  it('resultado inválido é recusado', async () => {
    const { svc } = realService(lead());
    const tool = new RegistrarQualificacaoTool(svc);
    expect(((await tool.execute({ resultado: 'talvez', motivo: 'x' }, ctx)).output as any).ok).toBe(false);
  });

  it('I4: lead já agendado não cria segundo evento', async () => {
    const { svc } = realService({ ...lead(), state: 'SCHEDULED', meetingEventId: 'ev0' });
    const calendar = { create: jest.fn() };
    const tool = new AgendarDiagnosticoTool(svc, calendar as any, { closerEmail: 'p@x' } as any);
    const r = await tool.execute({ inicioIso: '2030-01-01T13:00:00.000Z', emails: ['m@x.com'], participantes: ['M'] }, ctx);
    expect(r.output).toMatchObject({ ok: false, error: 'ja_agendado' });
    expect(calendar.create).not.toHaveBeenCalled();
  });
});
