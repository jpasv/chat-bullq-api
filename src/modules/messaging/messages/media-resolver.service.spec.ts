import { GoneException, ServiceUnavailableException } from '@nestjs/common';
import axios from 'axios';
import { MediaResolverService } from './media-resolver.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const ORG = 'org_1';
const UAZAPI_URL = 'https://zappfy-v2.uazapi.com/files/abc123';
const LOCAL_URL = 'https://api.chat.bravy.com.br/api/v1/uploads/inbound/ch_1/2026-11-22/x.ogg';

function makeMessage(content: Record<string, any>, externalId: string | null = 'EXT1') {
  return {
    id: 'msg_1',
    externalId,
    content,
    conversation: {
      organizationId: ORG,
      channelId: 'ch_1',
      channel: { id: 'ch_1', type: 'WHATSAPP_ZAPPFY' },
    },
  };
}

function setup(message: ReturnType<typeof makeMessage>) {
  const prisma = {
    message: {
      findUnique: jest.fn().mockResolvedValue(message),
      update: jest.fn().mockResolvedValue(undefined),
    },
  };
  const adapter = { resolveInboundMediaUrl: jest.fn() };
  const registry = { getOutbound: jest.fn().mockReturnValue(adapter) };
  const uploads = {
    isMissingLocalUpload: jest.fn().mockReturnValue(false),
    saveInboundMedia: jest
      .fn()
      .mockResolvedValue({ url: LOCAL_URL, mimeType: 'audio/ogg', size: 3, filename: 'x.ogg' }),
  };
  const service = new MediaResolverService(prisma as any, registry as any, uploads as any);
  return { service, prisma, adapter, uploads };
}

describe('MediaResolverService', () => {
  beforeEach(() => jest.resetAllMocks());

  it('devolve a URL guardada quando ela é permanente, sem chamar o provider', async () => {
    const { service, adapter } = setup(makeMessage({ mediaUrl: LOCAL_URL, mimeType: 'audio/ogg' }));

    await expect(service.resolve('msg_1', ORG)).resolves.toEqual({
      url: LOCAL_URL,
      mimeType: 'audio/ogg',
    });
    expect(adapter.resolveInboundMediaUrl).not.toHaveBeenCalled();
  });

  it('copia pro disco o link da Uazapi ainda vivo e grava a URL local', async () => {
    const { service, prisma, adapter, uploads } = setup(
      makeMessage({ mediaUrl: UAZAPI_URL, mimeType: 'audio/ogg' }),
    );
    mockedAxios.get.mockResolvedValue({
      data: Buffer.from('abc'),
      headers: { 'content-type': 'audio/ogg' },
    });

    const result = await service.resolve('msg_1', ORG);

    expect(result.url).toBe(LOCAL_URL);
    expect(uploads.saveInboundMedia).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: 'ch_1', mimeType: 'audio/ogg' }),
    );
    expect(adapter.resolveInboundMediaUrl).not.toHaveBeenCalled();
    expect(prisma.message.update).toHaveBeenCalledWith({
      where: { id: 'msg_1' },
      data: { content: expect.objectContaining({ mediaUrl: LOCAL_URL }) },
    });
  });

  it('link da Uazapi morto: pede de novo ao provider e grava o que ele devolver', async () => {
    const { service, prisma, adapter } = setup(makeMessage({ mediaUrl: UAZAPI_URL }));
    mockedAxios.get.mockRejectedValue({ response: { status: 404 } });
    adapter.resolveInboundMediaUrl.mockResolvedValue({ fileUrl: LOCAL_URL, mimeType: 'image/jpeg' });

    const result = await service.resolve('msg_1', ORG);

    expect(result).toEqual({ url: LOCAL_URL, mimeType: 'image/jpeg' });
    expect(prisma.message.update).toHaveBeenCalled();
  });

  it('provider responde 404 (mídia esquecida) → 410 em vez de 500', async () => {
    const { service, adapter } = setup(makeMessage({ mediaUrl: UAZAPI_URL }));
    mockedAxios.get.mockRejectedValue({ response: { status: 404 } });
    adapter.resolveInboundMediaUrl.mockRejectedValue({
      message: 'Request failed with status code 404',
      response: { status: 404 },
    });

    await expect(service.resolve('msg_1', ORG)).rejects.toBeInstanceOf(GoneException);
  });

  it('erro transitório do provider (instância desconectada) → 503', async () => {
    const { service, adapter } = setup(makeMessage({}));
    adapter.resolveInboundMediaUrl.mockRejectedValue({
      message: 'WhatsApp disconnected',
      response: { status: 503 },
    });

    await expect(service.resolve('msg_1', ORG)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('upload local que sumiu do disco é re-resolvido no provider', async () => {
    const { service, adapter, uploads } = setup(makeMessage({ mediaUrl: LOCAL_URL }));
    uploads.isMissingLocalUpload.mockReturnValue(true);
    adapter.resolveInboundMediaUrl.mockResolvedValue({ fileUrl: LOCAL_URL });

    await service.resolve('msg_1', ORG);

    expect(adapter.resolveInboundMediaUrl).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ch_1' }),
      expect.objectContaining({ externalMessageId: 'EXT1' }),
    );
  });
});
