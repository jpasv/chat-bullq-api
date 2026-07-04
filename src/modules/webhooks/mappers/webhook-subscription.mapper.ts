export interface PublicSubscription {
  id: string;
  url: string;
  events: string[];
  isActive: boolean;
  description: string | null;
  secret: string;
  consecutiveFailures: number;
  disabledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function maskSecret(secret: string): string {
  return `whsec_…${secret.slice(-4)}`;
}

export function mapSubscription(s: any, revealSecret = false): PublicSubscription {
  return {
    id: s.id,
    url: s.url,
    events: s.events ?? [],
    isActive: s.isActive,
    description: s.description ?? null,
    secret: revealSecret ? s.secret : maskSecret(s.secret),
    consecutiveFailures: s.consecutiveFailures ?? 0,
    disabledAt: s.disabledAt ?? null,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}
