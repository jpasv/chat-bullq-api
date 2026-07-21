import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

const execFileAsync = promisify(execFile);

export interface UploadResult {
  url: string;
  mimeType: string;
  size: number;
  filename: string;
}

/**
 * Stores user-uploaded media (agent recordings) and inbound media we
 * mirror locally (e.g., WhatsApp Cloud requires a Bearer token to
 * download — browsers can't load it directly, so we re-host it here).
 *
 * Files are written under `uploads/` and served publicly through
 * `/api/v1/uploads/*`. Swap with S3/R2 when we go multi-instance — the
 * public URL contract stays the same.
 */
@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);

  // 25MB matches OpenAI Whisper's upload cap, so audios we accept are also
  // transcribable without chunking.
  static readonly MAX_AUDIO_BYTES = 25 * 1024 * 1024;

  // 64MB upper bound for any inbound media we mirror. WhatsApp Cloud caps
  // documents at 100MB but most chat content is well under this — bigger
  // files we'd want to stream rather than buffer in memory anyway.
  static readonly MAX_INBOUND_BYTES = 64 * 1024 * 1024;

  private static readonly ALLOWED_AUDIO_MIME = new Set([
    'audio/mpeg',
    'audio/mp4',
    'audio/m4a',
    'audio/ogg',
    'audio/wav',
    'audio/webm',
    'audio/webm;codecs=opus',
  ]);

  // 64MB: acima do cap de vídeo do WhatsApp (16MB) e de imagem (5MB) — o
  // provider rejeita o que não aceitar; aqui só barramos abusos óbvios.
  static readonly MAX_MEDIA_BYTES = 64 * 1024 * 1024;

  private static readonly ALLOWED_MEDIA_MIME = new Set([
    // image
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/heic',
    // video
    'video/mp4',
    'video/quicktime',
    'video/3gpp',
    'video/webm',
    // document
    'application/pdf',
    'application/zip',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain',
    'text/csv',
  ]);

  private readonly rootDir: string;
  private readonly publicBaseUrl: string;

  constructor(private readonly config: ConfigService) {
    this.rootDir = path.resolve(
      this.config.get<string>('UPLOADS_DIR') ||
        path.join(process.cwd(), 'uploads'),
    );
    const appUrl = this.config.get<string>('APP_URL') || '';
    this.publicBaseUrl = `${appUrl.replace(/\/$/, '')}/api/v1/uploads`;
    if (!fs.existsSync(this.rootDir)) {
      fs.mkdirSync(this.rootDir, { recursive: true });
    }
  }

  /**
   * Persists an inbound media buffer (any type — image, video, audio,
   * document, sticker) under a per-channel/per-day folder and returns a
   * playable public URL. Used by adapters whose providers deliver media
   * gated behind auth (WhatsApp Cloud) or via short-lived signed URLs we
   * don't want to depend on.
   *
   * `originalFilename` is preserved when the provider gives one (typical
   * for documents) — useful for the UI to render a familiar filename and
   * for the browser's "Save As" dialog to default sensibly.
   */
  /**
   * Foto de perfil (contato, grupo ou participante). Nome de arquivo
   * determinístico pela `key` (id do contato), por dois motivos: a URL
   * gravada em `contacts.avatar_url` continua válida depois de um redeploy,
   * e o refresh sobrescreve em vez de acumular arquivo órfão.
   *
   * O diretório de uploads não é volume persistente, então o arquivo pode
   * sumir num deploy — quem chama trata isso revalidando (`avatarFileExists`).
   */
  async saveAvatar(input: {
    key: string;
    buffer: Buffer;
    mimeType: string;
  }): Promise<string> {
    if (!input?.buffer?.byteLength) {
      throw new BadRequestException('Empty avatar');
    }
    const mime = (input.mimeType || 'image/jpeg').split(';')[0].trim();
    if (!mime.startsWith('image/')) {
      throw new BadRequestException(`Avatar must be an image, got ${mime}`);
    }
    const dir = path.join(this.rootDir, 'avatars');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const safeKey = input.key.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = `${safeKey}${this.extFor(mime, null)}`;
    await fs.promises.writeFile(path.join(dir, filename), input.buffer);
    return `${this.publicBaseUrl}/avatars/${filename}`;
  }

  /**
   * Idade em dias do arquivo por trás de uma URL de avatar, ou `null` se ele
   * não existe (nunca baixado, ou perdido num redeploy). Serve de "quando
   * sincronizamos pela última vez" sem precisar de coluna nova no banco.
   */
  avatarAgeInDays(avatarUrl: string | null | undefined): number | null {
    if (!avatarUrl) return null;
    const marker = `${this.publicBaseUrl}/avatars/`;
    if (!avatarUrl.startsWith(marker)) return null;
    const filename = avatarUrl.slice(marker.length).split('?')[0];
    if (!filename || filename.includes('/')) return null;
    try {
      const { mtimeMs } = fs.statSync(path.join(this.rootDir, 'avatars', filename));
      return (Date.now() - mtimeMs) / 86_400_000;
    } catch {
      return null;
    }
  }

  async saveInboundMedia(input: {
    buffer: Buffer;
    mimeType: string;
    channelId: string;
    originalFilename?: string | null;
  }): Promise<UploadResult> {
    if (!input?.buffer?.byteLength) {
      throw new BadRequestException('Empty inbound media');
    }
    if (input.buffer.byteLength > UploadsService.MAX_INBOUND_BYTES) {
      throw new BadRequestException(
        `Inbound media too large (max ${UploadsService.MAX_INBOUND_BYTES / 1024 / 1024}MB)`,
      );
    }

    const mime = (input.mimeType || 'application/octet-stream').split(';')[0].trim();
    const dateFolder = new Date().toISOString().slice(0, 10);
    const safeChannel = (input.channelId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
    const dir = path.join(this.rootDir, 'inbound', safeChannel, dateFolder);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const id = crypto.randomBytes(16).toString('hex');
    const ext = this.extFor(mime, input.originalFilename);
    const filename = `${id}${ext}`;
    const fullPath = path.join(dir, filename);
    await fs.promises.writeFile(fullPath, input.buffer);

    const url = `${this.publicBaseUrl}/inbound/${safeChannel}/${dateFolder}/${filename}`;
    this.logger.log(`Inbound media saved: ${fullPath} -> ${url}`);
    return {
      url,
      mimeType: mime,
      size: input.buffer.byteLength,
      filename: input.originalFilename || filename,
    };
  }

  /**
   * Upload de mídia do operador (anexo do chat): imagem, vídeo ou documento.
   * Áudio gravado no app continua indo pelo saveAudio (que transcoda pra
   * OGG/Opus voice note); aqui é o caminho do clipe de papel.
   */
  async saveMedia(file: {
    buffer: Buffer;
    mimetype: string;
    originalname?: string;
  }): Promise<UploadResult> {
    if (!file?.buffer?.byteLength) {
      throw new BadRequestException('Empty upload');
    }
    if (file.buffer.byteLength > UploadsService.MAX_MEDIA_BYTES) {
      throw new BadRequestException(
        `File too large (max ${UploadsService.MAX_MEDIA_BYTES / 1024 / 1024}MB)`,
      );
    }
    const mime = (file.mimetype || 'application/octet-stream')
      .split(';')[0]
      .trim();
    if (!UploadsService.ALLOWED_MEDIA_MIME.has(mime)) {
      throw new BadRequestException(`Unsupported file type: ${mime}`);
    }

    const dateFolder = new Date().toISOString().slice(0, 10);
    const dir = path.join(this.rootDir, 'media', dateFolder);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const id = crypto.randomBytes(16).toString('hex');
    const ext = this.extFor(mime, file.originalname);
    const filename = `${id}${ext}`;
    const fullPath = path.join(dir, filename);
    await fs.promises.writeFile(fullPath, file.buffer);

    const url = `${this.publicBaseUrl}/media/${dateFolder}/${filename}`;
    this.logger.log(`Media saved: ${fullPath} -> ${url}`);
    return {
      url,
      mimeType: mime,
      size: file.buffer.byteLength,
      filename: file.originalname || filename,
    };
  }

  async saveAudio(file: {
    buffer: Buffer;
    mimetype: string;
    originalname?: string;
  }): Promise<UploadResult> {
    if (!file?.buffer?.byteLength) {
      throw new BadRequestException('Empty upload');
    }
    if (file.buffer.byteLength > UploadsService.MAX_AUDIO_BYTES) {
      throw new BadRequestException(
        `Audio too large (max ${UploadsService.MAX_AUDIO_BYTES / 1024 / 1024}MB)`,
      );
    }
    // Normalise mimetype: browsers sometimes send `audio/webm;codecs=opus`.
    const mime = (file.mimetype || '').split(';')[0].trim() || 'audio/webm';
    if (!UploadsService.ALLOWED_AUDIO_MIME.has(file.mimetype) && !UploadsService.ALLOWED_AUDIO_MIME.has(mime)) {
      throw new BadRequestException(`Unsupported audio mime type: ${file.mimetype}`);
    }

    const dateFolder = new Date().toISOString().slice(0, 10);
    const dir = path.join(this.rootDir, 'audio', dateFolder);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const id = crypto.randomBytes(16).toString('hex');
    const srcExt = this.extFor(mime);
    const srcPath = path.join(dir, `${id}${srcExt}`);
    await fs.promises.writeFile(srcPath, file.buffer);

    // WhatsApp voice notes require OGG/Opus. Browsers (esp. Chrome/Firefox)
    // record in WebM/Opus via MediaRecorder — the codec is compatible but
    // the container is not, so Zappfy rejects the send (HTTP 500). We also
    // rely on the re-encode to write proper duration headers (MediaRecorder
    // streams webm without duration, so the <audio> element shows 0:00).
    let finalPath = srcPath;
    let finalMime = mime;
    if (mime !== 'audio/ogg') {
      const oggPath = path.join(dir, `${id}.ogg`);
      try {
        await execFileAsync(
          'ffmpeg',
          [
            '-hide_banner',
            '-loglevel', 'error',
            '-y',
            '-i', srcPath,
            '-vn',
            '-c:a', 'libopus',
            '-b:a', '32k',
            '-ac', '1',
            '-ar', '48000',
            '-application', 'voip',
            oggPath,
          ],
          { timeout: 30_000 },
        );
        await fs.promises.unlink(srcPath).catch(() => undefined);
        finalPath = oggPath;
        finalMime = 'audio/ogg';
      } catch (err: any) {
        this.logger.error(`ffmpeg transcode failed: ${err.message}`);
        throw new BadRequestException('Failed to process audio');
      }
    }

    const finalSize = (await fs.promises.stat(finalPath)).size;
    const finalName = path.basename(finalPath);
    const url = `${this.publicBaseUrl}/audio/${dateFolder}/${finalName}`;
    this.logger.log(`Audio saved: ${finalPath} -> ${url}`);
    return { url, mimeType: finalMime, size: finalSize, filename: finalName };
  }

  private extFor(mime: string, originalFilename?: string | null): string {
    // Prefer the extension from the provider-given filename when present —
    // it survives mime-sniffing oddities (e.g., Meta sometimes returns
    // application/octet-stream for known doc types).
    if (originalFilename) {
      const ext = path.extname(originalFilename).toLowerCase();
      if (ext && /^\.[a-z0-9]{1,8}$/i.test(ext)) return ext;
    }
    const m = (mime || '').toLowerCase();
    // audio
    if (m.includes('ogg')) return '.ogg';
    if (m.includes('mpeg') && m.startsWith('audio/')) return '.mp3';
    if (m.includes('m4a') || (m.includes('mp4') && m.startsWith('audio/'))) return '.m4a';
    if (m.includes('wav')) return '.wav';
    if (m.includes('webm') && m.startsWith('audio/')) return '.webm';
    // image
    if (m === 'image/jpeg' || m === 'image/jpg') return '.jpg';
    if (m === 'image/png') return '.png';
    if (m === 'image/gif') return '.gif';
    if (m === 'image/webp') return '.webp';
    if (m === 'image/heic') return '.heic';
    // video
    if (m === 'video/mp4') return '.mp4';
    if (m === 'video/quicktime') return '.mov';
    if (m === 'video/3gpp') return '.3gp';
    if (m === 'video/webm') return '.webm';
    // document
    if (m === 'application/pdf') return '.pdf';
    if (m === 'application/zip') return '.zip';
    if (m === 'application/msword') return '.doc';
    if (m === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return '.docx';
    if (m === 'application/vnd.ms-excel') return '.xls';
    if (m === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return '.xlsx';
    if (m === 'application/vnd.ms-powerpoint') return '.ppt';
    if (m === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') return '.pptx';
    if (m === 'text/plain') return '.txt';
    if (m === 'text/csv') return '.csv';
    return '.bin';
  }
}
