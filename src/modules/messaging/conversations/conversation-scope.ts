import { OrgRole } from '@prisma/client';

/**
 * Decide o escopo de visibilidade por atribuição.
 * - OWNER/ADMIN: acesso amplo → `undefined` (sem barreira de atribuição).
 * - AGENT (ou role ausente → fail-closed): escopado ao próprio userId.
 * Retorna o valor a usar em `enforceAssignedToId`.
 */
export function resolveAssignmentScope(
  role: OrgRole | undefined,
  userId: string,
): string | undefined {
  if (role === OrgRole.OWNER || role === OrgRole.ADMIN) return undefined;
  return userId;
}
