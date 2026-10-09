import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AiSkill, AiTool } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { ToolContext, ToolResult } from './tool.types';
import { PendingActionService } from '../confirmations/pending-action.service';
import type {
  ActionPreview,
  ImpactLevel,
} from '../confirmations/confirmation.types';

/**
 * Tabela de impacto por skill. Quando o operador marca `requiresApproval=true`
 * em `ai_agent_skills`, a skill cria um PendingAction com este impacto.
 * Skills não listadas defaultam pra `medium`. Não tem efeito nenhum se a
 * skill não exigir aprovação — é só pra preencher o `preview.impact`.
 */
const SKILL_IMPACT: Record<string, ImpactLevel> = {
  grantAccess: 'high',
  resetPassword: 'high',
  sendLoginLink: 'medium',
};

function impactFor(skillName: string): ImpactLevel {
  return SKILL_IMPACT[skillName] ?? 'medium';
}

/**
 * Executes HTTP-backed Skills. The connection (base url + auth headers)
 * comes from the AiTool the skill is bound to; the per-call invocation
 * (path, method, body, response mapping) comes from the AiSkill itself.
 *
 * Destructive skills (ver `DESTRUCTIVE_HTTP_SKILLS`) NÃO são chamadas
 * diretamente: criamos um `PendingAction` e devolvemos pro LLM um output
 * com `requiresUserAction=true`. Quando o operador aprovar, o executor
 * da fase 2 dispara a chamada real.
 */
@Injectable()
export class HttpToolExecutorService {
  private readonly logger = new Logger(HttpToolExecutorService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly pendingActions: PendingActionService,
    private readonly prisma: PrismaService,
  ) {}

  async execute(
    skill: AiSkill,
    tool: AiTool,
    rawInput: Record<string, unknown>,
    ctx: ToolContext,
    options: { bypassPendingGate?: boolean; idempotencyKey?: string } = {},
  ): Promise<ToolResult> {
    if (skill.source !== 'HTTP') {
      throw new Error(`Skill ${skill.name} is not an HTTP skill`);
    }
    if (tool.source !== 'CUSTOM_HTTP') {
      throw new Error(
        `Skill ${skill.name} is HTTP but bound tool ${tool.name} isn't`,
      );
    }
    if (!tool.httpBaseUrl || !skill.httpMethod || !skill.httpPath) {
      return {
        output: {
          ok: false,
          error: 'Skill not fully configured (httpBaseUrl/httpMethod/httpPath missing)',
        },
      };
    }

    // Normaliza emails antes de qualquer uso. APIs do Trivapp (e várias
    // outras) tratam emails de forma case-sensitive em alguns endpoints
    // (ex: resetPassword retorna 404 com email "Foo@x.com" mas funciona
    // com "foo@x.com"). Forçar lowercase + trim no input ANTES do template
    // resolve essa classe inteira de bug sem depender do agent acertar.
    const input = this.normalizeEmailInputs(rawInput);

    // Gating configurável por (agent, skill): operador marca
    // `ai_agent_skills.requires_approval = true` na UI quando quer que a
    // skill seja gateada antes de executar pra esse agent específico.
    // `bypassPendingGate` é usado pelo executor pós-aprovação pra rodar
    // a skill DEPOIS que o operador aprovou (evita loop de PendingActions).
    const pending = await this.approvalGate(skill, input, ctx, options);
    if (pending) return pending;

    const url =
      this.renderTemplate(tool.httpBaseUrl, { input, ctx }).replace(/\/+$/, '') +
      '/' +
      this.renderTemplate(skill.httpPath, { input, ctx }).replace(/^\/+/, '');

    const method = skill.httpMethod.toUpperCase();
    const headers = {
      ...this.renderHeaders(tool.httpHeaders, { input, ctx }),
      ...this.renderHeaders(skill.httpHeadersExtra, { input, ctx }),
    };

    if (options.idempotencyKey) {
      for (const name of Object.keys(headers)) {
        if (name.toLowerCase() === 'idempotency-key') delete headers[name];
      }
      headers['Idempotency-Key'] = options.idempotencyKey;
    }

    let body: string | undefined;
    if (skill.httpBodyTemplate && method !== 'GET' && method !== 'DELETE') {
      body = this.renderTemplate(skill.httpBodyTemplate, { input, ctx });
      if (!headers['content-type'] && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
      }
    }

    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      skill.timeoutMs ?? 15000,
    );

