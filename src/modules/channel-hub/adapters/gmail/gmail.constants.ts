export const GMAIL_POLL_QUEUE = 'gmail-poll';
export const GMAIL_POLL_JOB = 'gmail-poll-tick';

/** Cron default do poller — sobreponível via env GMAIL_POLL_PATTERN. */
export const GMAIL_POLL_PATTERN_DEFAULT = '*/1 * * * *';

/** Backfill inicial (horas) quando o canal ainda não tem watermark. */
export const GMAIL_INITIAL_LOOKBACK_HOURS_DEFAULT = 24;

/**
 * Máximo de emails ingeridos por canal num único backfill inicial —
 * sobreponível via env GMAIL_INITIAL_BACKFILL_MAX (backfills longos de
 * caixas movimentadas precisam de milhares).
 */
export const GMAIL_INITIAL_BACKFILL_MAX_DEFAULT = 100;

/**
 * Labels que NUNCA ingerimos:
 * - DRAFT: rascunho não é mensagem.
 * - SPAM/TRASH: responder spam automaticamente é footgun.
 * - CHAT: mensagens do finado Hangouts embutidas no Gmail, sem MIME.
 *
 * SENT passa de propósito: o mapper transforma from == própria caixa em
 * ECHO (OUTBOUND) — resposta enviada pelo app do Gmail aparece no chat
 * como respondida e cancela o watchdog (sem loop: echo nunca dispara IA,
 * e a saída do próprio chat morre no dedupe por externalId).
 */
export const GMAIL_SKIP_LABELS = new Set(['DRAFT', 'SPAM', 'TRASH', 'CHAT']);

/**
 * Config guardada em `Channel.config` pra canais GMAIL.
 * O OAuth App (client id/secret) é global via env — o refresh_token é o
 * que identifica/autoriza cada caixa.
 */
export interface GmailChannelConfig {
  /** Endereço da caixa (ex.: atendimento@cliente.com). */
  email: string;
  /** OAuth refresh_token da caixa (scopes gmail.readonly+send+modify). */
  refreshToken: string;
  /** Watermark do sync incremental (history.list). */
  lastHistoryId?: string;
  /** Última internalDate vista (ms) — fallback quando o historyId expira. */
  lastInternalDate?: number;
  /** 'draft' = IA gera rascunho pra revisão humana em vez de enviar. */
  sendMode?: 'send' | 'draft';
}
