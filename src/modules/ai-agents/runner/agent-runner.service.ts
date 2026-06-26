import { Injectable, Logger } from '@nestjs/common';
import {
  AiFinalAction,
  AiRunStatus,
  Conversation,
  Message,
  AiSkill,
  AiTool,
  NotificationType,
} from '@prisma/client';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { PrismaService } from '../../../database/prisma.service';
import { LlmService } from '../llm/llm.service';
import { LlmMessage, LlmToolCall, LlmToolDefinition } from '../llm/llm.types';
import { ToolRegistry } from '../tools/tool-registry.service';
import { ToolContext } from '../tools/tool.types';
import { HttpToolExecutorService } from '../tools/http-tool-executor.service';
import { SqlToolExecutorService } from '../tools/sql-tool-executor.service';
import { PromptBuilderService } from './prompt-builder.service';
import { ModelRouterService, type AgentKind } from './model-router.service';
import { CatalogSyncService } from './catalog-sync.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { isToolCallFailure } from '../agents/agents.service';
import {
  AgentRouterService,
  type AgentSelection,
} from '../router/agent-router.service';
import {
  SecurityLayerService,
  resolveSecurityRules,
} from '../prompts/layers/security.layer';
import type { SecurityRules } from '../prompts/types';
import { RetrievalService } from '../rag/retrieval.service';
import { IntentType } from '../classifier/intent.types';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { sanitizeAssistantText } from './text-guards';
import { MediaUrlResolverService } from './media-url-resolver.service';

const MAX_TOOL_ITERATIONS = 8;
const MAX_RECENT_MESSAGES = 30;

/**
 * Acima desta confiança, mensagens classificadas como SPAM_OR_NOISE são
 * ignoradas sem rodar nenhum agente (o classifier barato já decidiu). Antes
 * isso caía no Augusto (orquestrador caro) só pra ele mandar transferToHuman.
 */
const SPAM_SKIP_CONFIDENCE = 0.8;

/**
 * Tools that signal "agent is preparing to sell": pulled product info,
 * checked the customer's purchase status, etc. If any of these ran but
 * replyToConversation never did, we know the agent gathered intent and
 * then went silent — exactly the failure mode where the customer gets
 * nothing after saying "sim, me manda o link". One synthetic nudge
 * forces a final iteration so the link actually goes out.
 */
const SALES_PREP_TOOLS = new Set([
  'lookupOffering',
  'getProductPitch',
  'checkPurchase',
]);

interface RunInput {
  conversation: Conversation;
  triggerMessage: Message;
  /**
   * Internal: how many auto-chained runs already happened in this turn.
   * Bounded to avoid infinite recursion when an agent delegates back and
   * forth. Set automatically on chained calls, callers shouldn't pass this.
   */
  chainDepth?: number;
}

const MAX_CHAIN_DEPTH = 3;

@Injectable()
export class AiAgentRunnerService {
  private readonly logger = new Logger(AiAgentRunnerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly registry: ToolRegistry,
    private readonly promptBuilder: PromptBuilderService,
    private readonly modelRouter: ModelRouterService,
    private readonly httpExecutor: HttpToolExecutorService,
    private readonly sqlExecutor: SqlToolExecutorService,
    private readonly catalogSync: CatalogSyncService,
    private readonly notifications: NotificationsService,
    private readonly agentRouter: AgentRouterService,
    private readonly securityLayer: SecurityLayerService,
    private readonly retrieval: RetrievalService,
    private readonly realtime: RealtimeGateway,
    private readonly mediaUrlResolver: MediaUrlResolverService,
    @InjectQueue('memory-extractor')
    private readonly memoryExtractorQueue: Queue,
    @InjectQueue('rag-indexer')
    private readonly ragIndexerQueue: Queue,
  ) {}

