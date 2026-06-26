/**
 * Tipos canônicos do Intent Classifier.
 *
 * O classifier roda ANTES do orchestrator (Augusto) e usa Fugu pra decidir
 * qual worker chamar quando dá pra ter certeza. Isso economiza ~40% de custo
 * + ~1.5s de latência em mensagens onde o roteamento é óbvio.
 *
 * Mensagens com intent ambíguo, small talk, spam ou pedido de escalação caem
 * de volta no orchestrator (skippedOrchestrator=false), que continua sendo
 * o caminho seguro pra qualquer coisa fora-da-curva.
 */

export enum IntentType {
  /** Curso de marketing/tráfego/copy → Daniel Souza */
  SALES_GENERAL = 'SALES_GENERAL',
  /** Dono de contabilidade procurando solução → André Silva */
  SALES_ACCOUNTING = 'SALES_ACCOUNTING',
  /** Advogado / banca jurídica → Bruno Costa */
  SALES_LEGAL = 'SALES_LEGAL',
  /** Cliente já comprou e precisa de ajuda → Lívia Andrade */
  SUPPORT = 'SUPPORT',
  /** Cliente em projeto de implementação (ClickUp/automações/reuniões) → Sofia Almeida */
  IMPLEMENTATION = 'IMPLEMENTATION',
  /** Oi/bom dia/agradecimento → Augusto responde direto */
  SMALL_TALK = 'SMALL_TALK',
  /** Não dá pra decidir → Augusto resolve */
  AMBIGUOUS = 'AMBIGUOUS',
  /** Spam, áudio sem transcrição, link suspeito → Augusto decide ação */
  SPAM_OR_NOISE = 'SPAM_OR_NOISE',
  /** Cliente irritado/ameaça/situação grave → transfere pra humano */
  ESCALATE_HUMAN = 'ESCALATE_HUMAN',
}

/** Mensagem do histórico recente passada como contexto ao classifier. */
export interface ClassifierMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ClassificationResult {
  intent: IntentType;
  /** 0.0 — 1.0. Abaixo do threshold cai pro orchestrator. */
  confidence: number;
  /** Explicação curta do Fugu — útil pra debug e auditoria. */
  reasoning: string;
  /** Ex.: 'Daniel Souza' — null quando o intent vai pro Augusto. */
  suggestedAgent: string | null;
  /** true quando confidence >= threshold E intent não é AMBIGUOUS/SPAM/ESCALATE. */
  skippedOrchestrator: boolean;
  /** ID do modelo realmente usado (ex.: 'sakana/fugu'). */
  modelUsed: string;
  /** Custo desta classificação em USD. */
  costUsd: number;
  /** Latência total da chamada em ms. */
  durationMs: number;
}

export interface ClassifierConfig {
  /** Default 0.85. Abaixo disso → fallback pro orchestrator. */
  threshold: number;
  /** Default 'sakana/fugu'. */
  model: string;
}
