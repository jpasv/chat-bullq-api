import {
  Injectable,
  Logger,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { OrgRole } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../database/prisma.service';
import { ChannelAdapterRegistry } from '../../channel-hub/channel-adapter.registry';
import { MediaResolverService } from './media-resolver.service';
import { resolveAssignmentScope } from '../conversations/conversation-scope';
import axios from 'axios';

export interface TranscriptionResult {
  text: string;
  language?: string;
  durationMs?: number;
  provider: 'openai-whisper';
  transcribedAt: string;
}

/**
 * Transcribes audio messages using OpenAI Whisper.
 *
 * Costs ~$0.006/min — we cache the result in `message.metadata.transcription`
 * so each audio is transcribed at most once. Triggered on-demand from the UI
 * (user clicks "Transcrever") rather than automatically, to keep costs
 * predictable on busy channels.
 */
@Injectable()
export class TranscriptionService {
  private readonly logger = new Logger(TranscriptionService.name);

  private static readonly API_URL =
    'https://api.openai.com/v1/audio/transcriptions';
  private static readonly MODEL = 'whisper-1';
  private static readonly MAX_BYTES = 25 * 1024 * 1024; // 25MB OpenAI cap

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly adapterRegistry: ChannelAdapterRegistry,
    private readonly mediaResolver: MediaResolverService,
  ) {}

  async transcribe(
    messageId: string,
    organizationId: string,
    opts: {
      force?: boolean;
      access?: import('../../iam/channel-access/channel-access.service').ChannelAccess;
      currentUserId?: string;
      role?: OrgRole;
    } = {},
  ): Promise<TranscriptionResult> {
    const access = opts.access ?? 'ALL';
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      include: { conversation: { include: { channel: true } } },
    });
    if (!message) throw new BadRequestException('Message not found');
    if (message.conversation.organizationId !== organizationId) {
      throw new BadRequestException('Message does not belong to organization');
    }
    if (access !== 'ALL' && !access.has(message.conversation.channelId)) {
      throw new BadRequestException('Message does not belong to organization');
    }
    if (
      opts.currentUserId &&
      resolveAssignmentScope(opts.role, opts.currentUserId) &&
      message.conversation.assignedToId !== opts.currentUserId
    ) {
      throw new ForbiddenException();
    }
    if (message.type !== 'AUDIO') {
      throw new BadRequestException('Message is not an audio');
    }

    const metadata = (message.metadata ?? {}) as Record<string, any>;
    if (!opts.force && metadata.transcription?.text) {
      return metadata.transcription as TranscriptionResult;
    }

    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    if (!apiKey) {
      throw new BadRequestException(
        'OPENAI_API_KEY not configured on the server',
      );
    }

    const audio = await this.downloadAudio(message);
    if (audio.buffer.byteLength > TranscriptionService.MAX_BYTES) {
      throw new BadRequestException(
        `Audio too large (${Math.round(audio.buffer.byteLength / 1024 / 1024)}MB > 25MB)`,
      );
    }

    this.logger.log(
      `Transcribing message ${messageId} (${audio.buffer.byteLength} bytes, ${audio.mimeType})`,
    );

    const formData = new FormData();
    const blob = new Blob([audio.buffer as BlobPart], {
      type: audio.mimeType || 'audio/mpeg',
    });
    formData.append('file', blob, audio.filename);
    formData.append('model', TranscriptionService.MODEL);
    formData.append('response_format', 'verbose_json');
    // Portuguese bias by default — Whisper auto-detects, this just nudges.
    formData.append(
      'prompt',
      'Conversa em português do Brasil entre cliente e atendente.',
    );

    let response;
    try {
      response = await axios.post(TranscriptionService.API_URL, formData, {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: 120_000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      });
    } catch (err: any) {
      const detail =
        err?.response?.data?.error?.message || err.message || 'unknown';
      this.logger.error(`Whisper request failed: ${detail}`);
      throw new BadRequestException(`Transcrição falhou: ${detail}`);
    }

    const data = response.data;
    const result: TranscriptionResult = {
      text: String(data?.text || '').trim(),
      language: data?.language,
      durationMs: data?.duration ? Math.round(Number(data.duration) * 1000) : undefined,
      provider: 'openai-whisper',
      transcribedAt: new Date().toISOString(),
    };

    await this.prisma.message.update({
      where: { id: messageId },
      data: {
        metadata: {
          ...metadata,
          transcription: { ...result },
        } as any,
      },
    });

    return result;
  }

  /**
   * Resolves the audio bytes for a message, regardless of channel.
   * - Zappfy (WhatsApp): webhook only carries an encrypted .enc URL; the
   *   resolver hits /message/download to get a playable URL and caches it.
   * - Instagram: webhook already carries a playable CDN URL.
   * - WA Official: mediaId is resolved to a URL via Graph API first.
   */
  private async downloadAudio(message: {
    id: string;
    content: any;
    conversation: { organizationId: string; channel: any };
  }): Promise<{ buffer: Buffer; mimeType?: string; filename: string }> {
    const channel = message.conversation.channel;
    const content = (message.content ?? {}) as Record<string, any>;
    const mediaId: string | undefined = content.mediaId;
    let mediaUrl: string | undefined = content.mediaUrl;
    let mimeType: string | undefined = content.mimeType;

    if (!mediaUrl && !mediaId) {
      // Resolver will hit the provider (Uazapi's /message/download etc.),
      // cache the URL on content.mediaUrl, and return it. Subsequent calls
      // skip the provider roundtrip.
      const resolved = await this.mediaResolver.resolve(
        message.id,
        message.conversation.organizationId,
      );
      mediaUrl = resolved.url;
      mimeType = mimeType || resolved.mimeType;
    }

    const adapter = this.adapterRegistry.getOutbound(channel.type);

    let buffer: Buffer;
    if (mediaId && !mediaUrl) {
      buffer = await adapter.downloadMedia(channel, mediaId);
    } else {
      try {
        buffer = await adapter.downloadMedia(channel, mediaUrl!);
      } catch {
        const response = await axios.get(mediaUrl!, {
          responseType: 'arraybuffer',
          timeout: 60_000,
        });
        buffer = Buffer.from(response.data);
      }
    }

    const filename = this.filenameFor(mimeType);
    return { buffer, mimeType, filename };
  }

  private filenameFor(mimeType?: string): string {
    if (!mimeType) return 'audio.mp3';
    if (mimeType.includes('ogg')) return 'audio.ogg';
    if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return 'audio.mp3';
    if (mimeType.includes('wav')) return 'audio.wav';
    if (mimeType.includes('m4a') || mimeType.includes('mp4')) return 'audio.m4a';
    if (mimeType.includes('webm')) return 'audio.webm';
    return 'audio.mp3';
  }
}
