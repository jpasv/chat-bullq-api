import { Injectable } from '@nestjs/common';
import { Channel, ChannelType } from '@prisma/client';
import {
  ChannelLocator,
  InboundChannelPort,
} from '../../ports/inbound-channel.port';
import {
  MessageContentType,
  NormalizedInboundMessage,
  WebhookParseResult,
} from '../../ports/types';
import { verifyMembersSignature } from './members.signature';
import {
  MEMBERS_CHANNEL_HEADER,
  MEMBERS_SIGNATURE_HEADER,
  validateMembersEvent,
} from './members.types';

/**
 * Área de membros (members-backend). O emissor conhece o canal: manda o id
 * no header `X-Members-Channel` e assina o corpo com o `webhookSecret` do
 * canal (`X-Members-Signature: sha256=<hex>`).
 *
 * O roteamento HTTP (códigos 401/404/400 do contrato e o evento `handoff`)
 * fica no MembersChannelService — este adapter só cobre localizar, validar
 * assinatura e normalizar o evento `message`.
 */
@Injectable()
export class MembersInboundAdapter implements InboundChannelPort {
  readonly channelType = ChannelType.MEMBERS;

  extractLocators(
    _payload: unknown,
    headers: Record<string, string>,
  ): ChannelLocator[] {
    const raw = headerValue(headers, MEMBERS_CHANNEL_HEADER);
    return raw ? [{ channelId: raw }] : [];
  }

  matchesChannel(channel: Channel, locator: ChannelLocator): boolean {
    return !!locator.channelId && channel.id === locator.channelId;
  }

  validateWebhook(
    headers: Record<string, string>,
    rawBody: Buffer,
    webhookSecret?: string,
  ): boolean {
    return verifyMembersSignature(
      headerValue(headers, MEMBERS_SIGNATURE_HEADER),
      rawBody,
      webhookSecret,
    );
  }

  /**
   * Só o evento `message` vira NormalizedInboundMessage (entra no pipeline
   * normal: contato → conversa por thread → mensagem → IA/automação).
   * `handoff` não é mensagem do membro — é tratado à parte como nota.
   */
  parseWebhook(payload: unknown, _channel?: Channel): WebhookParseResult {
    const result: WebhookParseResult = { messages: [], statuses: [], errors: [] };
    const validated = validateMembersEvent(payload);
    if (!validated.ok) {
      result.errors.push({ code: 'invalid_body', message: validated.error, rawData: payload });
      return result;
    }
    const event = validated.value;
    if (event.event !== 'message' || !event.message) return result;

    const normalized: NormalizedInboundMessage = {
      externalMessageId: event.message.id,
      externalContactId: event.contact.externalId,
      contactName: event.contact.name ?? undefined,
      contactPhone: event.contact.phone ?? undefined,
      channelType: ChannelType.MEMBERS,
      timestamp: new Date(event.message.timestamp),
      type: MessageContentType.TEXT,
      content: { text: event.message.text },
      senderName: event.contact.name ?? undefined,
      threadExternalId: event.conversation.id,
      rawPayload: payload,
    };
    result.messages.push(normalized);
    return result;
  }
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const v = headers?.[name] ?? headers?.[name.toLowerCase()];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' && s.trim() ? s.trim() : undefined;
}
