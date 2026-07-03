export interface PublicChannel {
  id: string;
  name: string;
  type: string;
  isActive: boolean;
  visibility: string;
  aiEnabled: boolean | null;
  createdAt: Date;
}

// Allowlist: só os campos abaixo saem. `config` (tokens) e `webhookSecret`
// são segredos e nunca são copiados — omissão por construção, não blocklist.
export function mapChannel(ch: any): PublicChannel {
  return {
    id: ch.id,
    name: ch.name,
    type: ch.type,
    isActive: ch.isActive,
    visibility: ch.visibility,
    aiEnabled: ch.aiEnabled ?? null,
    createdAt: ch.createdAt,
  };
}
