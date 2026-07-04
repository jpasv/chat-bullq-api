import { Controller, Get, Post, Patch, Delete, Param, Body, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ApiKeyAuthGuard } from '../../common/guards';
import { CurrentOrg, CurrentUser } from '../../common/decorators';
import { ApiKeyThrottleGuard } from '../public-api/guards/api-key-throttle.guard';
import { toPublicPage } from '../public-api/dto/public-page';
import { WebhookSubscriptionsService } from './webhook-subscriptions.service';
import { mapSubscription } from './mappers/webhook-subscription.mapper';
import { mapDelivery } from './mappers/webhook-delivery.mapper';
import { CreateWebhookPublicDto } from './dto/create-webhook.public.dto';
import { UpdateWebhookPublicDto } from './dto/update-webhook.public.dto';

@ApiTags('Public API · Webhooks')
@ApiSecurity('api-key')
@UseGuards(ApiKeyAuthGuard, ApiKeyThrottleGuard)
@Controller('public/webhooks')
export class PublicWebhooksController {
  constructor(private readonly service: WebhookSubscriptionsService) {}

  @Get()
  @ApiOperation({ summary: 'Lista webhooks da organização' })
  async list(@CurrentOrg('id') orgId: string) {
    const subs = await this.service.findAll(orgId);
    return { items: subs.map((s) => mapSubscription(s)) };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalha um webhook' })
  async get(@CurrentOrg('id') orgId: string, @Param('id') id: string) {
    return mapSubscription(await this.service.findOne(id, orgId));
  }

  @Post()
  @ApiOperation({ summary: 'Cria um webhook (retorna o secret uma única vez)' })
  async create(@CurrentOrg('id') orgId: string, @CurrentUser('id') userId: string, @Body() dto: CreateWebhookPublicDto) {
    const sub = await this.service.create(orgId, userId, dto);
    return mapSubscription(sub, true);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Atualiza um webhook' })
  async update(@CurrentOrg('id') orgId: string, @Param('id') id: string, @Body() dto: UpdateWebhookPublicDto) {
    return mapSubscription(await this.service.update(id, orgId, dto));
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Remove um webhook' })
  async remove(@CurrentOrg('id') orgId: string, @Param('id') id: string) {
    return this.service.remove(id, orgId);
  }

  @Get(':id/deliveries')
  @ApiOperation({ summary: 'Log de entregas do webhook (paginado)' })
  async deliveries(@CurrentOrg('id') orgId: string, @Param('id') id: string, @Query('page') page = 1, @Query('limit') limit = 20) {
    const p = Number(page) || 1;
    const l = Math.min(Number(limit) || 20, 100);
    const { deliveries, total } = await this.service.listDeliveries(id, orgId, p, l);
    return toPublicPage(deliveries.map(mapDelivery), total, p, l);
  }

  @Post(':id/ping')
  @ApiOperation({ summary: 'Envia um evento de teste (PING)' })
  async ping(@CurrentOrg('id') orgId: string, @Param('id') id: string) {
    return this.service.ping(id, orgId);
  }
}
