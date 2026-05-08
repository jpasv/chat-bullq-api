import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { LlmService } from '../llm/llm.service';
import { ToolRegistry } from '../tools/tool-registry.service';
import { PromptComposerService } from '../prompts/composer/prompt-composer.service';
import { JudgeService } from './judge.service';
import { fixtures, type FixtureId, type FixtureTurn } from './fixtures/conversations';
import {
  EvalAgentResponse,
  EvalAssertion,
  EvalCase,
  EvalDataset,
  EvalResult,
  EvalRunReport,
} from './types';
import { EvalReporterService } from './reporter.service';
import type {
  LlmMessage,
  LlmToolCall,
  LlmToolDefinition,
} from '../llm/llm.types';
import type { AiAgent, AiSkill } from '@prisma/client';

/**
 * Built-in tools that any agent has access to during eval. We don't actually
 * execute them — we just expose their JSON Schemas to the LLM so it has the
 * option to call them, then capture the tool_call and translate it into
 * `EvalAgentResponse.toolCalls`.
 *
 * The list mirrors what ToolRegistry registers for ORCHESTRATOR + WORKER. We
 * pull schemas via `ToolRegistry.get(name)` to stay in sync with reality.
 */
const BUILTIN_TOOL_NAMES = [
  'replyToConversation',
  'tagConversation',
  'transferToHuman',
  'delegateToAgent',
  'handBackToOrchestrator',
  'listAvailableAgents',
  'getProductPitch',
  'checkBonusEligibility',
  'checkMembersAccess',
];

/**
 * Executa um EvalCase contra um agent de verdade — carrega o agent + skills
 * do banco, monta o prompt via `PromptComposerService`, chama `LlmService`
 * com as definitions das tools (built-in + custom skills) e CAPTURA os
 * tool_calls retornados pelo LLM sem executar nenhuma side-effect.
 *
 * Esta abordagem evita acoplar o `EvalRunnerService` ao `AiAgentRunnerService`
 * (que persiste no banco, despacha mensagens reais, etc) — para evals
 * basta saber:
 *   - quais tools o LLM decidiu chamar
 *   - quais argumentos passou (ex: o `message` em `replyToConversation`)
 *   - qual finalAction isso implicaria
 *
 * Asserções subjetivas (`judgeQuestion`) seguem delegando pro `JudgeService`.
 */
@Injectable()
export class EvalRunnerService {
  private readonly logger = new Logger(EvalRunnerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly registry: ToolRegistry,
    private readonly promptComposer: PromptComposerService,
    private readonly judge: JudgeService,
    private readonly reporter: EvalReporterService,
  ) {}

  /**
   * Roda um caso de teste contra o agent identificado por nome. Retorna o
   * resultado com lista de falhas (vazia se passou) e métricas de custo/duração.
   */
  async runCase(testCase: EvalCase, agentName: string): Promise<EvalResult> {
    const startedAt = Date.now();

    this.logger.log({
      msg: 'eval_case_started',
      caseName: testCase.name,
      agentName,
    });

    let agentResponse: EvalAgentResponse;
    let costUsd = 0;
    const failures: string[] = [];

    try {
      const invocation = await this.invokeAgent(testCase, agentName);
      agentResponse = invocation.response;
      costUsd = invocation.costUsd;
    } catch (err: any) {
      this.logger.error(
        `eval_case_invoke_failed name=${testCase.name} agent=${agentName} err=${err?.message ?? 'unknown'}`,
      );
      agentResponse = {
        toolCalls: [],
        finalMessage: '',
        finalAction: 'IGNORED',
      };
      failures.push(`Agent invocation failed: ${err?.message ?? 'unknown'}`);
    }

    await this.assertToolCalls(testCase.expect, agentResponse, failures);
    this.assertMessageContent(testCase.expect, agentResponse, failures);
    this.assertFinalAction(testCase.expect, agentResponse, failures);
    await this.assertJudge(testCase.expect, agentResponse, failures);

    const durationMs = Date.now() - startedAt;
    const passed = failures.length === 0;

    this.logger.log({
      msg: 'eval_case_completed',
      caseName: testCase.name,
      agentName,
      passed,
      failuresCount: failures.length,
      durationMs,
      costUsd,
    });

    return {
      case: testCase,
      passed,
      failures,
      agentResponse,
      costUsd,
      durationMs,
    };
  }

  /**
   * Roda um dataset inteiro contra seu agent e devolve o relatório. Usado
   * pelo CLI standalone e pelo controller HTTP.
   */
  async runDataset(dataset: EvalDataset): Promise<EvalRunReport> {
    const results: EvalResult[] = [];
    for (const testCase of dataset.cases) {
      const result = await this.runCase(testCase, dataset.agentName);
      results.push(result);
    }
    return this.reporter.buildReport({
      agentName: dataset.agentName,
      datasetName: dataset.agentName,
      results,
    });
  }

  // ─── agent invocation (REAL) ─────────────────────────────────────

