import {
  Controller,
  Delete,
  Get,
  Post,
  Body,
  Query,
  Param,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags, ApiOperation, ApiQuery, ApiConsumes } from '@nestjs/swagger';
import { MessagesService } from './messages.service';
import { TranscriptionService } from './transcription.service';
import { UploadsService } from './uploads.service';
import { MediaResolverService } from './media-resolver.service';
import { SendMessageDto } from './dto/send-message.dto';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../../common/guards';
import {
  CurrentUser,
  CurrentOrg,
  CurrentChannelAccess,
  CurrentUserRole,
} from '../../../common/decorators';
import type { ChannelAccess } from '../../iam/channel-access/channel-access.service';
import { OrgRole } from '@prisma/client';

@ApiTags('Messages')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('messages')
export class MessagesController {
  constructor(
    private readonly service: MessagesService,
    private readonly transcription: TranscriptionService,
    private readonly uploads: UploadsService,
    private readonly mediaResolver: MediaResolverService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Send a message (enqueues for delivery)' })
  send(
    @Body() dto: SendMessageDto,
    @CurrentUser('id') userId: string,
    @CurrentOrg('id') orgId: string,
    @CurrentChannelAccess() access: ChannelAccess,
  ) {
    return this.service.send(dto, userId, orgId, access);
  }

  @Post('uploads/audio')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: UploadsService.MAX_AUDIO_BYTES },
    }),
  )
  @ApiOperation({ summary: 'Upload an audio file; returns public URL.' })
  @ApiConsumes('multipart/form-data')
  async uploadAudio(
    @UploadedFile()
    file?: { buffer: Buffer; mimetype: string; originalname?: string },
  ) {
    if (!file) throw new BadRequestException('file is required');
    return this.uploads.saveAudio({
      buffer: file.buffer,
      mimetype: file.mimetype,
      originalname: file.originalname,
    });
  }

  @Post('uploads/media')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: UploadsService.MAX_MEDIA_BYTES },
    }),
  )
  @ApiOperation({
    summary:
      'Upload an image/video/document attachment; returns public URL.',
  })
  @ApiConsumes('multipart/form-data')
  async uploadMedia(
    @UploadedFile()
    file?: { buffer: Buffer; mimetype: string; originalname?: string },
  ) {
    if (!file) throw new BadRequestException('file is required');
    return this.uploads.saveMedia({
      buffer: file.buffer,
      mimetype: file.mimetype,
      originalname: file.originalname,
    });
  }

  @Get(':id/media')
  @ApiOperation({
    summary:
      'Resolve a playable media URL for an inbound message. Cached after first call.',
  })
  async getMedia(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @CurrentUserRole() role: OrgRole,
    @CurrentChannelAccess() access: ChannelAccess,
  ) {
    return this.mediaResolver.resolve(id, orgId, access, userId, role);
  }

  @Post(':id/transcribe')
  @ApiOperation({
    summary:
      'Transcribe an audio message via Whisper. Cached in metadata.transcription.',
  })
  transcribe(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @CurrentUserRole() role: OrgRole,
    @CurrentChannelAccess() access: ChannelAccess,
    @Query('force') force?: string,
  ) {
    return this.transcription.transcribe(id, orgId, {
      force: force === 'true' || force === '1',
      access,
      currentUserId: userId,
      role,
    });
  }

  @Delete(':id')
  @ApiOperation({
    summary:
      'Deletar mensagem pra todos. Tenta propagar pro provider — Zappfy suporta (some no app do cliente), Meta WA Cloud e Instagram não suportam (some só no Chat BullQ).',
  })
  revoke(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @CurrentChannelAccess() access: ChannelAccess,
  ) {
    return this.service.revokeForEveryone(id, orgId, userId, access);
  }

  @Get()
  @ApiOperation({ summary: 'List messages of a conversation (paginated)' })
  @ApiQuery({ name: 'conversationId', required: true })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  findByConversation(
    @Query('conversationId') conversationId: string,
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @CurrentUserRole() role: OrgRole,
    @CurrentChannelAccess() access: ChannelAccess,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.findByConversation(
      conversationId,
      orgId,
      parseInt(page || '1', 10),
      parseInt(limit || '50', 10),
      access,
      userId,
      role,
    );
  }
}
