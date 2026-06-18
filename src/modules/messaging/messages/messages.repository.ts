import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';

@Injectable()
export class MessagesRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: Prisma.MessageUncheckedCreateInput) {
    return this.prisma.message.create({ data });
  }

  async findByConversation(
    conversationId: string,
    skip: number,
    take: number,
  ) {
    const [messages, total] = await this.prisma.$transaction([
      this.prisma.message.findMany({
        where: { conversationId },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        include: {
          sender: { select: { id: true, name: true, avatarUrl: true } },
        },
      }),
      this.prisma.message.count({ where: { conversationId } }),
    ]);
    return { messages: messages.reverse(), total };
  }

  /**
   * Timeline UNIFICADA de um grupo de segmento: une as mensagens de várias
   * conversas-irmãs (mesmo grupo em canais diferentes), deduplicando pelo
   * `external_id` (o messageid do WhatsApp é o mesmo nas duas cópias) e
   * ordenando pelo tempo do provedor (fallback created_at).
   *
   * Faz a dedup/ordenação/paginação em SQL (só ids), depois carrega as linhas
   * completas com o include de sender, preservando a ordem.
   */
  async findByConversationsUnioned(
    conversationIds: string[],
    skip: number,
    take: number,
  ) {
    const ids = Prisma.join(conversationIds);

    const [pageRows, countRows] = await this.prisma.$transaction([
      this.prisma.$queryRaw<{ id: string }[]>`
        WITH ranked AS (
          SELECT id,
                 ROW_NUMBER() OVER (
                   PARTITION BY COALESCE(external_id, id)
                   ORDER BY COALESCE(provider_timestamp, created_at) ASC
                 ) AS rn
          FROM messages
          WHERE conversation_id IN (${ids})
        )
        SELECT r.id
        FROM ranked r
        JOIN messages m ON m.id = r.id
        WHERE r.rn = 1
        ORDER BY COALESCE(m.provider_timestamp, m.created_at) DESC
        LIMIT ${take} OFFSET ${skip}
      `,
      this.prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*)::bigint AS count FROM (
          SELECT DISTINCT COALESCE(external_id, id) AS k
          FROM messages
          WHERE conversation_id IN (${ids})
        ) t
      `,
    ]);

    const pageIds = pageRows.map((r) => r.id);
    const total = Number(countRows[0]?.count ?? 0);
    if (pageIds.length === 0) return { messages: [], total };

    const rows = await this.prisma.message.findMany({
      where: { id: { in: pageIds } },
      include: { sender: { select: { id: true, name: true, avatarUrl: true } } },
    });
    // Preserva a ordem do page (desc) e devolve ascendente, igual a findByConversation.
    const byId = new Map(rows.map((m) => [m.id, m]));
    const ordered = pageIds.map((id) => byId.get(id)!).filter(Boolean);
    return { messages: ordered.reverse(), total };
  }

  async findById(id: string) {
    return this.prisma.message.findUnique({ where: { id } });
  }

  async updateStatus(id: string, data: Prisma.MessageUpdateInput) {
    return this.prisma.message.update({ where: { id }, data });
  }
}
