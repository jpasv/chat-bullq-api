/**
 * Normalização do payload de webhook da Kirvano.
 *
 * A Kirvano manda um JSON por evento de venda/cobrança. Os campos relevantes
 * (confirmados em payloads reais): `event`, `customer.{name,email,phone_number,
 * document}`, `products[].{id,name,offer_id,price,is_order_bump}`, `sale_id`,
 * `checkout_id`, `total_price` ("R$ 297,00"), `payment_method`, `checkout_url`
 * (no abandono = link de recuperação) e `utm`.
 *
 * Aqui só extraímos/normalizamos — a decisão de criar/mover card fica no
 * service. Não há assinatura no header: a autenticação é o segredo na URL.
 */

/** Eventos que abrem/garantem uma Oportunidade (lead não pagou). */
export const KIRVANO_CREATE_EVENTS = [
  'PIX_GENERATED',
  'BANK_SLIP_GENERATED',
  'ABANDONED_CART',
  'PIX_EXPIRED',
  'BANK_SLIP_EXPIRED',
  'SALE_REFUSED',
] as const;

/** Eventos que fecham como Negócio Fechado (pago/aprovado). */
export const KIRVANO_WON_EVENTS = ['SALE_APPROVED'] as const;

/** Eventos que fecham como Reembolsado (estorno/chargeback). */
export const KIRVANO_REFUND_EVENTS = [
  'SALE_REFUNDED',
  'SALE_CHARGEBACK',
] as const;

export type KirvanoEventCategory = 'create' | 'won' | 'refund' | 'ignore';

export function classifyKirvanoEvent(event: string): KirvanoEventCategory {
  if ((KIRVANO_CREATE_EVENTS as readonly string[]).includes(event))
    return 'create';
  if ((KIRVANO_WON_EVENTS as readonly string[]).includes(event)) return 'won';
  if ((KIRVANO_REFUND_EVENTS as readonly string[]).includes(event))
    return 'refund';
  return 'ignore';
}

export interface KirvanoNormalized {
  event: string;
  category: KirvanoEventCategory;
  saleId: string | null;
  checkoutId: string | null;
  productUuid: string | null;
  offerId: string | null;
  productName: string | null;
  customerName: string | null;
  customerEmail: string | null;
  /** Apenas dígitos com DDI (ex: "5521985417582"). */
  customerPhone: string | null;
  value: number | null;
  currency: string;
  checkoutUrl: string | null;
  paymentMethod: string | null;
  utm: Record<string, unknown> | null;
}

/** "R$ 1.556,90" → 1556.9 ; "297" → 297 ; null/'' → null. */
export function parseBrlToNumber(input: unknown): number | null {
  if (input == null) return null;
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  const cleaned = String(input)
    .replace(/[^\d,.-]/g, '') // tira "R$", espaços, etc
    .replace(/\.(?=\d{3}(\D|$))/g, '') // remove separador de milhar
    .replace(',', '.'); // vírgula decimal → ponto
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Mantém só dígitos. "+55 (21) 98541-7582" → "5521985417582". */
export function normalizePhone(input: unknown): string | null {
  if (!input) return null;
  const digits = String(input).replace(/\D/g, '');
  return digits.length >= 10 ? digits : null;
}

export function normalizeKirvano(payload: any): KirvanoNormalized {
  const event = String(payload?.event ?? '').trim();
  const products: any[] = Array.isArray(payload?.products)
    ? payload.products
    : [];
  // Produto principal = primeiro que não é order bump (fallback: primeiro).
  const primary = products.find((p) => !p?.is_order_bump) ?? products[0] ?? null;
  const customer = payload?.customer ?? {};

  return {
    event,
    category: classifyKirvanoEvent(event),
    saleId: payload?.sale_id ? String(payload.sale_id) : null,
    checkoutId: payload?.checkout_id ? String(payload.checkout_id) : null,
    productUuid: primary?.id ? String(primary.id) : null,
    offerId: primary?.offer_id ? String(primary.offer_id) : null,
    productName: primary?.name ? String(primary.name) : null,
    customerName: customer?.name ? String(customer.name) : null,
    customerEmail: customer?.email
      ? String(customer.email).toLowerCase().trim()
      : null,
    customerPhone: normalizePhone(customer?.phone_number),
    value: parseBrlToNumber(payload?.total_price),
    currency: 'BRL',
    checkoutUrl: payload?.checkout_url ? String(payload.checkout_url) : null,
    paymentMethod: payload?.payment_method
      ? String(payload.payment_method)
      : null,
    utm:
      payload?.utm && typeof payload.utm === 'object' ? payload.utm : null,
  };
}
