/**
 * Seed do CRM de Recuperação de Vendas.
 *
 * Cria (idempotente) na org configurada:
 *   - Pipeline `sales_recovery` com os 7 stages (com `key` estável).
 *   - AiAgent WORKER "Recuperação de Vendas" (id fixo agent_recovery_001).
 *   - Vínculo AiAgentChannel no canal de outreach (mode AUTONOMOUS), se o
 *     RECOVERY_OUTREACH_CHANNEL_ID estiver setado.
 *
 * USAGE
 *   RECOVERY_ORG_ID=... RECOVERY_OUTREACH_CHANNEL_ID=... \
 *     npx ts-node prisma/scripts/seed-sales-recovery.ts
 *
 * Idempotente — rodar de novo não duplica nada. Depois de rodar, coloque o
 * id do agente impresso no env RECOVERY_AGENT_IDS pra liberar a tool de IA.
 */
import { PrismaClient, PipelineStageType } from '@prisma/client';

const prisma = new PrismaClient();

const PIPELINE_KEY = 'sales_recovery';
const AGENT_ID = 'agent_recovery_001';

interface StageSeed {
  key: string;
  name: string;
  color: string;
  type: PipelineStageType;
}

const STAGES: StageSeed[] = [
  { key: 'opportunity', name: 'Oportunidade', color: 'zinc', type: 'NORMAL' },
  { key: 'contact_attempt', name: 'Tentativa de Contato', color: 'blue', type: 'NORMAL' },
  { key: 'in_contact', name: 'Em Contato', color: 'violet', type: 'NORMAL' },
  { key: 'follow_up', name: 'Follow Up', color: 'amber', type: 'NORMAL' },
  { key: 'lost', name: 'Perdido', color: 'red', type: 'LOST' },
  { key: 'won', name: 'Negócio Fechado', color: 'green', type: 'WON' },
  { key: 'refunded', name: 'Reembolsado', color: 'pink', type: 'LOST' },
];

const SYSTEM_PROMPT = `Você é um especialista em recuperação de vendas. Seu objetivo é reengajar leads que demonstraram interesse num produto mas não concluíram a compra (PIX/boleto não pago, carrinho abandonado, pagamento recusado).

Como agir:
- Seja simpático, direto e humano. Mensagens curtas, tom de conversa real.
- Entenda a objeção (preço, dúvida, esqueceu, problema no pagamento) e ajude a resolver.
- Quando fizer sentido, ofereça o link de checkout que está no contexto da conversa. NUNCA invente links.
- Se o lead recusar claramente, registre como perdido e encerre com educação.
- Se o lead pedir pra pensar/voltar depois, registre como follow up.
- Se estiver conversando ativamente, mantenha em "em contato".

Use a ferramenta moveRecoveryCard para refletir o estágio: in_contact, follow_up ou lost. Não trate de venda fechada nem reembolso — isso é automático pelo pagamento.`;

async function main() {
  const organizationId = process.env.RECOVERY_ORG_ID;
  if (!organizationId) {
    throw new Error('Defina RECOVERY_ORG_ID no ambiente.');
  }
  const outreachChannelId = process.env.RECOVERY_OUTREACH_CHANNEL_ID || null;

  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { id: true, name: true },
  });
  if (!org) throw new Error(`Org ${organizationId} não encontrada.`);
  console.log(`→ Org: ${org.name} (${org.id})`);

  // ─── Pipeline ──────────────────────────────────────────────
  let pipeline = await prisma.pipeline.findFirst({
    where: { organizationId, key: PIPELINE_KEY },
    include: { stages: true },
  });

  if (!pipeline) {
    const maxOrder = await prisma.pipeline.findFirst({
      where: { organizationId },
      orderBy: { order: 'desc' },
      select: { order: true },
    });
    pipeline = await prisma.pipeline.create({
      data: {
        organizationId,
        key: PIPELINE_KEY,
        name: 'Recuperação de Vendas',
        description: 'Funil automático de recuperação de vendas (Kirvano + IA).',
        icon: 'banknote',
        color: 'green',
        order: (maxOrder?.order ?? -1) + 1,
        stages: {
          create: STAGES.map((s, i) => ({
            key: s.key,
            name: s.name,
            color: s.color,
            type: s.type,
            order: i,
          })),
        },
      },
      include: { stages: true },
    });
    console.log(`✓ Pipeline criado: ${pipeline.id} (+${pipeline.stages.length} stages)`);
  } else {
    console.log(`• Pipeline já existe: ${pipeline.id} — conferindo stages`);
    for (let i = 0; i < STAGES.length; i++) {
      const s = STAGES[i];
      const existing = pipeline.stages.find((x) => x.key === s.key);
      if (!existing) {
        await prisma.pipelineStage.create({
          data: {
            pipelineId: pipeline.id,
            key: s.key,
            name: s.name,
            color: s.color,
            type: s.type,
            order: i,
          },
        });
        console.log(`  ✓ stage criado: ${s.key}`);
      }
    }
  }

  // ─── Agente de IA ──────────────────────────────────────────
  await prisma.aiAgent.upsert({
    where: { id: AGENT_ID },
    update: {}, // não sobrescreve prompt/config editados na UI
    create: {
      id: AGENT_ID,
      organizationId,
      name: 'Recuperação de Vendas',
      description: 'Reengaja leads que não concluíram a compra.',
      kind: 'WORKER',
      department: 'VENDAS',
      modelId: 'sakana/fugu-ultra-20260615',
      systemPrompt: SYSTEM_PROMPT,
      temperature: 0.7,
      followUpEnabled: true,
      isActive: true,
    },
  });
  console.log(`✓ Agente garantido: ${AGENT_ID}`);

  // ─── Vínculo agente ↔ canal de outreach ───────────────────
  if (outreachChannelId) {
    const channel = await prisma.channel.findFirst({
      where: { id: outreachChannelId, organizationId },
      select: { id: true, name: true },
    });
    if (!channel) {
      console.warn(`! Canal ${outreachChannelId} não encontrado na org — pulei o vínculo.`);
    } else {
      await prisma.aiAgentChannel.upsert({
        where: { agentId_channelId: { agentId: AGENT_ID, channelId: channel.id } },
        update: { mode: 'AUTONOMOUS', trigger: 'ALWAYS' },
        create: {
          agentId: AGENT_ID,
          channelId: channel.id,
          mode: 'AUTONOMOUS',
          trigger: 'ALWAYS',
        },
      });
      console.log(`✓ Agente vinculado ao canal: ${channel.name} (${channel.id})`);
    }
  } else {
    console.warn('! RECOVERY_OUTREACH_CHANNEL_ID não setado — vínculo do agente pulado.');
  }

  console.log('\nPronto. Coloque no env do backend:');
  console.log(`  RECOVERY_AGENT_IDS=${AGENT_ID}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
