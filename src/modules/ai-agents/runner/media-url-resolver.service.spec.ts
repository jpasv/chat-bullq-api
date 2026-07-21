import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MediaUrlResolverService } from './media-url-resolver.service';

const APP_URL = 'https://api.chat.example.com';

function buildService(uploadsDir: string, resolveInboundMediaUrl?: jest.Mock) {
  const prisma = {
    channel: { findFirst: jest.fn().mockResolvedValue({ id: 'ch_1' }) },
    message: { update: jest.fn().mockResolvedValue({}) },
  };
  const adapterRegistry = {
    getOutbound: jest.fn().mockReturnValue(
      resolveInboundMediaUrl ? { resolveInboundMediaUrl } : {},
    ),
  };
  const config = {
    get: jest.fn((key: string) =>
      key === 'UPLOADS_DIR' ? uploadsDir : key === 'APP_URL' ? APP_URL : undefined,
    ),
  };
  const service = new MediaUrlResolverService(
    prisma as any,
    adapterRegistry as any,
    config as any,
  );
  return { service, prisma, adapterRegistry };
}

const imageMessage = (mediaUrl: string, overrides: Record<string, any> = {}) =>
  ({
    id: 'msg_1',
    conversationId: 'conv_1',
    type: 'IMAGE',
    externalId: 'wamid.1',
    content: { mediaUrl, mimeType: 'image/jpeg', mediaId: 'media_1' },
    ...overrides,
  }) as any;

describe('MediaUrlResolverService.resolveMany', () => {
  let uploadsDir: string;

  beforeEach(() => {
    uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uploads-'));
  });

  afterEach(() => {
    fs.rmSync(uploadsDir, { recursive: true, force: true });
  });

  function writeUpload(relative: string): string {
    const full = path.join(uploadsDir, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, 'jpeg-bytes');
    return `${APP_URL}/api/v1/uploads/${relative}`;
  }

  it('usa o mediaUrl cacheado quando o arquivo ainda existe no disco', async () => {
    const url = writeUpload('inbound/ch_1/2026-07-21/viva.jpg');
    const { service, adapterRegistry } = buildService(uploadsDir);

    const out = await service.resolveMany(
      [imageMessage(url)],
      new Map([['conv_1', 'WHATSAPP_OFFICIAL']]),
    );

    expect(out.get('msg_1')).toEqual({ url, mimeType: 'image/jpeg' });
    expect(adapterRegistry.getOutbound).not.toHaveBeenCalled();
  });

  it('arquivo sumido: re-hospeda via adapter e persiste a URL nova', async () => {
    const dead = `${APP_URL}/api/v1/uploads/inbound/ch_1/2026-06-30/morta.jpg`;
    const resolve = jest.fn().mockResolvedValue({
      fileUrl: `${APP_URL}/api/v1/uploads/inbound/ch_1/2026-07-21/nova.jpg`,
      mimeType: 'image/jpeg',
    });
    const { service, prisma } = buildService(uploadsDir, resolve);

    const out = await service.resolveMany(
      [imageMessage(dead)],
      new Map([['conv_1', 'WHATSAPP_OFFICIAL']]),
    );

    expect(resolve).toHaveBeenCalled();
    expect(out.get('msg_1')?.url).toContain('nova.jpg');
    expect(prisma.message.update).toHaveBeenCalled();
  });

  it('arquivo sumido e adapter também falha: fica fora do map (fallback textual)', async () => {
    const dead = `${APP_URL}/api/v1/uploads/inbound/ch_1/2026-06-30/morta.jpg`;
    const resolve = jest.fn().mockRejectedValue(new Error('media id expirado'));
    const { service } = buildService(uploadsDir, resolve);

    const out = await service.resolveMany(
      [imageMessage(dead)],
      new Map([['conv_1', 'WHATSAPP_OFFICIAL']]),
    );

    // Sem entrada no map o PromptBuilder emite "[imagem enviada — não foi
    // possível carregar]" em vez de mandar URL quebrada pro provider.
    expect(out.has('msg_1')).toBe(false);
  });

  it('URL de terceiro é aceita sem checar disco', async () => {
    const external = 'https://cdn.terceiro.com/foto.jpg';
    const { service, adapterRegistry } = buildService(uploadsDir);

    const out = await service.resolveMany(
      [imageMessage(external)],
      new Map([['conv_1', 'INSTAGRAM']]),
    );

    expect(out.get('msg_1')?.url).toBe(external);
    expect(adapterRegistry.getOutbound).not.toHaveBeenCalled();
  });

  it('não sai do diretório de uploads via path traversal', async () => {
    const traversal = `${APP_URL}/api/v1/uploads/../../etc/passwd`;
    const resolve = jest.fn().mockRejectedValue(new Error('sem media'));
    const { service } = buildService(uploadsDir, resolve);

    const out = await service.resolveMany(
      [imageMessage(traversal)],
      new Map([['conv_1', 'WHATSAPP_OFFICIAL']]),
    );

    // Path fora do rootDir não conta como upload local nosso → passa direto.
    expect(out.get('msg_1')?.url).toBe(traversal);
    expect(resolve).not.toHaveBeenCalled();
  });
});
