import {
  Injectable,
  Logger,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { OrgRole } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../database/prisma.service';
import { AudioSourceService } from './audio-source.service';
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
    private readonly audioSource: AudioSourceService,
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

    const audio = await this.audioSource.resolveBytes(message);
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
}
