/**
 * Busca que ignora maiúscula/minúscula, acento e espaço sobrando: "joao",
 * "JOÃO" e " João " acham o mesmo contato.
 *
 * O banco guarda `contacts.search_name` já normalizado por trigger, com a
 * função SQL `chat_normalize_search` (migration
 * 20261124120000_contact_search_name). As duas fazem a mesma coisa — se
 * mudar uma, mudar a outra (numa migration nova que refaça o backfill),
 * senão o termo digitado e a coluna deixam de bater.
 */

/** Letras que o NFD não decompõe (não têm acento "separável"). */
const EXTRA_FROM = 'øđłħŧıð';
const EXTRA_TO = 'odlhtid';
const EXTRA_MAP = new Map([...EXTRA_FROM].map((ch, i) => [ch, EXTRA_TO[i]]));

const COMBINING_MARKS = /[̀-ͯ]/g;
const PHONE_LIKE = /^[\d\s()+.-]+$/;

export function normalizeSearchText(value: string): string {
  const stripped = value.toLowerCase().normalize('NFD').replace(COMBINING_MARKS, '');
  let out = '';
  for (const ch of stripped) out += EXTRA_MAP.get(ch) ?? ch;
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Telefone fica salvo só com dígitos (5521990451258). Se o termo parece
 * telefone — "(21) 99045-1258", "+55 21 99045" —, devolve só os dígitos;
 * senão null.
 */
export function toPhoneSearch(value: string): string | null {
  const term = value.trim();
  if (!PHONE_LIKE.test(term)) return null;
  const digits = term.replace(/\D/g, '');
  return digits || null;
}
