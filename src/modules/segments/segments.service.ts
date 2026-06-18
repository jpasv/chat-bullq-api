import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { SegmentLookupService } from './segment-lookup.service';
import {
  CreateSegmentDto,
  SetSegmentChannelsDto,
  SetPrimaryChannelDto,
  UpdateSegmentDto,
} from './dto/segment.dto';

/**
 * CRUD de Segmentos — grupos de WhatsApp compartilhados entre vários canais
 * (números). A lógica de roteamento em runtime vive no
 * {@link SegmentLookupService}; aqui só gerenciamos a configuração. Toda
 * mutação invalida o cache do lookup.
 */
@Injectable()
export class SegmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lookup: SegmentLookupService,
  ) {}

  async create(organizationId: string, dto: CreateSegmentDto) {
    const channelIds = await this.assertChannelsInOrg(
      organizationId,
      dto.channelIds,
    );
    const primaryChannelId = this.resolvePrimary(
      channelIds,
      dto.primaryChannelId,
    );

    const segment = await this.prisma.segment.create({
      data: {
        organizationId,
        name: dto.name,
        primaryChannelId,
        members: {
          create: channelIds.map((channelId) => ({ channelId })),
        },
      },
      include: this.includeMembers(),
    });

    this.lookup.invalidate();
    return segment;
  }

  findAll(organizationId: string) {
    return this.prisma.segment.findMany({
      where: { organizationId, deletedAt: null },
      include: this.includeMembers(),
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string, organizationId: string) {
    const segment = await this.prisma.segment.findFirst({
      where: { id, organizationId, deletedAt: null },
      include: this.includeMembers(),
    });
    if (!segment) throw new NotFoundException('Segmento não encontrado');
    return segment;
  }

  async update(id: string, organizationId: string, dto: UpdateSegmentDto) {
    await this.findOne(id, organizationId);
    const segment = await this.prisma.segment.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
      include: this.includeMembers(),
    });
    this.lookup.invalidate();
    return segment;
  }

  /** Substitui o conjunto de canais membros (diff aditivo + remoção). */
  async setChannels(
    id: string,
    organizationId: string,
    dto: SetSegmentChannelsDto,
  ) {
    const current = await this.findOne(id, organizationId);
    const channelIds = await this.assertChannelsInOrg(
      organizationId,
      dto.channelIds,
    );

    // Se o canal principal saiu da lista, reaponta para o primeiro restante.
    const primaryChannelId =
      current.primaryChannelId && channelIds.includes(current.primaryChannelId)
        ? current.primaryChannelId
        : (channelIds[0] ?? null);

    await this.prisma.$transaction([
      this.prisma.segmentChannel.deleteMany({ where: { segmentId: id } }),
      this.prisma.segmentChannel.createMany({
        data: channelIds.map((channelId) => ({ segmentId: id, channelId })),
        skipDuplicates: true,
      }),
      this.prisma.segment.update({
        where: { id },
        data: { primaryChannelId },
      }),
    ]);

    this.lookup.invalidate();
    return this.findOne(id, organizationId);
  }

  async setPrimary(
    id: string,
    organizationId: string,
    dto: SetPrimaryChannelDto,
  ) {
    const segment = await this.findOne(id, organizationId);
    const isMember = segment.members.some(
      (m) => m.channelId === dto.primaryChannelId,
    );
    if (!isMember) {
      throw new BadRequestException(
        'O canal principal precisa ser um membro do segmento',
      );
    }
    await this.prisma.segment.update({
      where: { id },
      data: { primaryChannelId: dto.primaryChannelId },
    });
    this.lookup.invalidate();
    return this.findOne(id, organizationId);
  }

  async remove(id: string, organizationId: string) {
    await this.findOne(id, organizationId);
    await this.prisma.segment.update({
      where: { id },
      data: { isActive: false, deletedAt: new Date() },
    });
    this.lookup.invalidate();
    return { id, deleted: true };
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private includeMembers() {
    return {
      members: {
        include: {
          channel: { select: { id: true, name: true, type: true } },
        },
      },
      primaryChannel: { select: { id: true, name: true, type: true } },
    } as const;
  }

  /**
   * Valida que todos os canais existem, pertencem à org e não estão
   * deletados. Retorna a lista deduplicada (preserva ordem) para uso.
   */
  private async assertChannelsInOrg(
    organizationId: string,
    channelIds: string[],
  ): Promise<string[]> {
    const unique = Array.from(new Set(channelIds));
    if (unique.length === 0) {
      throw new BadRequestException('Informe ao menos um canal');
    }
    const found = await this.prisma.channel.findMany({
      where: { id: { in: unique }, organizationId, deletedAt: null },
      select: { id: true },
    });
    if (found.length !== unique.length) {
      const foundIds = new Set(found.map((c) => c.id));
      const missing = unique.filter((id) => !foundIds.has(id));
      throw new BadRequestException(
        `Canais inválidos para esta organização: ${missing.join(', ')}`,
      );
    }
    return unique;
  }

  private resolvePrimary(
    channelIds: string[],
    requested?: string,
  ): string {
    if (requested) {
      if (!channelIds.includes(requested)) {
        throw new BadRequestException(
          'O canal principal precisa estar entre os canais membros',
        );
      }
      return requested;
    }
    return channelIds[0];
  }
}