  async run({
    conversation,
    triggerMessage,
    chainDepth = 0,
  }: RunInput): Promise<void> {
    // Fase 2: usa o agentRouter (com IntentClassifier) pra escolher o agent.
    // Auto-chains (chainDepth > 0) NÃO classificam de novo — já tem activeAgentId.
    let selection: AgentSelection | null = null;
    if (chainDepth === 0) {
      const triggerText = this.extractText(
        (triggerMessage.content as unknown) ?? '',
      );
      selection = await this.agentRouter.selectAgent(
        conversation,
        triggerText,
        [],
      );

      // Curto-circuito por intenção: spam/ruído com confiança alta não merece
      // rodar agente LLM nenhum. O classifier (fugu, barato) já decidiu —
      // apenas ignoramos. Economiza 100% do run que antes caía no Augusto.
      if (
        selection?.classifiedIntent === IntentType.SPAM_OR_NOISE &&
        (selection.classifierConfidence ?? 0) >= SPAM_SKIP_CONFIDENCE
      ) {
        this.logger.log(
          `Conv ${conversation.id}: intent=SPAM_OR_NOISE (conf=${selection.classifierConfidence}) — skipping agent run`,
        );
        return;
      }
    }
    const agent = selection
      ? await this.prisma.aiAgent.findFirst({
          where: { id: selection.agentId, isActive: true, deletedAt: null },
        })
      : await this.resolveAgent(conversation);
    if (!agent) {
      this.logger.debug(
        `No agent resolved for conv ${conversation.id} — skipping run`,
      );
      return;
    }

    const [organization, channel, contact, recentMessages, memory, catalog] =
      await Promise.all([
        this.prisma.organization.findUniqueOrThrow({
          where: { id: conversation.organizationId },
        }),
        this.prisma.channel.findUniqueOrThrow({
          where: { id: conversation.channelId },
        }),
        this.prisma.contact.findUniqueOrThrow({
          where: { id: conversation.contactId },
        }),
        this.prisma.message.findMany({
          where: { conversationId: conversation.id },
          orderBy: { createdAt: 'desc' },
          take: MAX_RECENT_MESSAGES,
        }),
        this.prisma.aiAgentMemory.findUnique({
          where: {
            agentId_contactId: {
              agentId: agent.id,
              contactId: conversation.contactId,
            },
          },
        }),
        // Compact product list for the cacheable system prompt block.
        // Source of truth: Trivapp /api/v1/catalog (5min in-memory cache).
        // Skill getProductPitch(slug) fetches full details on demand.
        this.catalogSync.getCompactCatalog(conversation.organizationId),
      ]);

    const run = await this.prisma.aiAgentRun.create({
      data: {
        organizationId: conversation.organizationId,
        conversationId: conversation.id,
        agentId: agent.id,
        triggerMessageId: triggerMessage.id,
        modelId: agent.modelId,
        status: AiRunStatus.RUNNING,
        classifiedIntent: selection?.classifiedIntent ?? null,
        classifierConfidence: selection?.classifierConfidence ?? null,
        skippedOrchestrator: selection?.skippedOrchestrator ?? false,
      },
    });

    // Realtime: powers the per-conversation agent-runs sidebar. Operators
    // see the run appear the instant we boot it, even before the first
    // tool call lands. Frontend joins `conv:<id>` while the chat is open.
    this.realtime.emitToConversation(conversation.id, 'ai:run:start', {
      conversationId: conversation.id,
      runId: run.id,
      agent: { id: agent.id, name: agent.name, kind: agent.kind },
      modelId: agent.modelId,
      startedAt: run.startedAt,
      classifiedIntent: selection?.classifiedIntent ?? null,
      classifierConfidence: selection?.classifierConfidence
        ? Number(selection.classifierConfidence)
        : null,
      triggerMessageId: triggerMessage.id,
    });

    // Resolve every tool the agent can call:
    //   1. built-in defaults filtered by kind (reply/transfer/tag/...);
    //   2. tools attached via skills (each skill.tools[]);
    //   3. tools attached directly to the agent (agent.extraTools).
    // Custom HTTP tools live in the DB; we keep their rows here so the
    // runner can hand them to HttpToolExecutor on tool-call time.
    const { llmTools, customSkillsByName, skillInstructions } =
      await this.resolveToolsAndSkills(agent.id, agent.kind);

    const startedAt = Date.now();

    // Resolve URLs playable de mídia (imagens etc) ANTES de construir
    // o prompt — o provider LLM precisa de URLs públicas pra image
    // blocks. Cache vive em Message.content.mediaUrl, então runs
    // subsequentes na mesma conversa não pagam de novo.
    const chronological = recentMessages.reverse();
    const channelTypeByConv = new Map<string, string>([
      [conversation.id, channel.type],
    ]);
    const mediaUrls = await this.mediaUrlResolver
      .resolveMany(chronological, channelTypeByConv)
      .catch((err) => {
        this.logger.warn(
          `media-url-resolver failed (run=${run.id}): ${err?.message ?? err}`,
        );
        return new Map<string, { url: string; mimeType?: string }>();
      });

    const messages = this.promptBuilder.buildMessages({
      organization,
      agent,
      channel,
      contact,
      conversation,
      recentMessages: chronological,
      mediaUrls,
      memorySummary: memory?.summary ?? null,
      memoryFacts: (memory?.facts as Record<string, unknown>) ?? null,
      triggerMessage,
      skillInstructions,
      catalog,
    });

    // Fase 2.5: augmenta o system message com Security Layer (prepend)
    // e RAG retrieval (append). Mantém o builder como source-of-truth da
    // estrutura principal do prompt — só decora com regras imutáveis e
    // contexto vetorial relevante do histórico longo do cliente.
    await this.augmentSystemPromptWithLayers(
      messages,
      organization,
      agent.id,
      conversation.contactId,
      conversation.id,
      this.extractText(triggerMessage.content as unknown),
    );

    const tools = llmTools;

    const aggregateUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
    };

    let finalAction: AiFinalAction = AiFinalAction.NO_ACTION;
    let iterationCount = 0;
    const toolsCalled = new Set<string>();
    let salesNudgeUsed = false;

