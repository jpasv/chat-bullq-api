export interface PublicDelivery {
  id: string;
  type: string;
  status: string;
  attemptCount: number;
  responseStatus: number | null;
  lastError: string | null;
  createdAt: Date;
  deliveredAt: Date | null;
}

export function mapDelivery(d: any): PublicDelivery {
  return {
    id: d.id,
    type: d.type,
    status: d.status,
    attemptCount: d.attemptCount ?? 0,
    responseStatus: d.responseStatus ?? null,
    lastError: d.lastError ?? null,
    createdAt: d.createdAt,
    deliveredAt: d.deliveredAt ?? null,
  };
}
