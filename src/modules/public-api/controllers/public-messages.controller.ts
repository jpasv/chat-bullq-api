import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ApiKeyAuthGuard } from '../../../common/guards';
import { CurrentOrg, CurrentUser } from '../../../common/decorators';
import { ApiKeyThrottleGuard } from '../guards/api-key-throttle.guard';
import { MessagesService } from '../../messaging/messages/messages.service';
import { mapMessage } from '../mappers/message.mapper';
import { SendMessagePublicDto } from '../dto/send-message.public.dto';

@ApiTags('Public API · Messages')
@ApiSecurity('api-key')
@UseGuards(ApiKeyAuthGuard, ApiKeyThrottleGuard)
@Controller('public/messages')
export class PublicMessagesController {
  constructor(private readonly messages: MessagesService) {}

  @Post()
  @ApiOperation({ summary: 'Envia uma mensagem numa conversa existente' })
  async send(
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: SendMessagePublicDto,
  ) {
    const sent = await this.messages.send(dto as any, userId, orgId, 'ALL');
    return mapMessage(sent);
  }
}
