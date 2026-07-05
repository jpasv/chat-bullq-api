import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ApiKeyAuthGuard } from '../../../common/guards';
import { CurrentOrg } from '../../../common/decorators';
import { ApiKeyThrottleGuard } from '../guards/api-key-throttle.guard';
import { ChannelsService } from '../../channel-hub/channels/channels.service';
import { mapChannel } from '../mappers/channel.mapper';

@ApiTags('Public API · Channels')
@ApiSecurity('api-key')
@UseGuards(ApiKeyAuthGuard, ApiKeyThrottleGuard)
@Controller('public/channels')
export class PublicChannelsController {
  constructor(private readonly channels: ChannelsService) {}

  @Get()
  @ApiOperation({ summary: 'Lista canais da organização' })
  async list(@CurrentOrg('id') orgId: string) {
    const channels = await this.channels.findAll(orgId, 'ALL');
    return { items: channels.map(mapChannel) };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalha um canal' })
  async get(@CurrentOrg('id') orgId: string, @Param('id') id: string) {
    return mapChannel(await this.channels.findOne(id, orgId, 'ALL'));
  }
}
