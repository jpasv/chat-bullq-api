import { UnauthorizedException } from '@nestjs/common';
import { HoppeWebhookController, extractTaskId } from './hoppe-webhook.controller';
import { LeadOnboardingRepository } from './lead-onboarding.repository';

const TASK = 'c132c764-f2fd-4f8a-bc12-39af873100d8';

function buildRepo(existing: Record<string, any> | null = null) {
  const rows = new Map<string, any>();
  if (existing) rows.set(existing.hoppeTaskId, existing);
  const prisma = {
    onboardingLead: {
      findUnique: jest.fn(async ({ where }) => rows.get(where.hoppeTaskId) ?? null),
      create: jest.fn(async ({ data }) => {
        rows.set(data.hoppeTaskId, { ...data });
        return data;
      }),
    },
  };
  return { repo: new LeadOnboardingRepository(prisma as any), prisma, rows };
}

function build(existing: Record<string, any> | null = null, tags: string[] = ['abordar-ia']) {
  const { repo, prisma, rows } = buildRepo(existing);
  const config = { webhookSecret: 's3cr3t', orgId: 'org1' };
  const hoppe = { getTask: jest.fn().mockResolvedValue({ id: TASK, tags }) };
  const controller = new HoppeWebhookController(config as any, repo, hoppe as any);
  return { controller, prisma, rows, hoppe };
}

describe('extractTaskId', () => {
  it('acha o id nos formatos comuns', () => {
    expect(extractTaskId({ task: { id: TASK } })).toBe(TASK);
    expect(extractTaskId({ taskId: TASK })).toBe(TASK);
    expect(extractTaskId({ data: { task: { id: TASK } } })).toBe(TASK);
    expect(extractTaskId({ payload: { task_id: TASK } })).toBe(TASK);
    expect(extractTaskId({ foo: 1 })).toBeNull();
    expect(extractTaskId({ taskId: 'nao-e-uuid' })).toBeNull();
  });
});

describe('HoppeWebhookController', () => {
  it('segredo errado → 401', async () => {
    const { controller } = build();
    await expect(controller.handle('errado', { task: { id: TASK } })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('cria o lead PENDING com ação imediata', async () => {
    const { controller, rows } = build();
    await expect(controller.handle('s3cr3t', { task: { id: TASK } })).resolves.toEqual({
      status: 'created',
    });
    const lead = rows.get(TASK);
    expect(lead.state).toBe('PENDING');
    expect(lead.organizationId).toBe('org1');
    expect(lead.nextActionAt).toBeInstanceOf(Date);
  });

  it('webhook duplicado não cria outro lead', async () => {
    const { controller, prisma } = build();
    await controller.handle('s3cr3t', { task: { id: TASK } });
    await expect(controller.handle('s3cr3t', { task: { id: TASK } })).resolves.toEqual({
      status: 'exists',
    });
    expect(prisma.onboardingLead.create).toHaveBeenCalledTimes(1);
  });

  it('payload sem task → no_task, sem 500', async () => {
    const { controller, prisma } = build();
    await expect(controller.handle('s3cr3t', { foo: 1 })).resolves.toEqual({ status: 'no_task' });
    expect(prisma.onboardingLead.create).not.toHaveBeenCalled();
  });

  it('lead com opt-out continua OPTED_OUT quando a tag volta', async () => {
    const { controller, rows } = build({ hoppeTaskId: TASK, state: 'OPTED_OUT' });
    await expect(controller.handle('s3cr3t', { task: { id: TASK } })).resolves.toEqual({
      status: 'exists',
    });
    expect(rows.get(TASK).state).toBe('OPTED_OUT');
  });

  it('task sem a tag abordar-ia (outra tag adicionada) não vira lead', async () => {
    const { controller, prisma } = build(null, ['1º mensagem']);
    await expect(controller.handle('s3cr3t', { task: { id: TASK } })).resolves.toEqual({ status: 'not_tagged' });
    expect(prisma.onboardingLead.create).not.toHaveBeenCalled();
  });
});
