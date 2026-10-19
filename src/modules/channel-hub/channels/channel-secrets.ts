/**
 * Mascaramento de segredos do Channel nas respostas pro browser.
 *
 * List/detail/update devolvem `webhookSecret` e chaves "secretas" do config
 * (`callbackSecret`, tokens, senhas...) mascaradas. O valor completo só sai
 * na criação e no endpoint explícito `GET /channels/:id/secrets`.
 *
 * O PATCH aceita o placeholder mascarado de volta e o IGNORA (mantém o valor
 * salvo) — assim um diálogo de edição que reenvia o config inteiro não
 * sobrescreve credenciais com "********".
 */

export const SECRET_MASK_PREFIX = '********';

const SECRET_KEY_RE = /(secret|token|password|passwd|api[-_]?key|private[-_]?key)/i;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}

export function maskSecret(value: unknown): unknown {
  if (typeof value !== 'string' || value.length === 0) return value;
  return value.length >= 12
    ? `${SECRET_MASK_PREFIX}${value.slice(-4)}`
    : SECRET_MASK_PREFIX;
}

export function isMaskedValue(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(SECRET_MASK_PREFIX);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function maskConfig(config: unknown): unknown {
  if (!isPlainObject(config)) return config;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    if (isSecretKey(k) && typeof v === 'string') out[k] = maskSecret(v);
    else if (isPlainObject(v)) out[k] = maskConfig(v);
    else out[k] = v;
  }
  return out;
}

export function maskChannel<T extends { webhookSecret?: string | null; config?: unknown }>(
  channel: T,
): T;
export function maskChannel<T extends { webhookSecret?: string | null; config?: unknown }>(
  channel: T | null,
): T | null;
export function maskChannel<T extends { webhookSecret?: string | null; config?: unknown }>(
  channel: T | null,
): T | null {
  if (!channel) return channel;
  return {
    ...channel,
    webhookSecret: maskSecret(channel.webhookSecret ?? null) as string | null,
    config: maskConfig(channel.config),
  };
}

/**
 * Troca placeholders mascarados do config recebido pelos valores atuais.
 * Placeholder sem valor atual correspondente é descartado.
 */
export function restoreMaskedConfig(
  incoming: Record<string, unknown>,
  current: unknown,
): Record<string, unknown> {
  const cur = isPlainObject(current) ? current : {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (isMaskedValue(v)) {
      if (k in cur) out[k] = cur[k];
      continue;
    }
    if (isPlainObject(v)) {
      out[k] = restoreMaskedConfig(v, cur[k]);
      continue;
    }
    out[k] = v;
  }
  return out;
}
