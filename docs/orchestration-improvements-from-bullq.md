# Plano de melhorias de orquestração — inspirado no BullQ

Patterns extraídos de `~/www/bullq` (SaaS de email marketing com IA) que valem a pena portar pra `chat-bullq` (atendimento WhatsApp/Instagram com agents). Ranqueado por impacto vs esforço.

---

## 🔥 Top 3 — atacam o problema atual (Augusto promete e não delega)

### 1. Intent classifier upstream (Haiku) ANTES do orchestrator

**Origem:** `bullq/backend/src/modules/ai-core/services/intent-classifier.service.ts:82-154`

**Ideia:** Modelo barato (Haiku) classifica `{intentCategory, confidence, recommendedAgentId, missingInfo[]}` ANTES de qualquer agent rodar. Se confidence > 0.85, pula o orchestrator e dispara o worker direto. O LLM principal não decide mais "delegar ou não" — esse roteamento é do classifier.

**Aplicação aqui:**
- Novo serviço `IntentClassifierService` que roda na primeira mensagem nova de uma conversa.
- Modelo: Claude Haiku 4.5 (rápido + barato).
- Schema do output: `{ intent: string, confidence: number, recommendedAgentId?: string, missingInfo: string[] }`.
- Custo: ~1 chamada Haiku por mensagem nova. Impacto: elimina ~80% do problema atual.

### 2. Confidence-based routing

- **Alto (>0.85):** vai direto pro especialista (skip orchestrator).
- **Médio (0.6–0.85):** orchestrator pergunta info faltante (não delega ainda).
- **Baixo (<0.6):** cai no `transferToHuman` automaticamente.

**Aplicação aqui:** campo `confidenceThresholds` no `Channel` ou `Organization`.

### 3. previousResults context passing no handoff

**Origem:** `bullq/backend/src/modules/ai-core/executors/base.executor.ts:379-385`

**Ideia:** Quando muda de agent, monta um bloco de contexto "CONTEXTO — ações anteriores" que vai DENTRO do system prompt do worker.

**Aplicação aqui:** o `briefing` que já passamos em `delegateToAgent` deve ser injetado como bloco "CONTEXTO HERDADO" no system prompt da Lívia/André (logo após persona, antes do histórico). Hoje o briefing é só armazenado em `AiAgentHandoff` e não chega no prompt.

---

## ✅ Quick wins de UX

### 4. Suggested actions extraction
`ai-orchestrator.service.ts:769-815` — regex no output do LLM extrai sugestões tipo "Confirmar"/"Cancelar" e vira botão na UI. Pra WhatsApp dá pra virar quick replies.

### 5. Confirmation gate em skills destrutivas
`base.executor.ts:228-261` — antes de `revokeAccess` rodar, retorna preview ("vou revogar acesso de X ao curso Y, confirmar?"). LLM espera "confirmar" antes de executar. Adicionaria flag `requiresConfirmation: true` no `AiSkill`.

### 6. NATURAL_RESPONSE_PROMPT pós-tool
`base.executor.ts:463-541` — depois da skill rodar, faz uma chamada extra: "humanize esse output JSON pra mensagem de WhatsApp". Hoje a Lívia faz isso implicitamente — estruturar fica mais consistente.

---

## 🧠 Estruturais (longo prazo)

### 7. Prompt composition em camadas
`prompt-composer.service.ts` — hoje nosso prompt é 1 template Eta com tudo dentro. BullQ separa em 4 layers cacheáveis independentes:
- **Security** (immutable, sempre primeiro) — multi-tenant isolation, anti-injection
- **Personality** (agent.systemPrompt + sanitização) — tom, copy
- **Capabilities** (tools + skills do executor) — ações disponíveis
- **Context** (segments, tags, runtime data) — info dinâmica

Cada layer cacheable independente → Layer 1 cache hit altíssimo.

### 8. Sanitização de prompt do agent
`personality.layer.ts` — strip de jailbreak attempts antes de compor system prompt. Crítico se a Bravy deixar usuário editar prompt do worker.

### 9. Idempotency manager via Redis
`StateManager.ts` — track message IDs + tool calls pra não disparar a mesma skill 2x se houver retry. Hoje temos `runId` mas não dedup explícito.

### 10. Extended memory TTL por agent
`conversation-memory.service.ts:34-38` — alguns agents ganham 30 dias / 500 mensagens, outros 7 dias / 100. Configurable per-agent. Workers especialistas ganham mais; classifier só vê mensagens recentes.

---

## ⚠️ Patterns que NÃO valem portar

- **Streaming com chunks de 50 chars** — overkill pra WhatsApp (typing indicator nativo já resolve).
- **Degradation-aware model** — útil pra SaaS multi-tenant com créditos. Aqui Joao é dono da org.
- **Intent → Executor static mapping** — bullq tem intents fixos (WRITING_EMAIL, BUILD_AUTOMATION). Aqui é mais dinâmico (categorias variam por org). Manter delegateToAgent LLM-driven.

---

## Ordem sugerida de implementação

1. **Briefing como contexto explícito no worker** (1h) — fix imediato, complementa a delegação atômica.
2. **Intent classifier Haiku upstream** (3h) — elimina problema atual de delegação esquecida.
3. **Confidence-based routing** (1h) — depende do (2).
4. **Confirmation gate em destrutivas** (2h) — necessário pra `revokeAccess`.
5. **Prompt composition em camadas** (4h) — refactor maior, ganha cache + estrutura.
6. **NATURAL_RESPONSE_PROMPT pós-tool** (2h) — output mais consistente.
7. **Sanitização de prompt customizado** (1h) — antes de abrir edição de prompt pro cliente.
8. **Idempotency Redis** (3h) — antes de escala maior.

---

**Criado em:** 2026-05-02 a partir do report do agent Explore sobre `~/www/bullq`.
