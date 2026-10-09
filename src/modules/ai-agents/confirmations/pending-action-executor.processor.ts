import { SqlToolExecutorService } from '../tools/sql-tool-executor.service';
import { StudioActionsService } from '../tools/builtin/studio-actions.service';
import { PendingAction } from './confirmation.types';
import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Prisma } from '@prisma/client';
import type { Job } from 'bullmq';

import { PrismaService } from '../../../database/prisma.service';
import { HttpToolExecutorService } from '../tools/http-tool-executor.service';
import type { ToolContext } from '../tools/tool.types';
import { PendingActionStorage } from './pending-action.storage';
import {
  PENDING_ACTION_EXECUTOR_QUEUE,
  PENDING_EXPIRE_JOB,
} from './queue-names';

export {
  PENDING_ACTION_EXECUTOR_QUEUE,
  PENDING_EXECUTE_JOB,
  PENDING_EXPIRE_JOB,
} from './queue-names';

type ExecutorJobData =
  | { pendingActionId: string }
  | Record<string, never>;

/**
 * Fase 2.5: executor pós-aprovação.
 *
 * Quando o operador aprova um `AiPendingAction`, o `PendingActionService`
 * enfileira aqui. Esse worker:
 *   - resolve a tool original (built-in `transferToHuman` ou skill HTTP/SQL)
 *   - executa de fato (HTTP com `bypassPendingGate: true` pra evitar loop)
 *   - grava `executionResult` e marca status `EXECUTED`
 *
 * Falhas resultam em status APPROVED + executionResult com error → operador
 * pode enfileirar nova tentativa com a mesma chave de idempotência.
 * Se o worker morrer ou não conseguir persistir o resultado, EXECUTING é
 * preservado: reconciliar o efeito externo antes de liberar nova tentativa.
 */
@Processor(PENDING_ACTION_EXECUTOR_QUEUE, { concurrency: 4 })
export class PendingActionExecutorProcessor extends WorkerHost {
  private readonly logger = new Logger(PendingActionExecutorProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly httpExecutor: HttpToolExecutorService,
    private readonly sqlExecutor: SqlToolExecutorService,
    private readonly actions: StudioActionsService,
    private readonly storage: PendingActionStorage,
  ) {
    super();
  }

  async process(job: Job<ExecutorJobData>): Promise<unknown> {
    if (job.name === PENDING_EXPIRE_JOB) {
      return this.expireOverdueActions();
    }
    const { pendingActionId } = job.data as { pendingActionId: string };
    const action = await this.storage.get(pendingActionId);

    if (!action) {
      this.logger.warn(`Pending action ${pendingActionId} not found`);
      return { skipped: true, reason: 'not_found' };
    }
    if (action.status !== 'APPROVED') {
      this.logger.warn(
        `Pending action ${pendingActionId} status=${action.status} (skipping execution)`,
      );
      return { skipped: true, reason: `status_${action.status}` };
    }

    if (!(await this.storage.acquire(pendingActionId))) {
      return { skipped: true, reason: 'already_claimed' };
    }

    const startedAt = Date.now();
    let result: unknown;
    let success = true;

    try {
      const ctx = await this.context(action);
      if (!action.approvedBy) throw new Error('Approver missing');
      await this.actions.assertApprover(ctx, action.approvedBy);
      if (action.toolName === 'transferToHuman') {
        result = (await this.actions.execute(action.toolName, action.args, ctx, action.approvedBy)).output;
      } else {
        result = await this.executeSkill(action, ctx);
      }
      const output = result as Record<string, unknown> | null;
      const body = output?.body as Record<string, unknown> | undefined;
      if (output?.ok === false || output?.success === false || output?.error || body?.ok === false || body?.success === false || body?.error) {
        throw new Error(String(output?.error || body?.error || 'Skill returned a logical failure'));
      }
    } catch (err: any) {
      success = false;
      result = { ok: false, error: err?.message ?? String(err) };
      this.logger.error(
        `Pending action ${pendingActionId} (${action.toolName}) failed: ${err?.message ?? err}`,
      );
    }

    const completed = await this.prisma.aiPendingAction.updateMany({
      where: { id: pendingActionId, status: 'EXECUTING' },
      data: {
        status: success ? 'EXECUTED' : 'APPROVED', // re-tentável se falhou
        executionResult: (result as Prisma.InputJsonValue) ?? Prisma.JsonNull,
      },
    });

    if (completed.count !== 1) throw new Error('Pending action execution ownership lost');

    await this.prisma.aiToolCall.create({
      data: {
        runId: action.agentRunId, toolName: action.toolName,
        input: { ...action.args, pendingActionId },
        output: (result as Prisma.InputJsonValue) ?? Prisma.JsonNull,
        error: success ? null : String((result as any)?.error ?? 'Execution failed'),
        durationMs: Date.now() - startedAt,
      },
    });

    this.logger.log({
      msg: 'pending_action_executed',
      pendingActionId,
      toolName: action.toolName,
      success,
    });

    return result;
  }

  /**
   * Cron-style cleanup: marca como EXPIRED qualquer PendingAction que
   * passou do `expiresAt` sem ser aprovado/rejeitado. Disparado por
   * repeatable job (a cada 5min) registrado em `confirmations.module`.
   */
  private async expireOverdueActions(): Promise<{ expired: number }> {
    const result = await this.prisma.aiPendingAction.updateMany({
      where: {
        status: 'PENDING',
        expiresAt: { lt: new Date() },
      },
      data: { status: 'EXPIRED' },
    });
    if (result.count > 0) {
      this.logger.log({
        msg: 'pending_actions_expired',
        count: result.count,
      });
    }
    return { expired: result.count };
  }

  private async context(action: PendingAction): Promise<ToolContext> {
    const run = await this.prisma.aiAgentRun.findFirst({
      where: { id: action.agentRunId, conversationId: action.conversationId, agentId: action.agentId },
    });
    if (!run) throw new Error('Run not found');
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: action.conversationId, organizationId: run.organizationId, deletedAt: null },
    });
    if (!conversation) throw new Error('Conversation outside organization');
    return {
      idempotencyKey: `pending-action-${action.id}`,
      organizationId: run.organizationId, conversationId: conversation.id,
      contactId: conversation.contactId, channelId: conversation.channelId,
      agentId: action.agentId, runId: action.agentRunId,
      triggerMessageId: run.triggerMessageId ?? '',
    };
  }

  private async executeSkill(action: PendingAction, ctx: ToolContext): Promise<unknown> {
    const { __skillId, ...input } = action.args;
    const skill = await this.prisma.aiSkill.findFirst({
      where: {
        organizationId: ctx.organizationId, isActive: true, deletedAt: null,
        ...(typeof __skillId === 'string' ? { id: __skillId } : { name: action.toolName }),
      },
    });
    if (!skill?.toolId) throw new Error('Skill not found or inactive');
    const tool = await this.prisma.aiTool.findFirst({
      where: { id: skill.toolId, organizationId: ctx.organizationId, isActive: true, deletedAt: null },
    });
    if (!tool) throw new Error('Tool not found or inactive');
    await this.actions.assertContext(ctx);
    const executor = skill.source === 'SQL' ? this.sqlExecutor : this.httpExecutor;
    const result = await executor.execute(skill, tool, input, ctx, {
      bypassPendingGate: true,
      idempotencyKey: ctx.idempotencyKey,
    });
    return result.output;
  }
}