  /**
   * Carrega agent + skills do DB, monta prompt e chama o LLM com tools.
   * NÃO executa as tools — só observa o que o LLM decidiu chamar e mapeia
   * pro `EvalAgentResponse`.
   */
  private async invokeAgent(
    testCase: EvalCase,
    agentName: string,
  ): Promise<{ response: EvalAgentResponse; costUsd: number }> {
    // 1. Load agent (active, not soft-deleted)
    const agent = (await this.prisma.aiAgent.findFirst({
      where: { name: agentName, isActive: true, deletedAt: null },
    })) as AiAgent | null;
    if (!agent) {
      throw new Error(`Agent "${agentName}" não encontrado (ou inativo)`);
    }

    // 2. Load skills attached to the agent
    const agentSkills = await this.prisma.aiAgentSkill.findMany({
      where: { agentId: agent.id },
      include: { skill: true },
    });
    const skills = agentSkills
      .map((as) => as.skill as AiSkill | undefined)
      .filter((s): s is AiSkill => !!s && s.isActive && s.deletedAt === null);

    // 3. Conversation history fixture (optional)
    const history = this.loadFixture(testCase.conversationContext);

    // 4. Compose system prompt (4-layer composer)
    const composed = this.promptComposer.compose({
      agent,
      skills,
      builtinTools: BUILTIN_TOOL_NAMES,
      enrichedContext: {
        contact: { name: 'Eval Test User' },
        channel: { kind: 'WHATSAPP', name: 'eval-channel' },
        time: {
          nowIso: new Date().toISOString(),
          timezone: 'America/Sao_Paulo',
          businessHours: true,
        },
        recentMessages: history.map((h) => ({
          role: h.role,
          content: h.content,
        })),
      },
    });

    // 5. Build LLM messages (system + history + current input)
    const messages: LlmMessage[] = [
      { role: 'system', content: composed.system },
      ...history.map<LlmMessage>((h) => ({
        role: h.role,
        content: h.content,
      })),
      { role: 'user', content: testCase.input },
    ];

    // 6. Build tool definitions: built-ins (filtered by agent kind) + custom skills
    const tools = this.collectToolDefinitions(agent, skills);

    // 7. Call LLM (no tool execution, no retries — we want the FIRST decision)
    const completion = await this.llm.complete({
      modelId: agent.modelId,
      messages,
      tools,
      temperature: agent.temperature,
      maxTokens: agent.maxTokens,
    });

    // 8. Translate tool_calls into EvalAgentResponse
    const rawCalls: LlmToolCall[] = completion.message.toolCalls ?? [];
    const toolCalls = rawCalls.map((tc) => ({
      name: tc.name,
      args: tc.arguments,
    }));

    const finalAction = resolveFinalAction(toolCalls);
    const finalMessage = extractFinalMessage(toolCalls, completion.message);

    return {
      response: {
        toolCalls,
        finalMessage,
        finalAction,
      },
      costUsd: completion.usage?.costUsd ?? 0,
    };
  }

  private collectToolDefinitions(
    agent: AiAgent,
    skills: AiSkill[],
  ): LlmToolDefinition[] {
    const defs: LlmToolDefinition[] = [];
    const seen = new Set<string>();

    // Built-ins for the agent's kind
    for (const def of this.registry.getLlmDefinitionsForKind(agent.kind)) {
      if (seen.has(def.name)) continue;
      seen.add(def.name);
      defs.push(def);
    }

    // Custom skills (HTTP/SQL) — we expose name + description + parameters
    // schema. The runner doesn't execute them; we just want the LLM to be
    // able to choose them.
    for (const s of skills) {
      if (seen.has(s.name)) continue;
      const params = normalizeSchema(s.parameters);
      defs.push({
        name: s.name,
        description: s.description,
        parameters: params,
      });
      seen.add(s.name);
    }

    return defs;
  }

  private loadFixture(id?: string): FixtureTurn[] {
    if (!id) return [];
    const turns = fixtures[id as FixtureId];
    if (!turns) {
      this.logger.warn(`Unknown conversation fixture: "${id}" — ignoring`);
      return [];
    }
    return turns;
  }

  // ─── assertions ──────────────────────────────────────────────────

  private async assertToolCalls(
    expect: EvalAssertion,
    response: EvalAgentResponse,
    failures: string[],
  ): Promise<void> {
    const calledNames = new Set(response.toolCalls.map((tc) => tc.name));

    if (expect.toolCalls && expect.toolCalls.length > 0) {
      for (const required of expect.toolCalls) {
        if (!calledNames.has(required)) {
          failures.push(
            `Esperado tool "${required}" ser chamado, mas não foi. ` +
              `Tools chamados: [${[...calledNames].join(', ') || 'nenhum'}]`,
          );
        }
      }
    }

    if (expect.shouldNotCall && expect.shouldNotCall.length > 0) {
      for (const forbidden of expect.shouldNotCall) {
        if (calledNames.has(forbidden)) {
          failures.push(
            `Tool "${forbidden}" NÃO deveria ter sido chamado, mas foi.`,
          );
        }
      }
    }
  }

