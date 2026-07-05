import { Controller, Get, Post, Patch, Delete, Param, Body, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { OrgRole } from '@prisma/client';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../common/guards';
import { CurrentOrg, CurrentUser, Roles } from '../../common/decorators';
import { WebhookSubscriptionsService } from './webhook-subscriptions.service';
import { mapSubscription } from './mappers/webhook-subscription.mapper';
import { mapDelivery } from './mappers/webhook-delivery.mapper';
import { CreateWebhookPublicDto } from './dto/create-webhook.public.dto';
import { UpdateWebhookPublicDto } from './dto/update-webhook.public.dto';

@ApiTags('Webhooks')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Roles(OrgRole.OWNER, OrgRole.ADMIN)
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly service: WebhookSubscriptionsService) {}

  @Get()
  async list(@CurrentOrg('id') orgId: string) {
    const subs = await this.service.findAll(orgId);
    return subs.map((s) => mapSubscription(s));
  }

  @Post()
  @ApiOperation({ summary: 'Cria webhook (retorna secret uma vez)' })
  async create(@CurrentOrg('id') orgId: string, @CurrentUser('id') userId: string, @Body() dto: CreateWebhookPublicDto) {
    return mapSubscription(await this.service.create(orgId, userId, dto), true);
  }

  @Patch(':id')
  async update(@CurrentOrg('id') orgId: string, @Param('id') id: string, @Body() dto: UpdateWebhookPublicDto) {
    return mapSubscription(await this.service.update(id, orgId, dto));
  }

  @Delete(':id')
  async remove(@CurrentOrg('id') orgId: string, @Param('id') id: string) {
    return this.service.remove(id, orgId);
  }

  @Get(':id/deliveries')
  async deliveries(@CurrentOrg('id') orgId: string, @Param('id') id: string, @Query('page') page = 1, @Query('limit') limit = 20) {
    const p = Number(page) || 1;
    const l = Math.min(Number(limit) || 20, 100);
    const { deliveries } = await this.service.listDeliveries(id, orgId, p, l);
    return deliveries.map(mapDelivery);
  }

  @Post(':id/ping')
  async ping(@CurrentOrg('id') orgId: string, @Param('id') id: string) {
    return this.service.ping(id, orgId);
  }
}
