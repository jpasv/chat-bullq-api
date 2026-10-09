import { PendingActionExecutorProcessor } from './pending-action-executor.processor';
import { HttpToolExecutorService } from '../tools/http-tool-executor.service';
import { SqlToolExecutorService } from '../tools/sql-tool-executor.service';
import { PendingActionStorage } from './pending-action.storage';
import { PendingActionService } from './pending-action.service';

const ctx = { organizationId: 'org', conversationId: 'conv', contactId: 'contact', channelId: 'channel', agentId: 'agent', runId: 'run' };
const skill: any = { id: 'skill', name: 'same-name', organizationId: 'org', source: 'HTTP', toolId: 'tool', httpMethod: 'POST', httpPath: '/action', sqlQuery: 'SELECT 1' };
const tool: any = { id: 'tool', organizationId: 'org', source: 'CUSTOM_HTTP', httpBaseUrl: 'https://unused.invalid', sqlConnectionRef: 'NOT_USED' };

describe('LOTE A: aprovação por organização, skill ID e falhas lógicas', () => {
  function setup(args: any = { __skillId: 'skill', email: 'a@b.com' }) {
    const action: any = { id: 'pending', agentRunId: 'run', conversationId: 'conv', agentId: 'agent', toolName: 'same-name', args, status: 'APPROVED', approvedBy: 'human' };
    const prisma: any = {
      aiAgentRun: { findFirst: jest.fn(async () => ({ organizationId: 'org' })) },
      conversation: { findFirst: jest.fn(async () => ({ id: 'conv', contactId: 'contact', channelId: 'channel' })) },
      aiSkill: { findFirst: jest.fn(async () => skill) },
      aiTool: { findFirst: jest.fn(async () => tool) },
      aiPendingAction: {
        updateMany: jest.fn(async ({ where, data }) => {
          if (where.status !== action.status) return { count: 0 };
          Object.assign(action, data);
          return { count: 1 };
        }),
      },
      aiToolCall: { create: jest.fn() },
    };
    const http: any = { execute: jest.fn(async () => ({ output: { ok: true } })) };
    const sql: any = { execute: jest.fn(async () => ({ output: { ok: true } })) };
    const actions: any = { assertApprover: jest.fn(), assertContext: jest.fn(), execute: jest.fn(async () => ({ output: { ok: true } })) };
    const processor = new PendingActionExecutorProcessor(prisma, http, sql, actions, { get: jest.fn(async () => ({ ...action })), acquire: (id: string) => new PendingActionStorage(prisma).acquire(id) } as any);
    const process = () => processor.process({ name: 'execute_pending', data: { pendingActionId: 'pending' } } as any);
    return { action, prisma, http, sql, actions, process };
  }
  it('prefere ID salvo, sempre filtra organização e retira metadata do input', async () => {
    const s = setup(); await s.process();
    expect(s.prisma.aiSkill.findFirst.mock.calls[0][0].where).toEqual({ id: 'skill', organizationId: 'org', isActive: true, deletedAt: null });
    expect(s.http.execute).toHaveBeenCalledWith(skill, tool, { email: 'a@b.com' }, expect.objectContaining(ctx), { bypassPendingGate: true, idempotencyKey: 'pending-action-pending' });
    expect(s.prisma.aiPendingAction.updateMany.mock.calls[1][0].data.status).toBe('EXECUTED');
  });
  it('legado sem ID busca nome apenas dentro da organização', async () => {
    const s = setup({}); await s.process();
    expect(s.prisma.aiSkill.findFirst.mock.calls[0][0].where).toMatchObject({ name: 'same-name', organizationId: 'org' });
  });
  it('não faz fallback por nome se ID ficou inativo/foi removido', async () => {
    const s = setup(); s.prisma.aiSkill.findFirst.mockResolvedValue(null); await s.process();
    expect(s.http.execute).not.toHaveBeenCalled();
    expect(s.prisma.aiSkill.findFirst).toHaveBeenCalledTimes(1);
    expect(s.prisma.aiPendingAction.updateMany.mock.calls[1][0].data.status).toBe('APPROVED');
  });
  it.each([{ ok: false, error: 'denied' }, { error: 'logical' }, { success: false }, { ok: true, body: { ok: false } }])('falha lógica %j nunca vira EXECUTED', async output => {
    const s = setup(); s.http.execute.mockResolvedValue({ output }); await s.process();
    expect(s.prisma.aiPendingAction.updateMany.mock.calls[1][0].data).toMatchObject({ status: 'APPROVED', executionResult: { ok: false, error: expect.any(String) } });
  });
  it('despacha SQL depois da aprovação', async () => {
    const s = setup(); s.prisma.aiSkill.findFirst.mockResolvedValue({ ...skill, source: 'SQL' });
    await s.process();
    expect(s.sql.execute).toHaveBeenCalledWith(expect.anything(), tool, expect.anything(), expect.anything(), { bypassPendingGate: true, idempotencyKey: 'pending-action-pending' });
    expect(s.http.execute).not.toHaveBeenCalled();
  });
  it('transferência aprovada usa lógica compartilhada e autor aprovador', async () => {
    const s = setup({ reason: 'Humano' }); s.action.toolName = 'transferToHuman'; await s.process();
    expect(s.actions.execute).toHaveBeenCalledWith('transferToHuman', { reason: 'Humano' }, expect.objectContaining(ctx), 'human');
  });
  it('recusa aprovador sem acesso e registra falha na tool call', async () => {
    const s = setup(); s.actions.assertApprover.mockRejectedValue(new Error('No access'));
    await s.process();
    expect(s.http.execute).not.toHaveBeenCalled();
    expect(s.prisma.aiToolCall.create.mock.calls[0][0].data).toMatchObject({ runId: 'run', toolName: 'same-name', error: 'No access' });
  });
  it.each(['HTTP', 'SQL', 'transferToHuman'])('claims %s exclusively before concurrent jobs cause effects', async source => {
    const s = setup();
    s.prisma.aiSkill.findFirst.mockResolvedValue({ ...skill, source });
    if (source === 'transferToHuman') s.action.toolName = source;
    const executor = source === 'SQL' ? s.sql.execute : source === 'HTTP' ? s.http.execute : s.actions.execute;
    let finish!: () => void;
    executor.mockImplementation(() => new Promise(resolve => {
      finish = () => resolve({ output: { ok: true } });
    }));
    const first = s.process();
    const second = s.process();
    await expect(second).resolves.toEqual({ skipped: true, reason: 'already_claimed' });
    // The first job is still waiting on the integration.
    await new Promise(resolve => setImmediate(resolve));
    expect(s.action.status).toBe('EXECUTING');
    expect(executor).toHaveBeenCalledTimes(1);
    expect(s.prisma.aiPendingAction.updateMany).toHaveBeenCalledWith({
      where: { id: 'pending', status: 'APPROVED' }, data: { status: 'EXECUTING' },
    });
    finish();
    await first;
    await s.process();
    expect(executor).toHaveBeenCalledTimes(1);
    expect(s.prisma.aiToolCall.create).toHaveBeenCalledTimes(1);
  });
  it('keeps the approval idempotency key across explicit retries', async () => {
    const s = setup();
    s.http.execute.mockRejectedValueOnce(new Error('timeout'));
    await s.process();
    await s.process();
    expect(s.http.execute).toHaveBeenCalledTimes(2);
    for (const call of s.http.execute.mock.calls) {
      expect(call[4]).toEqual({ bypassPendingGate: true, idempotencyKey: 'pending-action-pending' });
    }
  });
  it('does not repeat an external effect if persisting its result fails', async () => {
    const s = setup();
    const update = s.prisma.aiPendingAction.updateMany.getMockImplementation()!;
    s.prisma.aiPendingAction.updateMany.mockImplementation(async (args: any) => {
      if (args.where.status === 'EXECUTING') throw new Error('storage unavailable');
      return update(args);
    });
    await expect(s.process()).rejects.toThrow('storage unavailable');
    await expect(s.process()).resolves.toEqual({ skipped: true, reason: 'status_EXECUTING' });
    expect(s.http.execute).toHaveBeenCalledTimes(1);
  });
  it('ação já executada não repete efeitos', async () => {
    const s = setup(); s.action.status = 'EXECUTED'; await s.process();
    expect(s.http.execute).not.toHaveBeenCalled();
    expect(s.prisma.aiPendingAction.updateMany).not.toHaveBeenCalled();
  });
});