    // Roteamento de modelo (fugu por padrão, fugu-ultra só na síntese de
    // workers). Iterações de ferramenta são mecânicas → modelo barato. A
    // resposta final ao cliente escala quando o agente é um especialista.
    const agentKind = agent.kind as AgentKind;
    const modelParams =
      (agent.modelParams as Record<string, unknown> | null) ?? undefined;
    const toolModel = this.modelRouter.selectModel({
      agentKind,
      modelId: agent.modelId,
      modelParams,
      phase: 'tool',
    });
    const synthesisModel = this.modelRouter.selectModel({
      agentKind,
      modelId: agent.modelId,
      modelParams,
      phase: 'synthesis',
    });
    // Chave estável de cache de prefixo por conversa (system + histórico
    // idênticos entre turnos → ~99% de cache hit comprovado na Sakana).
    const cacheKey = `conv:${conversation.id}`;
    // Quando true, a próxima chamada usa o modelo de síntese (escala a
    // resposta final do fugu pro fugu-ultra sem ter rodado as tools nele).
    let escalateSynthesis = false;
    // Hard cap of 1 successful replyToConversation per run. The system
    // prompt encourages "uma ideia por mensagem" + multi-step consultative
    // selling, but the runner used to fire every reply back-to-back in
    // the same turn — customers saw 2 bubbles with redundant CTAs ("quer
    // o link?" repeated). We now let the LLM emit one reply, then any
    // subsequent replyToConversation gets a soft error so the model
    // tags / hands off / ends. Other tools (tag, handBack, transfer)
    // still run normally.
    let replyAlreadySuccessful = false;

