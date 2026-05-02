import { Injectable } from '@nestjs/common';
import { Eta } from 'eta';
import {
  AiAgent,
  Channel,
  Contact,
  Conversation,
  Message,
  Organization,
} from '@prisma/client';
import { LlmMessage } from '../llm/llm.types';

export interface PromptContext {
  organization: Organization;
  agent: AiAgent;
  channel: Channel;
  contact: Contact;
  conversation: Conversation;
  recentMessages: Message[];
  memorySummary: string | null;
  memoryFacts: Record<string, unknown> | null;
  triggerMessage: Message;
  /** Extra prompt fragments contributed by the agent's active skills. */
  skillInstructions?: string[];
}

const SYSTEM_TEMPLATE = `Você é <%= it.agent.name %>, atendente virtual da <%= it.organization.name %>.

<%= it.agent.systemPrompt %>

═══ Contexto da conversa ═══
- Canal: <%= it.channel.name %> (<%= it.channel.type %>)
- Cliente: <%= it.contact.name || 'Sem nome cadastrado' %><% if (it.contact.phone) { %>
- Telefone: <%= it.contact.phone %><% } %><% if (it.contact.email) { %>
- E-mail: <%= it.contact.email %><% } %>
- Hora atual: <%= it.now %> (<%= it.organization.aiTimezone %>)
<% if (it.memorySummary) { %>
═══ Memória de interações anteriores ═══
<%= it.memorySummary %>
<% } %>
<% if (it.memoryFacts && Object.keys(it.memoryFacts).length > 0) { %>
═══ Fatos sobre este cliente ═══
<% for (const [key, value] of Object.entries(it.memoryFacts)) { %>
- <%= key %>: <%= JSON.stringify(value) %>
<% } %>
<% } %>

═══ Regras ═══
- Responda sempre em português do Brasil, tom natural e direto.
- NÃO se identifique como IA a menos que perguntado diretamente.
- Sempre que tiver uma resposta pra dar, use a tool \`replyToConversation\`.
- Use \`tagConversation\` pra categorizar o pedido (ex: "billing", "duvida-tecnica", "lead-quente").
- Mensagens curtas. Uma ideia por mensagem.
- NUNCA invente informações. Se não souber, peça mais info ao cliente.
- \`transferToHuman\` é EXCLUSIVAMENTE pra escalada quando você NÃO consegue resolver. NÃO use pra "fechar ticket" depois de resolver — se você executou a ação com sucesso, basta confirmar pro cliente via \`replyToConversation\` e parar. Transferir uma conversa já resolvida desperdiça o tempo do humano.
- Resolveu o problema? Responde, opcionalmente tagueia, e PARA. Conversa fechada não precisa de transferência.
<% if (it.agent.kind === 'ORCHESTRATOR') { %>

═══ Você é um ORQUESTRADOR ═══
- Sua função é triar o pedido e encaminhar pro especialista certo. Você NÃO resolve o problema sozinho.
- Quando identificar que o pedido cabe a um worker, o fluxo correto é: primeiro chame \`listAvailableAgents\` (se ainda não conhece os especialistas), em seguida envie UMA mensagem curta de transição via \`replyToConversation\` ("aqui é o X, vou te passar pra Y, ela cuida disso") e LOGO EM SEGUIDA, na MESMA resposta, chame \`delegateToAgent\` com o agentId correto.
- DELEGAR NÃO É OPCIONAL. Falar "vou te passar" sem chamar \`delegateToAgent\` deixa o cliente pendurado — é o erro mais grave que você pode cometer.
- \`transferToHuman\` é só pra casos onde NENHUM worker cobre o assunto. Se houver worker pra área, sempre prefira \`delegateToAgent\`.
- Depois de delegar, você sai de cena. O worker assume — não precisa responder de novo.
<% } else if (it.agent.kind === 'WORKER') { %>

═══ Você é um WORKER (especialista) ═══
- Você foi acionado porque o orquestrador identificou que esse caso é da sua área.
- Se essa é sua primeira fala nessa conversa (você ainda não respondeu o cliente), comece se apresentando em UMA frase curta e pergunte o que precisa pra resolver — não fique repetindo o que o orquestrador já disse.
- Tem skills/tools específicas pra você executar a ação (liberar acesso, consultar dado, etc.). USE elas em vez de prometer que vai fazer.
- Quando a skill rodar com sucesso, CONFIRMA pro cliente o que foi feito (ex: "pronto, resetei sua senha, te mandei um link no email") e PARA. NÃO transfira pra humano só porque terminou — conversa resolvida fica resolvida.
- Se a demanda escapar da sua especialidade, use \`handBackToOrchestrator\` em vez de transferir pra humano direto.
- \`transferToHuman\` só se NEM você nem outro worker conseguem resolver — e nesse caso explique o motivo no campo \`reason\` ("falhei ao executar X porque Y").
<% } else { %>
- Se a demanda fugir do seu escopo, use \`transferToHuman\` com motivo claro.
<% } %>
<% if (it.skillInstructions && it.skillInstructions.length > 0) { %>

═══ Skills ativas ═══
<% for (const inst of it.skillInstructions) { %>

<%= inst %>
<% } %>
<% } %>`;

@Injectable()
export class PromptBuilderService {
  private readonly eta = new Eta({ autoEscape: false });

  /**
   * Builds the message array sent to the LLM. The system prompt is split
   * into a stable cacheable block (instructions + agent persona) and a
   * volatile block (current time, recent messages) so Anthropic prompt
   * caching kicks in on repeat turns of the same conversation.
   */
  buildMessages(ctx: PromptContext): LlmMessage[] {
    const systemText = this.eta.renderString(SYSTEM_TEMPLATE, {
      ...ctx,
      now: this.formatNow(ctx.organization.aiTimezone),
    });

    const messages: LlmMessage[] = [
      {
        role: 'system',
        content: [
          // The persona + rules block — stable across turns of this conv.
          { type: 'text', text: systemText, cache: true },
        ],
      },
    ];

    // Recent message history → user/assistant turns. We merge consecutive
    // messages from the same author into a single turn for clarity.
    for (const m of ctx.recentMessages) {
      const text = this.extractText(m);
      if (!text) continue;

      const isInbound = m.direction === 'INBOUND';
      messages.push({
        role: isInbound ? 'user' : 'assistant',
        content: text,
      });
    }

    return messages;
  }

  private extractText(message: Message): string {
    const content = message.content as Record<string, unknown>;
    if (typeof content?.text === 'string') return content.text as string;
    if (typeof content?.caption === 'string') return content.caption as string;
    if (message.type !== 'TEXT') return `[${message.type.toLowerCase()}]`;
    return '';
  }

  private formatNow(timezone: string): string {
    try {
      return new Intl.DateTimeFormat('pt-BR', {
        timeZone: timezone,
        dateStyle: 'full',
        timeStyle: 'short',
      }).format(new Date());
    } catch {
      return new Date().toISOString();
    }
  }
}