describe('LOTE A: política uniforme HTTP e SQL', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => { originalFetch = global.fetch; global.fetch = jest.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) })) as any; });
  afterEach(() => { global.fetch = originalFetch; });
  function setup(requiresApproval: boolean) {
    const pending: any = { create: jest.fn(async () => ({ id: 'pending' })) };
    const prisma: any = { aiAgentSkill: { findUnique: jest.fn(async () => ({ requiresApproval })) } };
    const config: any = { get: jest.fn() };
    const http = new HttpToolExecutorService(config, pending, prisma);
    const sql = new SqlToolExecutorService(config, http);
    return { pending, prisma, config, http, sql };
  }
  it.each(['HTTP', 'SQL'])('%s exige aprovação do vínculo e grava ID original', async source => {
    const s = setup(true);
    const executor = source === 'SQL' ? s.sql : s.http;
    await executor.execute({ ...skill, source }, { ...tool, source: source === 'SQL' ? 'CUSTOM_SQL' : 'CUSTOM_HTTP' }, { __skillId: 'spoofed' }, ctx);
    expect(s.pending.create.mock.calls[0][0].args.__skillId).toBe('skill');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(s.config.get).not.toHaveBeenCalled();
  });
  it('sends the approval key to HTTP and overrides configured header variants', async () => {
    const s = setup(false);
    await s.http.execute(skill, { ...tool, httpHeaders: { 'idempotency-key': 'configured' } }, {}, ctx,
      { bypassPendingGate: true, idempotencyKey: 'approval-1' });
    const headers = (global.fetch as jest.Mock).mock.calls[0][1].headers;
    expect(headers['Idempotency-Key']).toBe('approval-1');
    expect(Object.keys(headers).filter(key => key.toLowerCase() === 'idempotency-key')).toHaveLength(1);
  });
  it('HTTP automático executa; retry aprovado ignora gate, mas verifica vínculo', async () => {
    const s = setup(false);
    await s.http.execute(skill, tool, {}, ctx);
    s.prisma.aiAgentSkill.findUnique.mockResolvedValue({ requiresApproval: true });
    await s.http.execute(skill, tool, {}, ctx, { bypassPendingGate: true });
    expect(s.pending.create).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(2);
    s.prisma.aiAgentSkill.findUnique.mockResolvedValue(null);
    await expect(s.http.execute(skill, tool, {}, ctx, { bypassPendingGate: true })).rejects.toThrow('assigned');
  });
  it('SQL automático passa pelo mesmo gate sem criar pending', async () => {
    const s = setup(false);
    const result = await s.sql.execute({ ...skill, source: 'SQL' }, { ...tool, source: 'CUSTOM_SQL' }, {}, ctx);
    expect(s.prisma.aiAgentSkill.findUnique).toHaveBeenCalled();
    expect(s.pending.create).not.toHaveBeenCalled();
    // No DSN: this unit test intentionally never opens a SQL connection.
    expect(result.output).toMatchObject({ ok: false });
  });
  it.each([{ ok: false }, { success: false }, { error: 'denied' }])('HTTP 200 com %j falha mesmo quando responseMap esconde erro', async body => {
    const s = setup(false);
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify(body) });
    expect((await s.http.execute({ ...skill, responseMap: { result: '$.value' } }, tool, {}, ctx)).output).toMatchObject({ ok: false });
  });
  it('aprovação de falha permite enfileirar retry sem perder args', async () => {
    const action: any = { id: 'pending', status: 'APPROVED', expiresAt: '2000-01-01', executionResult: { ok: false }, preview: {}, args: { __skillId: 'skill' } };
    const storage: any = { get: jest.fn(async () => action), save: jest.fn() };
    const queue: any = { add: jest.fn() };
    await new PendingActionService(storage, queue).approve('pending', 'user');
    expect(queue.add).toHaveBeenCalledWith('execute_pending', { pendingActionId: 'pending' }, expect.anything());
    expect(action.args.__skillId).toBe('skill');
  });
});