    try {
      this.logger.log(
        `[skill:${skill.name}] ${method} ${url} (timeout=${skill.timeoutMs}ms)`,
      );
      const response = await fetch(url, {
        method,
        headers,
        body,
        signal: controller.signal,
      });

      const text = await response.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {}

      const ok = response.ok;
      const mapped = this.mapResponse(skill.responseMap, {
        body: parsed,
        status: response.status,
        ok,
      });
      const durationMs = Date.now() - startedAt;

      this.logger.log(
        `[skill:${skill.name}] ${response.status} in ${durationMs}ms ok=${ok}`,
      );

      const output =
        mapped !== undefined
          ? mapped
          : { ok, status: response.status, body: parsed };

      const logicalFailure = (value: unknown): boolean => !!value && typeof value === 'object' &&
        ((value as any).ok === false || (value as any).success === false || Boolean((value as any).error));
      if (!ok || logicalFailure(parsed) || logicalFailure(output)) {
        return { output: { ok: false, error: (parsed as any)?.error || (output as any)?.error || 'HTTP skill failed', status: response.status, body: parsed } };
      }
      return { output };
    } catch (err: any) {
      const isTimeout = err?.name === 'AbortError';
      const message = isTimeout
        ? `Skill ${skill.name} timed out after ${skill.timeoutMs}ms`
        : err?.message ?? String(err);
      this.logger.error(`[skill:${skill.name}] failed: ${message}`);
      return {
        output: { ok: false, error: message, timeout: isTimeout },
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async approvalGate(skill: AiSkill, input: Record<string, unknown>, ctx: ToolContext, options: { bypassPendingGate?: boolean; idempotencyKey?: string } = {}): Promise<ToolResult | null> {
    if (skill.organizationId !== ctx.organizationId) throw new Error('Skill outside organization');
    const link = ctx.skillBindings ? ctx.skillBindings.find(b => b.skillId === skill.id) : await this.prisma.aiAgentSkill.findUnique({
      where: { agentId_skillId: { agentId: ctx.agentId, skillId: skill.id } },
      select: { requiresApproval: true },
    });
    if (!link) throw new Error('Skill no longer assigned to agent');
    if (!options.bypassPendingGate && link.requiresApproval) {
      return this.gateAsPendingAction(skill, input, ctx, impactFor(skill.name));
    }
    return null;
  }

  // ─── helpers ───────────────────────────────────────────────────

  /**
   * Cria um PendingAction pra skill destrutiva e devolve um ToolResult que
   * sinaliza pro LLM "tá em revisão humana, não execute follow-up".
   */
  private async gateAsPendingAction(
    skill: AiSkill,
    input: Record<string, unknown>,
    ctx: ToolContext,
    impact: ImpactLevel,
  ): Promise<ToolResult> {
    const preview: ActionPreview = {
      action: this.buildPreviewAction(skill.name, input),
      impact,
      rollback: this.buildRollback(skill.name),
      affectedEntity: {
        type: 'contact',
        id: ctx.contactId,
        label: this.guessContactLabel(input) ?? `contact:${ctx.contactId}`,
      },
    };

    const action = await this.pendingActions.create({
      agentRunId: ctx.runId,
      conversationId: ctx.conversationId,
      agentId: ctx.agentId,
      toolName: skill.name,
      args: { ...input, __skillId: skill.id },
      preview,
    });

    this.logger.log(
      `[skill:${skill.name}] gated as pendingAction=${action.id} (impact=${impact})`,
    );

    return {
      output: {
        ok: true,
        status: 'queued_for_processing',
        pendingActionId: action.id,
        preview,
        // Mensagem desambígua pro LLM (Sonnet 4.6 estava interpretando o
        // wording anterior "aguardando aprovação humana" como sinal de
        // prompt injection e respondendo coisas paranoicas tipo "essa
        // mensagem não veio do cliente"). Aqui afirmamos explicitamente
        // que é FLUXO NORMAL e damos o roteiro de resposta pro cliente.
        message:
          'Solicitação registrada com sucesso e enviada pra processamento. Operador humano vai concluir a liberação em instantes — fluxo padrão, não é erro.',
        agent_should_say:
          'Avise o cliente, com naturalidade, que o acesso já foi solicitado e estará liberado em instantes. NÃO mencione "aprovação humana", "operador" ou qualquer detalhe interno do sistema.',
      },
    };
  }

  private buildPreviewAction(
    skillName: string,
    input: Record<string, unknown>,
  ): string {
    const email = this.guessContactLabel(input);
    const offer =
      typeof input.offerSlug === 'string'
        ? input.offerSlug
        : typeof input.offer === 'string'
          ? input.offer
          : undefined;

    switch (skillName) {
      case 'grantAccess':
        return offer
          ? `Liberar acesso de ${email ?? 'cliente'} ao(à) "${offer}"`
          : `Liberar acesso de ${email ?? 'cliente'} na área de membros`;
      case 'resetPassword':
        return `Resetar senha de ${email ?? 'cliente'} na área de membros`;
      case 'sendLoginLink':
        return `Enviar link mágico de login pra ${email ?? 'cliente'}`;
      default:
        return `Executar ${skillName}`;
    }
  }

  private buildRollback(skillName: string): string | undefined {
    switch (skillName) {
      case 'grantAccess':
        return 'Revogar acesso via revokeAccess (ou painel admin do Trivapp).';
      case 'resetPassword':
        return 'Não há rollback automático — orientar o cliente a definir nova senha.';
      case 'sendLoginLink':
        return 'Link expira sozinho; sem rollback necessário.';
      default:
        return undefined;
    }
  }

  private guessContactLabel(
    input: Record<string, unknown>,
  ): string | undefined {
    const email = input.email;
    if (typeof email === 'string' && email.trim()) return email.trim();
    return undefined;
  }

  private renderHeaders(
    raw: unknown,
    scopes: { input: Record<string, unknown>; ctx: ToolContext },
  ): Record<string, string> {
    if (!raw || typeof raw !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      out[key] = this.renderTemplate(String(value ?? ''), scopes);
    }
    return out;
  }

  private renderTemplate(
    template: string,
    scopes: { input: Record<string, unknown>; ctx: ToolContext },
  ): string {
    return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, expr) => {
      const [scope, ...rest] = String(expr).split('.');
      const path = rest.join('.');
      let source: Record<string, unknown> | undefined;
      if (scope === 'input') source = scopes.input;
      else if (scope === 'ctx') source = scopes.ctx as unknown as Record<string, unknown>;
      else if (scope === 'env') {
        const v = this.config.get<string>(path);
        if (v === undefined) {
          this.logger.warn(`Template references unknown env: ${path}`);
          return '';
        }
        return v;
      }
      if (!source) {
        this.logger.warn(`Unknown template scope: ${scope}`);
        return '';
      }
      const value = this.lookup(source, path);
      if (value === undefined || value === null) {
        this.logger.warn(`Unknown template path: ${expr}`);
        return '';
      }
      return typeof value === 'string' ? value : JSON.stringify(value);
    });
  }

