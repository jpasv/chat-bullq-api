import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { normalizeSearchText, toPhoneSearch } from '../../../common/search/normalize-search';

@Injectable()
export class ContactsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByOrg(
    organizationId: string,
    search: string | undefined,
    skip: number,
    take: number,
  ) {
    const where: Prisma.ContactWhereInput = { organizationId, deletedAt: null };

    const searchTerm = search?.trim();
    if (searchTerm) {
      // Nome sem acento/maiúscula (search_name), telefone só pelos dígitos.
      const searchName = normalizeSearchText(searchTerm);
      const phone = toPhoneSearch(searchTerm);
      where.OR = [{ email: { contains: searchTerm, mode: 'insensitive' } }];
      if (searchName) where.OR.push({ searchName: { contains: searchName } });
      if (phone) where.OR.push({ phone: { contains: phone } });
    }

    const [contacts, total] = await this.prisma.$transaction([
      this.prisma.contact.findMany({
        where,
        include: {
          channels: { include: { channel: { select: { id: true, type: true, name: true } } } },
          tags: { include: { tag: true } },
          _count: { select: { conversations: true } },
        },
        orderBy: { updatedAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.contact.count({ where }),
    ]);

    return { contacts, total };
  }

  async findById(id: string) {
    return this.prisma.contact.findFirst({
      where: { id, deletedAt: null },
      include: {
        channels: { include: { channel: { select: { id: true, type: true, name: true } } } },
        tags: { include: { tag: true } },
        conversations: {
          orderBy: { createdAt: 'desc' },
          take: 10,
          include: {
            channel: { select: { type: true, name: true } },
            messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { content: true, type: true, createdAt: true } },
          },
        },
      },
    });
  }

  async update(id: string, data: Prisma.ContactUpdateInput) {
    return this.prisma.contact.update({ where: { id }, data });
  }

  async softDelete(id: string) {
    return this.prisma.contact.update({ where: { id }, data: { deletedAt: new Date() } });
  }
}