  private assertMessageContent(
    expect: EvalAssertion,
    response: EvalAgentResponse,
    failures: string[],
  ): void {
    const message = response.finalMessage ?? '';
    const lower = message.toLowerCase();

    if (expect.messageContains && expect.messageContains.length > 0) {
      for (const needle of expect.messageContains) {
        if (!lower.includes(needle.toLowerCase())) {
          failures.push(
            `Mensagem deveria conter "${needle}". Recebido: "${this.truncate(message, 200)}"`,
          );
        }
      }
    }

    if (expect.messageNotContains && expect.messageNotContains.length > 0) {
      for (const forbidden of expect.messageNotContains) {
        if (lower.includes(forbidden.toLowerCase())) {
          failures.push(
            `Mensagem NÃO deveria conter "${forbidden}", mas contém. Recebido: "${this.truncate(message, 200)}"`,
          );
        }
      }
    }
  }

  private assertFinalAction(
    expect: EvalAssertion,
    response: EvalAgentResponse,
    failures: string[],
  ): void {
    if (expect.finalAction && response.finalAction !== expect.finalAction) {
      failures.push(
        `finalAction esperado "${expect.finalAction}", recebido "${response.finalAction}"`,
      );
    }

    if (expect.delegateTo) {
      if (expect.finalAction && expect.finalAction !== 'DELEGATED') {
        // Inconsistência no próprio caso — sinalizamos como falha pra
        // forçar correção do dataset.
        failures.push(
          `delegateTo informado mas finalAction esperado é "${expect.finalAction}" (deveria ser DELEGATED)`,
        );
      }

      // Quando delegateToAgent é chamado, args.agentName ou args.agentId
      // identifica o destino. Validamos se foi pro agent esperado.
      const delegateCall = response.toolCalls.find(
        (tc) => tc.name === 'delegateToAgent',
      );
      if (delegateCall) {
        const args = (delegateCall.args ?? {}) as Record<string, unknown>;
        const targetName =
          typeof args.agentName === 'string'
            ? args.agentName
            : typeof args.targetAgent === 'string'
              ? args.targetAgent
              : typeof args.agent === 'string'
                ? args.agent
                : '';
        if (
          targetName &&
          !targetName.toLowerCase().includes(expect.delegateTo.toLowerCase())
        ) {
          failures.push(
            `delegateTo esperado "${expect.delegateTo}", recebido "${targetName}"`,
          );
        }
      }
    }
  }

  private async assertJudge(
    expect: EvalAssertion,
    response: EvalAgentResponse,
    failures: string[],
  ): Promise<void> {
    if (!expect.judgeQuestion) return;

    const expectedVerdict = expect.judgeMustBe ?? 'pass';
    const verdict = await this.judge.evaluate(
      expect.judgeQuestion,
      response.finalMessage ?? '',
    );

    if (verdict.verdict !== expectedVerdict) {
      failures.push(
        `Judge esperava "${expectedVerdict}" mas retornou "${verdict.verdict}". ` +
          `Razão: ${verdict.reasoning}`,
      );
    }
  }

  private truncate(s: string, max: number): string {
    if (s.length <= max) return s;
    return `${s.slice(0, max)}…`;
  }
}

// ─── helpers (module-level, pure) ───────────────────────────────────

function resolveFinalAction(
  toolCalls: { name: string; args: unknown }[],
): EvalAgentResponse['finalAction'] {
  const names = new Set(toolCalls.map((tc) => tc.name));
  if (names.has('replyToConversation')) return 'REPLIED';
  if (names.has('delegateToAgent')) return 'DELEGATED';
  if (names.has('transferToHuman')) return 'TRANSFERRED_TO_HUMAN';
  if (names.has('handBackToOrchestrator')) return 'HANDED_BACK';
  return 'IGNORED';
}

function extractFinalMessage(
  toolCalls: { name: string; args: unknown }[],
  message: LlmMessage,
): string {
  // Preferred path: the LLM decided to reply via replyToConversation, so the
  // outbound copy is in args.message.
  const replyCall = toolCalls.find((tc) => tc.name === 'replyToConversation');
  if (replyCall) {
    const args = (replyCall.args ?? {}) as Record<string, unknown>;
    if (typeof args.message === 'string') return args.message;
    if (typeof args.text === 'string') return args.text;
    if (typeof args.content === 'string') return args.content;
  }
  // Fallback: raw assistant content (model didn't call any reply tool).
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => p.text ?? '').join('');
  return '';
}

/**
 * AiSkill.parameters comes from JSON column. We need a JSON-Schema object;
 * if it's null/undefined or not an object, fall back to an empty object schema
 * so the LLM doesn't reject the request.
 */
function normalizeSchema(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    if (obj.type === 'object') return obj;
    return { type: 'object', properties: obj };
  }
  return { type: 'object', properties: {} };
}
