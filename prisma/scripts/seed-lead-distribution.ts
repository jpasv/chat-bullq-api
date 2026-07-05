/**
 * Seed de Distribuição de Leads.
 *
 * Cria (idempotente) na org configurada:
 *   - Tags `Distribuir` e `Coletando informações`.
 *   - Automation "RN-01 · Lead novo → Distribuir" (trigger CONVERSATION_CREATED):
 *       tagueia toda conversa nova com `Distribuir`.
 *   - Automation "RN-04 · Atribuição → Coletando informações" (trigger
 *     CONVERSATION_ASSIGNED, só quando a conversa ainda não tinha assignee):
 *       troca a tag `Distribuir` por `Coletando informações`.
 *   - Inbox view builtin "Distribuição" para cada membro OWNER/ADMIN da org:
 *       lista conversas com tag `Distribuir` ainda não atribuídas.
 *
 * USAGE
 *   LEAD_ORG_ID=... npx ts-node prisma/scripts/seed-lead-distribution.ts
 *
 * Idempotente — rodar de novo não duplica nada (tags reaproveitadas via
 * unique [organizationId, name]; automations resolvidas por nome e
 * atualizadas em vez de duplicadas).
 *
 * Depois de rodar, ajuste manualmente os papéis dos membros da org:
 *   - Renata / gestor(a)  → ADMIN ou OWNER
 *   - Os 8 vendedores     → AGENT
 */
import { PrismaClient, AutomationTrigger, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

const TAG_DISTRIBUIR = { name: 'Distribuir', color: '#F59E0B' };
const TAG_COLETANDO = { name: 'Coletando informações', color: '#3B82F6' };

const AUTOMATION_RN01_NAME = 'RN-01 · Lead novo → Distribuir';
const AUTOMATION_RN04_NAME = 'RN-04 · Atribuição → Coletando informações';

async function ensureTag(
  organizationId: string,
  tag: { name: string; color: string },
): Promise<{ id: string; created: boolean }> {
  const existing = await prisma.tag.findUnique({
    where: { organizationId_name: { organizationId, name: tag.name } },
  });
  if (existing) {
    return { id: existing.id, created: false };
  }
  const created = await prisma.tag.create({
    data: { organizationId, name: tag.name, color: tag.color },
  });
  return { id: created.id, created: true };
}

async function ensureAutomation(params: {
  organizationId: string;
  actorId: string;
  name: string;
  trigger: AutomationTrigger;
  conditions: Prisma.InputJsonValue;
  actions: Prisma.InputJsonValue;
}): Promise<{ id: string; created: boolean }> {
  const { organizationId, actorId, name, trigger, conditions, actions } = params;

  const existing = await prisma.automation.findFirst({
    where: { organizationId, name, deletedAt: null },
  });

  if (existing) {
    await prisma.automation.update({
      where: { id: existing.id },
      data: { trigger, conditions, actions, enabled: true },
    });
    return { id: existing.id, created: false };
  }

  const created = await prisma.automation.create({
    data: {
      organizationId,
      name,
      trigger,
      conditions,
      actions,
      enabled: true,
      actorId,
      schemaVersion: 1,
    },
  });
  return { id: created.id, created: true };
}

async function ensureDistributionView(
  organizationId: string,
  userId: string,
  distribuirTagId: string,
): Promise<void> {
  const existing = await prisma.inboxView.findFirst({
    where: { organizationId, userId, name: 'Distribuição' },
  });

  const filters: Prisma.InputJsonValue = { tagIds: [distribuirTagId], assignedTo: 'none' };
  const metadata: Prisma.InputJsonValue = { builtin: true };

  if (existing) {
    await prisma.inboxView.update({
      where: { id: existing.id },
      data: { filters, metadata, icon: 'Filter', color: 'amber' },
    });
    console.log(`• Inbox view já existe (atualizada): Distribuição p/ ${userId}`);
    return;
  }

  await prisma.inboxView.create({
    data: {
      organizationId,
      userId,
      name: 'Distribuição',
      icon: 'Filter',
      color: 'amber',
      filters,
      metadata,
      order: 0,
    },
  });
  console.log(`✓ Inbox view criada: Distribuição p/ ${userId}`);
}

async function main() {
  const organizationId = process.env.LEAD_ORG_ID;
  if (!organizationId) {
    throw new Error('Defina LEAD_ORG_ID no ambiente.');
  }

  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { id: true, name: true },
  });
  if (!org) throw new Error(`Org ${organizationId} não encontrada.`);
  console.log(`→ Org: ${org.name} (${org.id})`);

  const ownerMembership = await prisma.userOrganization.findFirst({
    where: { organizationId, role: 'OWNER' },
    select: { userId: true },
  });
  if (!ownerMembership) {
    throw new Error(`Nenhum membro OWNER encontrado na org ${organizationId}.`);
  }
  const actorId = ownerMembership.userId;
  console.log(`→ Actor (OWNER): ${actorId}`);

  // ─── Tags ──────────────────────────────────────────────────
  const distribuir = await ensureTag(organizationId, TAG_DISTRIBUIR);
  console.log(
    `${distribuir.created ? '✓ Tag criada' : '• Tag já existe'}: ${TAG_DISTRIBUIR.name} (${distribuir.id})`,
  );

  const coletando = await ensureTag(organizationId, TAG_COLETANDO);
  console.log(
    `${coletando.created ? '✓ Tag criada' : '• Tag já existe'}: ${TAG_COLETANDO.name} (${coletando.id})`,
  );

  // ─── RN-01 · Lead novo → Distribuir ───────────────────────
  const rn01 = await ensureAutomation({
    organizationId,
    actorId,
    name: AUTOMATION_RN01_NAME,
    trigger: 'CONVERSATION_CREATED',
    conditions: {},
    actions: [
      {
        type: 'add_tag',
        params: { tagId: distribuir.id, target: 'conversation' },
      },
    ],
  });
  console.log(
    `${rn01.created ? '✓ Automation criada' : '• Automation atualizada'}: ${AUTOMATION_RN01_NAME} (${rn01.id})`,
  );

  // ─── RN-04 · Atribuição → Coletando informações ───────────
  const rn04 = await ensureAutomation({
    organizationId,
    actorId,
    name: AUTOMATION_RN04_NAME,
    trigger: 'CONVERSATION_ASSIGNED',
    conditions: {
      match: 'AND',
      groups: [
        {
          match: 'AND',
          rules: [{ field: 'fromAssigneeId', op: 'is_not_set' }],
        },
      ],
    },
    actions: [
      {
        type: 'add_tag',
        params: { tagId: coletando.id, target: 'conversation' },
      },
      {
        type: 'remove_tag',
        params: { tagId: distribuir.id, target: 'conversation' },
      },
    ],
  });
  console.log(
    `${rn04.created ? '✓ Automation criada' : '• Automation atualizada'}: ${AUTOMATION_RN04_NAME} (${rn04.id})`,
  );

  // ─── Inbox view "Distribuição" (OWNER/ADMIN) ──────────────
  const admins = await prisma.userOrganization.findMany({
    where: { organizationId, role: { in: ['OWNER', 'ADMIN'] } },
    select: { userId: true },
  });
  for (const admin of admins) {
    await ensureDistributionView(organizationId, admin.userId, distribuir.id);
  }

  console.log('\nPronto. Lembrete manual (papéis dos membros da org):');
  console.log('  - Renata / gestor(a)  → ADMIN ou OWNER');
  console.log('  - Os 8 vendedores     → AGENT');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
