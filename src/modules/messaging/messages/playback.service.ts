import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { OrgRole } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { AudioSourceService } from './audio-source.service';
import { UploadsService } from './uploads.service';
import { resolveAssignmentScope } from '../conversations/conversation-scope';
import type { ChannelAccess } from '../../iam/channel-access/channel-access.service';

export interface PlaybackResult {
  url: string;
  mimeType: string;
}

/**
 * Serves a browser-universal (AAC/M4A) playback URL for an audio message.
 *
 * WhatsApp voice notes are OGG/Opus, which Safari/iOS can't decode. The panel
 * calls this on first play to get an M4A rendition that works everywhere. The
 * transcode is cached both on disk (uploads/playback/{id}.m4a) and on
 * `message.metadata.playback`, so each audio is transcoded at most once.
 */
@Injectable()
export class PlaybackService {
  private readonly logger = new Logger(PlaybackService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audioSource: AudioSourceService,
    private readonly uploads: UploadsService,
  ) {}

  async getPlaybackUrl(
    messageId: string,
    organizationId: string,
    access: ChannelAccess = 'ALL',
    currentUserId?: string,
    role?: OrgRole,
  ): Promise<PlaybackResult> {
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      include: { conversation: { include: { channel: true } } },
    });
    if (!message) throw new NotFoundException('Message not found');
    if (message.conversation.organizationId !== organizationId) {
      throw new NotFoundException('Message not found');
    }
    if (access !== 'ALL' && !access.has(message.conversation.channelId)) {
      throw new NotFoundException('Message not found');
    }
    if (
      currentUserId &&
      resolveAssignmentScope(role, currentUserId) &&
      message.conversation.assignedToId !== currentUserId
    ) {
      throw new ForbiddenException();
    }
    if (message.type !== 'AUDIO') {
      throw new BadRequestException('Message is not an audio');
    }

    const metadata = (message.metadata ?? {}) as Record<string, any>;
    if (typeof metadata.playback?.url === 'string' && metadata.playback.url) {
      return { url: metadata.playback.url, mimeType: 'audio/mp4' };
    }

    const audio = await this.audioSource.resolveBytes(message);
    const result = await this.uploads.transcodeToPlayback(message.id, {
      buffer: audio.buffer,
      mimeType: audio.mimeType,
    });

    await this.prisma.message.update({
      where: { id: messageId },
      data: {
        metadata: {
          ...metadata,
          playback: { url: result.url, mimeType: result.mimeType },
        } as any,
      },
    });

    return { url: result.url, mimeType: result.mimeType };
  }
}
