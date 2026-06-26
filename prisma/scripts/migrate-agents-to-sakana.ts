import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const TARGET_MODEL = 'sakana/fugu-ultra-20260615';

function isUnsupportedConversationModel(modelId: string): boolean {
  return !(
    modelId === 'fugu' ||
    modelId.startsWith('fugu-') ||
    modelId.startsWith('sakana/')
  );
}

async function main() {
  const execute = process.argv.includes('--execute');

  const agents = await prisma.aiAgent.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      organizationId: true,
      name: true,
      modelId: true,
      kind: true,
    },
    orderBy: [{ organizationId: 'asc' }, { createdAt: 'asc' }],
  });

  const legacy = agents.filter((a) => isUnsupportedConversationModel(a.modelId));

  console.log(
    JSON.stringify(
      {
        mode: execute ? 'execute' : 'dry-run',
        targetModel: TARGET_MODEL,
        scanned: agents.length,
        unsupportedFound: legacy.length,
      },
      null,
      2,
    ),
  );

  for (const agent of legacy) {
    console.log(
      `${execute ? 'UPDATE' : 'WOULD_UPDATE'} org=${agent.organizationId} agent=${agent.id} kind=${agent.kind} name="${agent.name}" ${agent.modelId} -> ${TARGET_MODEL}`,
    );
  }

  if (!execute || legacy.length === 0) return;

  const result = await prisma.aiAgent.updateMany({
    where: {
      id: { in: legacy.map((a) => a.id) },
    },
    data: { modelId: TARGET_MODEL },
  });

  console.log(`updated=${result.count}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
