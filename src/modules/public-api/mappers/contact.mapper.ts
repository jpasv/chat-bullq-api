export interface PublicContact {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  avatarUrl: string | null;
  notes: string | null;
  metadata: unknown;
  channels: { id: string; type: string; name: string; externalId: string; profileName: string | null }[];
  tags: { id: string; name: string; color: string | null }[];
  conversationsCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export function mapContact(c: any): PublicContact {
  return {
    id: c.id,
    name: c.name ?? null,
    phone: c.phone ?? null,
    email: c.email ?? null,
    avatarUrl: c.avatarUrl ?? null,
    notes: c.notes ?? null,
    metadata: c.metadata ?? {},
    channels: (c.channels ?? []).map((cc: any) => ({
      id: cc.channel?.id,
      type: cc.channel?.type,
      name: cc.channel?.name,
      externalId: cc.externalId,
      profileName: cc.profileName ?? null,
    })),
    tags: (c.tags ?? []).map((t: any) => ({ id: t.tag.id, name: t.tag.name, color: t.tag.color ?? null })),
    conversationsCount: c._count?.conversations ?? 0,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}
