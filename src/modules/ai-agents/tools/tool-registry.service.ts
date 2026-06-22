import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiAgentKind } from '@prisma/client';
import { AiTool as BuiltInSkillImpl, toLlmDefinition } from './tool.types';
import { LlmToolDefinition } from '../llm/llm.types';
import { ReplyToConversationTool } from './builtin/reply-to-conversation.tool';
import { TransferToHumanTool } from './builtin/transfer-to-human.tool';
import { TagConversationTool } from './builtin/tag-conversation.tool';
import { ListAvailableAgentsTool } from './builtin/list-available-agents.tool';
import { DelegateToAgentTool } from './builtin/delegate-to-agent.tool';
import { HandBackToOrchestratorTool } from './builtin/hand-back-to-orchestrator.tool';
import { GetProductPitchTool } from './builtin/get-product-pitch.tool';
import { CheckBonusEligibilityTool } from './builtin/check-bonus-eligibility.tool';
import { CheckMembersAccessTool } from './builtin/check-members-access.tool';
import { ConsultarClickUpClienteTool } from './builtin/consultar-clickup-cliente.tool';
import { ConsultarN8nClienteTool } from './builtin/consultar-n8n-cliente.tool';
import { ListarReunioesClienteTool } from './builtin/listar-reunioes-cliente.tool';
import { LerTranscricaoReuniaoTool } from './builtin/ler-transcricao-reuniao.tool';
import { AgendarReuniaoTool } from './builtin/agendar-reuniao.tool';
import { MoveRecoveryCardTool } from './builtin/move-recovery-card.tool';

/**
 * Registry of BUILT-IN skills (named "tools" in the code for legacy reasons).
 * These are TypeScript functions baked into the platform — they don't have
 * a row in ai_skills/ai_tools because they're always available to every
 * agent of the right kind. Custom skills (HTTP/SQL) live in the database
 * and are resolved at runtime via AiAgentSkill.
 *
 * Some built-ins are additionally restricted to specific agents (allowlist
 * de agentIds) — ex.: client-ops da Sofia, que mexem com credenciais de
 * clientes e não fazem sentido pros workers de vendas.
 */
@Injectable()
export class ToolRegistry {
  private readonly logger = new Logger(ToolRegistry.name);
  private readonly tools = new Map<string, BuiltInSkillImpl>();
  private readonly scope = new Map<string, Set<AiAgentKind>>();
  /** Tool name → agentIds permitidos. Ausente = liberado pro kind inteiro. */
  private readonly agentAllowlist = new Map<string, Set<string>>();

  constructor(
    config: ConfigService,
    reply: ReplyToConversationTool,
    transfer: TransferToHumanTool,
    tag: TagConversationTool,
    listAgents: ListAvailableAgentsTool,
    delegate: DelegateToAgentTool,
    handBack: HandBackToOrchestratorTool,
    lookupOffering: GetProductPitchTool,
    checkBonusEligibility: CheckBonusEligibilityTool,
    checkMembersAccess: CheckMembersAccessTool,
    consultarClickUpCliente: ConsultarClickUpClienteTool,
    consultarN8nCliente: ConsultarN8nClienteTool,
    listarReunioesCliente: ListarReunioesClienteTool,
    lerTranscricaoReuniao: LerTranscricaoReuniaoTool,
    agendarReuniao: AgendarReuniaoTool,
    moveRecoveryCard: MoveRecoveryCardTool,
  ) {
    this.register(reply, ['ORCHESTRATOR', 'WORKER']);
    this.register(transfer, ['ORCHESTRATOR', 'WORKER']);
    this.register(tag, ['ORCHESTRATOR', 'WORKER']);
    this.register(listAgents, ['ORCHESTRATOR']);
    this.register(delegate, ['ORCHESTRATOR']);
    this.register(handBack, ['WORKER']);
    // Detalhes oficiais (preço/condições/link) das soluções da org —
    // ORCHESTRATOR e WORKER de vendas usam pra não inventar valor/link.
    this.register(lookupOffering, ['ORCHESTRATOR', 'WORKER']);
    // Cálculo determinístico de elegibilidade de bônus (D+7 corridos).
    // Disponível pra todos — bonus é dúvida frequente em qualquer fluxo.
    this.register(checkBonusEligibility, ['ORCHESTRATOR', 'WORKER']);
    // Read-only: cliente já tem acesso a entrega na área de membros?
    // Usado pra "não recebi o brinde" / "cadê o agente grátis" antes
    // de pedir email novamente ou prometer liberação.
    this.register(checkMembersAccess, ['ORCHESTRATOR', 'WORKER']);

    // Client-ops (implementação): restritas aos agentes do env
    // CLIENT_OPS_AGENT_IDS (csv) — default Sofia. Mexem com credenciais
    // de clientes (ClickUp/n8n/Drive/Calendar via Hoppe).
    const clientOpsAgents = (
      config.get<string>('CLIENT_OPS_AGENT_IDS') ?? 'agent_sofia_001'
    )
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    this.register(consultarClickUpCliente, ['WORKER'], clientOpsAgents);
    this.register(consultarN8nCliente, ['WORKER'], clientOpsAgents);
    this.register(listarReunioesCliente, ['WORKER'], clientOpsAgents);
    this.register(lerTranscricaoReuniao, ['WORKER'], clientOpsAgents);
    this.register(agendarReuniao, ['WORKER'], clientOpsAgents);

    // Recuperação de vendas: mover card no funil — restrito aos agentes do
    // env RECOVERY_AGENT_IDS (csv). Vazio = nenhum agente (tool inerte).
    const recoveryAgents = (config.get<string>('RECOVERY_AGENT_IDS') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (recoveryAgents.length > 0) {
      this.register(moveRecoveryCard, ['WORKER'], recoveryAgents);
    }

    this.logger.log(
      `Built-in skills loaded: ${[...this.tools.keys()].join(', ')} (client-ops → ${clientOpsAgents.join(', ')}; recovery → ${recoveryAgents.join(', ') || 'none'})`,
    );
  }

  private register(
    tool: BuiltInSkillImpl,
    kinds: AiAgentKind[],
    agentIds?: string[],
  ): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Duplicate built-in skill: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
    this.scope.set(tool.name, new Set(kinds));
    if (agentIds && agentIds.length > 0) {
      this.agentAllowlist.set(tool.name, new Set(agentIds));
    }
  }

  get(name: string): BuiltInSkillImpl {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new NotFoundException(`Unknown built-in skill: ${name}`);
    }
    return tool;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Built-in LLM defs filtered by agent kind — always included automatically.
   * Tools com allowlist só aparecem pro agentId listado.
   */
  getLlmDefinitionsForKind(
    kind: AiAgentKind,
    agentId?: string,
  ): LlmToolDefinition[] {
    return [...this.tools.values()]
      .filter((t) => this.scope.get(t.name)?.has(kind) ?? false)
      .filter((t) => {
        const allowlist = this.agentAllowlist.get(t.name);
        return !allowlist || (!!agentId && allowlist.has(agentId));
      })
      .map(toLlmDefinition);
  }

  isAllowedForKind(toolName: string, kind: AiAgentKind): boolean {
    return this.scope.get(toolName)?.has(kind) ?? false;
  }

  /** Gate de dispatch: kind certo E (sem allowlist OU agente na allowlist). */
  isAllowedForAgent(
    toolName: string,
    kind: AiAgentKind,
    agentId: string,
  ): boolean {
    if (!this.isAllowedForKind(toolName, kind)) return false;
    const allowlist = this.agentAllowlist.get(toolName);
    return !allowlist || allowlist.has(agentId);
  }
}