    try {
      // Mark this agent as the active one on the conversation.
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: { activeAgentId: agent.id },
      });

      while (iterationCount < MAX_TOOL_ITERATIONS) {
        iterationCount++;

        const modelForCall = escalateSynthesis ? synthesisModel : toolModel;
        escalateSynthesis = false;

        const response = await this.llm.complete({
          modelId: modelForCall,
          messages,
          tools,
          temperature: agent.temperature,
          maxTokens: agent.maxTokens,
          modelParams,
          cacheKey,
        });

        aggregateUsage.inputTokens += response.usage.inputTokens;
        aggregateUsage.outputTokens += response.usage.outputTokens;
        aggregateUsage.cacheReadTokens += response.usage.cacheReadTokens;
        aggregateUsage.cacheWriteTokens += response.usage.cacheWriteTokens;
        aggregateUsage.costUsd += response.usage.costUsd;

        if (response.stopReason === 'stop' || !response.message.toolCalls?.length) {
          // Tools rodaram no modelo barato; se a síntese final deve ser num
          // modelo mais forte (worker), re-roda SÓ esta resposta final no
          // modelo de síntese e descarta a versão barata. Garante "tools no
          // fugu, síntese no fugu-ultra" sem pagar ultra nas iterações de tool.
          if (modelForCall === toolModel && synthesisModel !== toolModel) {
            escalateSynthesis = true;
            continue;
          }
          // Model ended its turn without further tool calls. Some models
          // (especially after a tool result) emit the response as plain
          // assistant text instead of using replyToConversation explicitly.
          // Auto-send that text as a reply so we don't drop work the model
          // already paid for. Skip if a final action already happened
          // (transferred / closed / delegated) or a reply was already sent.
          const rawText = this.extractText(response.message.content);
          const text = sanitizeAssistantText(rawText);
          if (rawText && rawText !== text) {
            this.logger.warn(
              `Run ${run.id}: stripped turn markers from fallback text (raw="${rawText.slice(0, 80)}" → clean="${text.slice(0, 80)}")`,
            );
          }
          // Bail out if the model only emitted turn markers (e.g. "Human:")
          // or a stub too short to be a real reply. Sending such text would
          // look like the agent literally typing "Human: oi" to the user.
          const tooShortForReal = text.length < 4;
          if (text && !tooShortForReal && finalAction === AiFinalAction.NO_ACTION) {
            this.logger.log(
              `Run ${run.id}: model emitted text without replyToConversation, auto-sending as fallback`,
            );
            try {
              const replyTool = this.registry.get('replyToConversation');
              const result = await replyTool.execute(
                { text },
                {
                  organizationId: conversation.organizationId,
                  conversationId: conversation.id,
                  contactId: conversation.contactId,
                  channelId: conversation.channelId,
                  agentId: agent.id,
                  runId: run.id,
                  triggerMessageId: triggerMessage.id,
                },
              );
              if (result.finalAction) {
                finalAction = result.finalAction as AiFinalAction;
              }
            } catch (err: any) {
              this.logger.error(
                `Run ${run.id}: fallback reply failed: ${err?.message ?? err}`,
              );
            }
          } else if (rawText && (tooShortForReal || !text)) {
            this.logger.warn(
              `Run ${run.id}: skipping fallback — sanitized text was empty or too short ("${rawText.slice(0, 80)}")`,
            );
          }

          // Sales-prep nudge: agent gathered offer info + purchase status
          // but never sent a reply — classic "thought-but-didn't-speak"
          // failure that leaves the customer hanging. Inject one synthetic
          // user reminder and re-iterate. Bounded by salesNudgeUsed to
          // avoid loops if the model still refuses.
          const calledSalesPrep = [...SALES_PREP_TOOLS].some((t) =>
            toolsCalled.has(t),
          );
          const neverReplied = !toolsCalled.has('replyToConversation');
          const stillNoAction = finalAction === AiFinalAction.NO_ACTION;
          if (
            calledSalesPrep &&
            neverReplied &&
            stillNoAction &&
            !salesNudgeUsed
          ) {
            salesNudgeUsed = true;
            this.logger.warn(
              `Run ${run.id}: sales-prep tools ran but no replyToConversation — nudging model for one more turn`,
            );
            messages.push({
              role: 'user',
              content:
                'Você rodou as tools de preparação (lookupOffering / checkPurchase) mas não chamou replyToConversation. O cliente está esperando. Responda agora com replyToConversation: 1 frase de pitch ligada à dor + preço + link do checkout (vindos do lookupOffering). Não termine este turn sem chamar replyToConversation.',
            });
            continue;
          }
          break;
        }

        // Append the assistant's tool-calling turn so the model has it in
        // context when we feed back the tool results.
        messages.push(response.message);

        const toolResults = await this.executeToolCalls(
          response.message.toolCalls,
          {
            organizationId: conversation.organizationId,
            conversationId: conversation.id,
            contactId: conversation.contactId,
            channelId: conversation.channelId,
            agentId: agent.id,
            runId: run.id,
            triggerMessageId: triggerMessage.id,
          },
          customSkillsByName,
          replyAlreadySuccessful,
          agent.kind,
        );

        for (const result of toolResults) {
          toolsCalled.add(result.toolName);
          messages.push({
            role: 'tool',
            toolCallId: result.toolCallId,
            name: result.toolName,
            content: JSON.stringify(result.output),
          });
          if (result.finalAction && finalAction === AiFinalAction.NO_ACTION) {
            finalAction = result.finalAction as AiFinalAction;
          }
          if (
            result.toolName === 'replyToConversation' &&
            (result.output as any)?.ok === true
          ) {
            replyAlreadySuccessful = true;
          }
        }

        // Hard short-circuit: handing off / closing the conversation should
        // stop the loop even if the model would have wanted another turn.
        if (
          finalAction === AiFinalAction.TRANSFERRED_TO_HUMAN ||
          finalAction === AiFinalAction.CLOSED_CONVERSATION
        ) {
          break;
        }
      }

      const finishedAt = new Date();
      const durationMs = Date.now() - startedAt;
      await this.prisma.aiAgentRun.update({
        where: { id: run.id },
        data: {
          status: AiRunStatus.COMPLETED,
          finalAction,
          finishedAt,
          durationMs,
          inputTokens: aggregateUsage.inputTokens,
          outputTokens: aggregateUsage.outputTokens,
          cacheReadTokens: aggregateUsage.cacheReadTokens,
          cacheWriteTokens: aggregateUsage.cacheWriteTokens,
          costUsd: aggregateUsage.costUsd,
        },
      });
      this.realtime.emitToConversation(conversation.id, 'ai:run:end', {
        conversationId: conversation.id,
        runId: run.id,
        status: AiRunStatus.COMPLETED,
        finalAction,
        errorMessage: null,
        finishedAt,
        durationMs,
        inputTokens: aggregateUsage.inputTokens,
        outputTokens: aggregateUsage.outputTokens,
        cacheReadTokens: aggregateUsage.cacheReadTokens,
        cacheWriteTokens: aggregateUsage.cacheWriteTokens,
        costUsd: aggregateUsage.costUsd,
      });

      // Fase 2: enfileirar jobs assíncronos de memória + RAG
      // (fire-and-forget — falha não pode quebrar o run)
      this.scheduleAfterRunJobs(
        agent.id,
        conversation.id,
        conversation.contactId,
        triggerMessage,
        finalAction,
      ).catch((err) =>
        this.logger.warn(
          `Failed to schedule after-run jobs for run ${run.id}: ${err?.message ?? err}`,
        ),
      );

      // Auto-chain: if this run delegated to a worker, immediately fire the
      // worker run so the customer gets the new agent's first message right
      // away — no need to wait for them to send something. The worker reads
      // the full history (including the orchestrator's "vou te passar pra X")
      // and starts speaking. Bounded by MAX_CHAIN_DEPTH to avoid recursion.
      if (
        finalAction === AiFinalAction.DELEGATED &&
        chainDepth < MAX_CHAIN_DEPTH
      ) {
        const refreshed = await this.prisma.conversation.findUnique({
          where: { id: conversation.id },
        });
        if (refreshed && refreshed.activeAgentId && refreshed.activeAgentId !== agent.id) {
          this.logger.log(
            `Auto-chaining run for new active agent ${refreshed.activeAgentId} on conv ${conversation.id} (depth ${chainDepth + 1})`,
          );
          // Fire-and-forget — don't block the caller. The worker runs
          // asynchronously and emits its messages via realtime as usual.
          this.run({
            conversation: refreshed,
            triggerMessage,
            chainDepth: chainDepth + 1,
          }).catch((err) =>
            this.logger.error(
              `Auto-chain run failed for conv ${conversation.id}: ${err?.message ?? err}`,
            ),
          );
        }
      }
    } catch (err: any) {
      this.logger.error(
        `Agent run ${run.id} failed: ${err?.message ?? err}`,
        err?.stack,
      );
      const finishedAt = new Date();
      const durationMs = Date.now() - startedAt;
      const errorMessage = err?.message ?? String(err);
      await this.prisma.aiAgentRun.update({
        where: { id: run.id },
        data: {
          status: AiRunStatus.FAILED,
          errorMessage,
          finishedAt,
          durationMs,
          inputTokens: aggregateUsage.inputTokens,
          outputTokens: aggregateUsage.outputTokens,
          cacheReadTokens: aggregateUsage.cacheReadTokens,
          cacheWriteTokens: aggregateUsage.cacheWriteTokens,
          costUsd: aggregateUsage.costUsd,
        },
      });
      this.realtime.emitToConversation(conversation.id, 'ai:run:end', {
        conversationId: conversation.id,
        runId: run.id,
        status: AiRunStatus.FAILED,
        finalAction: null,
        errorMessage,
        finishedAt,
        durationMs,
        inputTokens: aggregateUsage.inputTokens,
        outputTokens: aggregateUsage.outputTokens,
        cacheReadTokens: aggregateUsage.cacheReadTokens,
        cacheWriteTokens: aggregateUsage.cacheWriteTokens,
        costUsd: aggregateUsage.costUsd,
      });
    }
  }

  /** Helper used by both code paths in executeToolCalls to keep the realtime
   *  shape in one place. Frontend appends to the matching run's toolCalls[]. */
  private emitToolCall(
    conversationId: string,
    runId: string,
    row: {
      id: string;
      toolName: string;
      input: unknown;
      output: unknown;
      error: string | null;
      durationMs: number | null;
      createdAt: Date;
    },
  ) {
    this.realtime.emitToConversation(conversationId, 'ai:run:tool-call', {
      conversationId,
      runId,
      toolCall: {
        id: row.id,
        toolName: row.toolName,
        input: row.input,
        output: row.output,
        error: row.error,
        durationMs: row.durationMs,
        createdAt: row.createdAt,
      },
    });
  }

  private async resolveAgent(conversation: Conversation) {
    if (conversation.activeAgentId) {
      const active = await this.prisma.aiAgent.findFirst({
        where: { id: conversation.activeAgentId, isActive: true, deletedAt: null },
      });
      if (active) return active;
    }
    // Hoje agents são auto-linkados a todos os canais. Sem prioridade,
    // qualquer worker AUTONOMOUS poderia capturar o primeiro turno e
    // ignorar a hierarquia. Sempre que houver ORCHESTRATOR no canal,
    // ele entra primeiro — ele decide quem delegar.
    const orchestratorLink = await this.prisma.aiAgentChannel.findFirst({
      where: {
        channelId: conversation.channelId,
        mode: 'AUTONOMOUS',
        agent: { isActive: true, deletedAt: null, kind: 'ORCHESTRATOR' },
      },
      include: { agent: true },
      orderBy: { createdAt: 'asc' },
    });
    if (orchestratorLink?.agent) return orchestratorLink.agent;

    // Fallback: nenhum orquestrador linkado → worker primeiro disponível.
    const workerLink = await this.prisma.aiAgentChannel.findFirst({
      where: {
        channelId: conversation.channelId,
        mode: 'AUTONOMOUS',
        agent: { isActive: true, deletedAt: null },
      },
      include: { agent: true },
      orderBy: { createdAt: 'asc' },
    });
    return workerLink?.agent ?? null;
  }

  private async executeToolCalls(
    calls: LlmToolCall[],
    ctx: ToolContext,
    customSkillsByName: Map<string, AiSkill & { tool: AiTool | null }>,
    alreadyRepliedFromPriorIteration: boolean,
    agentKind: 'ORCHESTRATOR' | 'WORKER' = 'WORKER',
  ): Promise<
    Array<{
      toolCallId: string;
      toolName: string;
      output: unknown;
      finalAction?: string;
    }>
  > {
    const results: Array<{
      toolCallId: string;
      toolName: string;
      output: unknown;
      finalAction?: string;
    }> = [];
    // Tracks whether THIS batch already produced a successful reply.
    // Combined with the cross-iteration flag, it lets us block the very
    // first dup even when the model emits two replyToConversation calls
    // in a single tool_use response.
    let repliedInThisBatch = false;

    for (const call of calls) {
      const startedAt = Date.now();
      let output: unknown;
      let errorMessage: string | undefined;
      let finalAction: string | undefined;

      // Guard: only one successful replyToConversation per run. The LLM
      // sometimes "thinks aloud" by emitting 2 replies in sequence —
      // customer ends up with duplicate CTAs ("posso te mandar o link?"
      // twice). We let the model see a soft error and gracefully end
      // the turn (it usually pivots to tagConversation or stops).
      if (
        call.name === 'replyToConversation' &&
        (alreadyRepliedFromPriorIteration || repliedInThisBatch)
      ) {
        this.logger.warn(
          `Run ${ctx.runId}: blocked duplicate replyToConversation — agent already replied this turn`,
        );
        const blockedOutput = {
          ok: false,
          error:
            'Already replied this turn. Do NOT call replyToConversation again — wait for the customer to react. End the turn now (you may still tag/handBack/transfer if needed).',
        };
        results.push({
          toolCallId: call.id,
          toolName: call.name,
          output: blockedOutput,
        });
        const blockedRow = await this.prisma.aiToolCall.create({
          data: {
            runId: ctx.runId,
            toolName: call.name,
            input: call.arguments as object,
            output: blockedOutput as object,
            error: 'duplicate-reply-blocked',
            durationMs: 0,
          },
        });
        this.emitToolCall(ctx.conversationId, ctx.runId, blockedRow);
        continue;
      }

      // Run + auto-retry on transient failures only. We retry once with a
      // short backoff when the error looks transient (network, timeout,
      // 5xx upstream). 4xx and logic errors aren't retried because they
      // won't fix themselves — better to let the LLM see the error and
      // decide (transferToHuman, etc).
      let attempts = 0;
      const maxAttempts = 2;
      while (attempts < maxAttempts) {
        attempts++;
        errorMessage = undefined;
        try {
          const customSkill = customSkillsByName.get(call.name);
          if (customSkill && customSkill.tool) {
            const result =
              customSkill.source === 'SQL'
                ? await this.sqlExecutor.execute(
                    customSkill,
                    customSkill.tool,
                    call.arguments,
                    ctx,
                  )
                : await this.httpExecutor.execute(
                    customSkill,
                    customSkill.tool,
                    call.arguments,
                    ctx,
                  );
            output = result.output;
            finalAction = result.finalAction;
          } else if (
            this.registry.has(call.name) &&
            this.registry.isAllowedForAgent(call.name, agentKind, ctx.agentId)
          ) {
            // Built-in (gate de kind + allowlist por agente, ex.: client-ops).
            const tool = this.registry.get(call.name);
            const result = await tool.execute(call.arguments, ctx);
            output = result.output;
            finalAction = result.finalAction;
          } else {
            throw new Error(`Unknown tool: ${call.name}`);
          }
        } catch (err: any) {
          errorMessage = err?.message ?? String(err);
          output = { ok: false, error: errorMessage };
          this.logger.error(
            `Tool ${call.name} failed (attempt ${attempts}/${maxAttempts}): ${errorMessage}`,
          );
        }

        // Decide retry. If the call succeeded logically, exit the loop.
        // For failures, retry only when transient — don't punish the user
        // with a slower response for a 404 that won't recover.
        const failed =
          !!errorMessage ||
          isToolCallFailure({ error: errorMessage ?? null, output });
        if (!failed) break;
        if (attempts >= maxAttempts) break;
        if (!isTransientFailure(errorMessage, output)) break;
        await new Promise((r) => setTimeout(r, 500));
      }

      const toolCallRow = await this.prisma.aiToolCall.create({
        data: {
          runId: ctx.runId,
          toolName: call.name,
          input: call.arguments as object,
          output: output as object,
          error: errorMessage,
          durationMs: Date.now() - startedAt,
        },
      });
      this.emitToolCall(ctx.conversationId, ctx.runId, toolCallRow);

      // Surface silent failures: notify the org's humans whenever a tool
      // call returns ok:false / status>=400 OR an exception was thrown.
      // Without this, the Lívia case happens — IA transfers and nobody sees.
      if (isToolCallFailure({ error: errorMessage ?? null, output })) {
        this.notifyToolFailure({
          ctx,
          toolName: call.name,
          input: call.arguments,
          output,
          errorMessage,
        }).catch((e) =>
          this.logger.warn(
            `Failed to dispatch tool-failure notification: ${e?.message ?? e}`,
          ),
        );
      }

      results.push({
        toolCallId: call.id,
        toolName: call.name,
        output,
        finalAction,
      });

      if (
        call.name === 'replyToConversation' &&
        (output as any)?.ok === true
      ) {
        repliedInThisBatch = true;
      }
    }

    return results;
  }

  /**
   * Notifies every member of the org that a skill produced a failure.
   * Background dispatch — a notification miss shouldn't break the run.
   * Body summarizes the skill, the conversation, and the error so the
   * human can act without digging into the runs feed first.
   */
  private async notifyToolFailure(args: {
    ctx: ToolContext;
    toolName: string;
    input: unknown;
    output: unknown;
    errorMessage?: string;
  }) {
    const { ctx, toolName, input, output, errorMessage } = args;
    const summary =
      errorMessage ??
      this.summarizeFailureOutput(output) ??
      'Erro desconhecido na skill';

    await this.notifications.notifyOrgAgents({
      organizationId: ctx.organizationId,
      type: NotificationType.AI_TOOL_FAILURE,
      title: `Skill ${toolName} falhou`,
      body: `Conversa atendida pela IA teve falha em ${toolName}: ${summary}`,
      data: {
        runId: ctx.runId,
        agentId: ctx.agentId,
        conversationId: ctx.conversationId,
        toolName,
        input,
        output,
        errorMessage: errorMessage ?? null,
      },
    });
  }

  /** Pulls a human-readable error string from the executor's output JSON. */
  private summarizeFailureOutput(output: unknown): string | null {
    if (!output || typeof output !== 'object') return null;
    const o = output as Record<string, any>;
    if (typeof o.error === 'string') return o.error;
    const body = o.body;
    if (body && typeof body === 'object') {
      if (typeof body.message === 'string') return body.message;
      if (typeof body.error === 'string') return body.error;
    }
    if (Number.isFinite(Number(o.status))) return `HTTP ${o.status}`;
    return null;
  }

  /**
   * Computes the full tool catalog for an agent run:
   *   - kind-scoped built-in defaults from the in-memory registry
   *   - tools attached via skills (with their prompt instructions)
   *   - tools attached directly to the agent (no skill)
   *
   * Returns:
   *   llmTools           — tool defs to send to the LLM (deduped by name)
   *   customToolsByName  — DB rows for HTTP tools, used by the executor
   *   skillInstructions  — prompt fragments to append to system message
   */
  private async resolveToolsAndSkills(
    agentId: string,
    kind: 'ORCHESTRATOR' | 'WORKER',
  ): Promise<{
    llmTools: LlmToolDefinition[];
    customSkillsByName: Map<string, AiSkill & { tool: AiTool | null }>;
    skillInstructions: string[];
  }> {
    const skillLinks = await this.prisma.aiAgentSkill.findMany({
      where: { agentId },
      include: { skill: { include: { tool: true } } },
    });

    const skillInstructions: string[] = [];
    const customSkillsByName = new Map<
      string,
      AiSkill & { tool: AiTool | null }
    >();

    for (const link of skillLinks) {
      const skill = link.skill;
      if (!skill.isActive || skill.deletedAt) continue;
      if (skill.promptInstructions) {
        skillInstructions.push(skill.promptInstructions.trim());
      }
      if (skill.source === 'BUILTIN') {
        // Built-in skills are always available via registry — no need to
        // expose again. We respect the attachment as user intent though
        // (could be used later for auditing).
        continue;
      }
      if (skill.tool) {
        customSkillsByName.set(skill.name, skill);
      } else {
        this.logger.warn(
          `Skill ${skill.name} (${skill.source}) has no bound tool — skipping`,
        );
      }
    }

    // Built-in defaults — always available based on agent kind (tools com
    // allowlist de agentes só entram pro agente listado, ex.: client-ops).
    const defaultLlm = this.registry.getLlmDefinitionsForKind(kind, agentId);

    const seen = new Set<string>();
    const llmTools: LlmToolDefinition[] = [];
    for (const t of defaultLlm) {
      if (!seen.has(t.name)) {
        seen.add(t.name);
        llmTools.push(t);
      }
    }
    for (const [name, skill] of customSkillsByName) {
      if (!seen.has(name)) {
        seen.add(name);
        llmTools.push({
          name,
          description: skill.description,
          parameters: skill.parameters as Record<string, unknown>,
        });
      }
    }

    return { llmTools, customSkillsByName, skillInstructions };
  }

  /**
   * Extract plain text from an LlmMessage content. Handles both string
   * content and content blocks.
   */
  /**
   * Fase 2.5: augmenta o system message do prompt com:
   *   - Layer 1 SECURITY (prepend, cacheable): regras imutáveis da org
   *   - RAG retrieval (append, NÃO cacheable): top-K trechos relevantes do
   *     histórico longo do cliente, recuperados via similarity search
   *
   * Side-effect: muta `messages[0].content` in-place. Falhas no RAG são
   * silenciosas — agente continua respondendo só com contexto recente.
   */
  private async augmentSystemPromptWithLayers(
    messages: LlmMessage[],
    organization: { aiSecurityRules: unknown },
    agentId: string,
    contactId: string,
    conversationId: string,
    triggerText: string,
  ): Promise<void> {
    const firstMsg = messages[0];
    if (!firstMsg || firstMsg.role !== 'system' || !Array.isArray(firstMsg.content)) {
      return;
    }

    // 1) Security Layer (cacheable — estável por org)
    const rules: SecurityRules = resolveSecurityRules(
      (organization.aiSecurityRules as Partial<SecurityRules> | null) ?? undefined,
    );
    const securityPart = {
      type: 'text' as const,
      text: this.securityLayer.build(rules).content,
      cache: true,
    };

    // 2) RAG retrieval (não cacheable — varia por turno)
    let ragPart: { type: 'text'; text: string; cache: false } | null = null;
    if (triggerText && triggerText.length >= 10) {
      try {
        const results = await this.retrieval.retrieve({
          query: triggerText,
          scope: {
            agentId,
            contactId,
            conversationId,
            ownerType: 'any',
          },
          k: 5,
          minScore: 0.7,
        });
        if (results.length > 0) {
          const lines = results
            .map(
              (r, i) =>
                `${i + 1}. [${r.entry.ownerType}, score=${r.score.toFixed(2)}] ${r.entry.content.slice(0, 240)}`,
            )
            .join('\n');
          ragPart = {
            type: 'text',
            text: `═══ Trechos relevantes do histórico (RAG) ═══\n${lines}\n\nUse esses trechos como memória de longo prazo. NÃO os cite literalmente — apenas demonstre que lembra do contexto.`,
            cache: false,
          };
        }
      } catch (err: any) {
        this.logger.warn(`RAG retrieval failed: ${err?.message ?? err}`);
      }
    }

    firstMsg.content = [
      securityPart,
      ...firstMsg.content,
      ...(ragPart ? [ragPart] : []),
    ];
  }

  /**
   * Fase 2: enfileira jobs assíncronos pós-run.
   *  - memory-extractor: Fugu extrai facts/summary atualizado e grava em AiAgentMemory
   *  - rag-indexer: gera embedding da mensagem do cliente e indexa em ai_vector_entries
   *
   * Ambos são fire-and-forget — falha aqui não pode interromper o agent run.
   */
  private async scheduleAfterRunJobs(
    agentId: string,
    conversationId: string,
    contactId: string,
    triggerMessage: Message,
    finalAction: AiFinalAction,
  ): Promise<void> {
    // Só extrai memória quando o agent realmente respondeu / agiu —
    // runs que falharam ou foram ignorados não têm sinal útil pra extrair.
    const shouldExtract =
      finalAction === AiFinalAction.REPLIED ||
      finalAction === AiFinalAction.DELEGATED ||
      finalAction === AiFinalAction.TRANSFERRED_TO_HUMAN;
    if (shouldExtract) {
      try {
        await this.memoryExtractorQueue.add(
          'extract_memory',
          { agentId, contactId, conversationId },
          { removeOnComplete: 100, removeOnFail: 50 },
        );
      } catch (err: any) {
        this.logger.warn(
          `memory-extractor enqueue failed: ${err?.message ?? err}`,
        );
      }
    }

    // RAG: indexa mensagem do cliente (não as do agent — economiza)
    const messageText = this.extractText(triggerMessage.content as unknown);
    if (messageText && messageText.length >= 10) {
      try {
        await this.ragIndexerQueue.add(
          'index_message',
          {
            type: 'index_message',
            messageId: triggerMessage.id,
            content: messageText,
            scope: { conversationId, agentId, contactId },
          },
          { removeOnComplete: 200, removeOnFail: 50 },
        );
      } catch (err: any) {
        this.logger.warn(
          `rag-indexer enqueue failed: ${err?.message ?? err}`,
        );
      }
    }
  }

  private extractText(content: unknown): string {
    if (typeof content === 'string') return content.trim();
    if (Array.isArray(content)) {
      return content
        .map((block: any) => (typeof block?.text === 'string' ? block.text : ''))
        .join('')
        .trim();
    }
    return '';
  }
}

