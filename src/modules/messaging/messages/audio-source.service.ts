import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChannelAdapterRegistry } from '../../channel-hub/channel-adapter.registry';
import { MediaResolverService } from './media-resolver.service';
import axios from 'axios';

export interface AudioBytes {
  buffer: Buffer;
  mimeType?: string;
  filename: string;
}

/**
 * Resolves the raw audio bytes of a message, regardless of channel. Shared by
 * transcription (Whisper) and playback (M4A transcode) so both hit the same
 * provider-resolution path exactly once.
 *
 * - Zappfy (WhatsApp): webhook carries a playable URL, or an encrypted .enc URL
 *   the resolver turns into a playable one and caches on content.mediaUrl.
 * - Instagram: webhook already carries a playable CDN URL.
 * - WA Official: mediaId is resolved to a URL via Graph API first.
 */
@Injectable()
export class AudioSourceService {
  constructor(
    private readonly adapterRegistry: ChannelAdapterRegistry,
    private readonly mediaResolver: MediaResolverService,
    private readonly config: ConfigService,
  ) {}

  async resolveBytes(message: {
    id: string;
    content: any;
    conversation: { organizationId: string; channel: any };
  }): Promise<AudioBytes> {
    const channel = message.conversation.channel;
    const content = (message.content ?? {}) as Record<string, any>;
    const mediaId: string | undefined = content.mediaId;
    let mediaUrl: string | undefined = content.mediaUrl;
    let mimeType: string | undefined = content.mimeType;

    if (!mediaUrl && !mediaId) {
      // Resolver hits the provider (Uazapi's /message/download etc.), caches
      // the URL on content.mediaUrl, and returns it. Subsequent calls skip the
      // provider roundtrip.
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
      // Audios sent before APP_URL was configured were stored with a
      // host-less mediaUrl ("/api/v1/uploads/..."). Resolve it against APP_URL
      // so we can still fetch our own upload. Absolute URLs pass through.
      const fetchUrl = this.absolutize(mediaUrl!);
      try {
        buffer = await adapter.downloadMedia(channel, fetchUrl);
      } catch {
        const response = await axios.get(fetchUrl, {
          responseType: 'arraybuffer',
          timeout: 60_000,
        });
        buffer = Buffer.from(response.data);
      }
    }

    return { buffer, mimeType, filename: this.filenameFor(mimeType) };
  }

  private absolutize(url: string): string {
    if (/^https?:\/\//i.test(url)) return url;
    const base = (this.config.get<string>('APP_URL') || '').replace(/\/$/, '');
    return base && url.startsWith('/') ? `${base}${url}` : url;
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