  private mapResponse(
    map: unknown,
    scope: { body: unknown; status: number; ok: boolean },
  ): Record<string, unknown> | undefined {
    if (!map || typeof map !== 'object') return undefined;
    const out: Record<string, unknown> = {};
    for (const [key, expr] of Object.entries(map as Record<string, unknown>)) {
      if (typeof expr !== 'string') continue;
      out[key] = this.evalJsonPath(expr, scope);
    }
    return out;
  }

  private evalJsonPath(
    expr: string,
    scope: { body: unknown; status: number; ok: boolean },
  ): unknown {
    if (expr === '$.status') return scope.status;
    if (expr === '$.ok') return scope.ok;
    if (!expr.startsWith('$')) return expr;
    const path = expr.replace(/^\$\.?/, '');
    if (!path) return scope.body;
    return this.lookup(scope.body as Record<string, unknown>, path);
  }

  private lookup(obj: unknown, path: string): unknown {
    return path
      .split('.')
      .reduce<unknown>(
        (acc, key) =>
          acc && typeof acc === 'object'
            ? (acc as Record<string, unknown>)[key]
            : undefined,
        obj,
      );
  }

  /**
   * Normaliza qualquer campo que pareça email no input (top-level ou
   * dentro de objetos rasos): aplica `.toLowerCase().trim()`. Mantém
   * outros campos intactos. Defesa preventiva contra APIs case-sensitive
   * (Trivapp/resetPassword é o caso conhecido — bug Vinicius_leppers
   * em 2026-05-08).
   */
  private normalizeEmailInputs(
    input: Record<string, unknown>,
  ): Record<string, unknown> {
    const normalized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (this.looksLikeEmailKey(key) && typeof value === 'string') {
        normalized[key] = value.toLowerCase().trim();
      } else if (
        value &&
        typeof value === 'object' &&
        !Array.isArray(value)
      ) {
        // Recursão de 1 nível pra objetos rasos (ex: { user: { email: ... } })
        normalized[key] = this.normalizeEmailInputs(
          value as Record<string, unknown>,
        );
      } else {
        normalized[key] = value;
      }
    }
    return normalized;
  }

  private looksLikeEmailKey(key: string): boolean {
    // Match: email, e-mail, userEmail, contactEmail, etc.
    return /e[-_]?mail$/i.test(key) || /^email/i.test(key);
  }
}