interface LlmMessageWithToolCalls extends LlmMessage {
  toolCalls?: LlmToolCall[];
}

// sanitizeAssistantText vive em ./text-guards (importado no topo) pra
// ser reutilizado pelo replyToConversation tool — segunda linha de defesa
// que intercepta texto antes de chegar no provider.

/**
 * Tells whether a tool failure is worth retrying. Transient = upstream
 * blip the second attempt might dodge: connection drops, timeouts,
 * 5xx HTTP responses. Definitive failures (4xx, validation, missing
 * resource) won't recover so we bail immediately and let the agent
 * react.
 */
function isTransientFailure(
  errorMessage: string | undefined,
  output: unknown,
): boolean {
  // Exception thrown — check message for known transient signatures.
  if (errorMessage) {
    const m = errorMessage.toLowerCase();
    if (
      m.includes('timeout') ||
      m.includes('econnreset') ||
      m.includes('econnrefused') ||
      m.includes('etimedout') ||
      m.includes('socket hang up') ||
      m.includes('network') ||
      m.includes('fetch failed')
    ) {
      return true;
    }
    // status 5xx baked into the message
    if (/\b(50\d|429)\b/.test(m)) return true;
    return false;
  }
  // Logical failure — retry only if status is 5xx or 429.
  if (output && typeof output === 'object') {
    const status = Number((output as any).status);
    if (Number.isFinite(status) && (status >= 500 || status === 429)) {
      return true;
    }
  }
  return false;
}
