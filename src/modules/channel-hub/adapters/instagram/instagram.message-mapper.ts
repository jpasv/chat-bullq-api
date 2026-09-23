import { Injectable } from '@nestjs/common';
import { ChannelType } from '@prisma/client';
import {
  NormalizedInboundMessage,
  NormalizedOutboundMessage,
  MessageContentType,
  StatusUpdate,
  TemplateButton,
  TemplateElement,
  NormalizedComment,
} from '../../ports/types';

@Injectable()
export class InstagramMessageMapper {
  normalizeInbound(messaging: Record<string, any>): NormalizedInboundMessage | null {
    const senderId = messaging.sender?.id;
    const recipientId = messaging.recipient?.id;
    const message = messaging.message;
    if (!senderId || !message) return null;

    const isEcho = !!message.is_echo;
    // For echo events (sent from IG app by our account), the "contact" is the recipient,
    // not the sender (which is us).
    const externalContactId = isEcho ? recipientId : senderId;
    if (!externalContactId) return null;

    const result: NormalizedInboundMessage = {
      externalMessageId: message.mid,
      externalContactId,
      channelType: ChannelType.INSTAGRAM,
      timestamp: new Date(messaging.timestamp),
      type: this.resolveContentType(message),
      content: this.extractContent(message),
      isEcho,
      rawPayload: messaging,
    };

    // Instagram reply contexts. `reply_to` may contain:
    //   - mid (reply to a message)
    //   - story { id, url } (reply to a story) — our core use case
    //   - ad    { id, title } (reply to an ad)
    // Story mentions arrive as attachments[type=story_mention] with a CDN url.
    const replyTo = this.extractReplyContext(message);
    if (replyTo) {
      result.replyTo = replyTo;
    }

    return result;
  }

  private extractReplyContext(message: Record<string, any>): NormalizedInboundMessage['replyTo'] | undefined {
    const rt = message.reply_to;
    if (rt?.story?.id || rt?.story?.url) {
      return {
        story: {
          id: rt.story.id ? String(rt.story.id) : undefined,
          url: rt.story.url,
          kind: 'reply',
        },
      };
    }
    if (rt?.ad?.id) {
      return { ad: { id: String(rt.ad.id), title: rt.ad.title } };
    }
    if (rt?.mid) {
      return { externalMessageId: String(rt.mid) };
    }
    // Story mention: surfaces as a standalone attachment, not as reply_to.
    const attachment = message.attachments?.[0];
    if (attachment?.type === 'story_mention') {
      return {
        story: {
          url: attachment.payload?.url,
          kind: 'mention',
        },
      };
    }
    return undefined;
  }

  normalizeStatus(messaging: Record<string, any>): StatusUpdate | null {
    const delivery = messaging.delivery;
    if (!delivery?.mids?.length) return null;

    return {
      externalMessageId: delivery.mids[0],
      status: 'delivered',
      timestamp: new Date(messaging.timestamp),
    };
  }

  /**
   * Meta sends `read` with a `watermark` timestamp (no mids).
   * We use the watermark to flip status to READ for every matching outbound
   * message up to that timestamp — the processor handles the bulk update.
   */
  normalizeReadStatus(messaging: Record<string, any>): StatusUpdate | null {
    const read = messaging.read;
    if (!read?.watermark) return null;
    return {
      externalMessageId: `ig-read-watermark:${read.watermark}`,
      status: 'read',
      timestamp: new Date(Number(read.watermark) || messaging.timestamp),
    };
  }

  /**
   * `value` de `entry[].changes[]` com `field === 'comments'`:
   * `{ id, text, from: { id, username }, media: { id, media_product_type }, parent_id? }`.
   * `entryTimeSeconds` é `entry.time` (unix em segundos).
   */
  normalizeComment(
    value: Record<string, any>,
    entryTimeSeconds?: number,
  ): NormalizedComment | null {
    const externalId = value?.id ? String(value.id) : undefined;
    const authorExternalId = value?.from?.id ? String(value.from.id) : undefined;
    const mediaId = value?.media?.id ? String(value.media.id) : undefined;
    if (!externalId || !authorExternalId || !mediaId) return null;

    return {
      externalId,
      parentExternalId: value.parent_id ? String(value.parent_id) : undefined,
      mediaId,
      mediaProductType: value.media?.media_product_type,
      authorExternalId,
      authorUsername: value.from?.username,
      text: typeof value.text === 'string' ? value.text : '',
      commentedAt: entryTimeSeconds
        ? new Date(entryTimeSeconds * 1000)
        : new Date(),
      rawPayload: value,
    };
  }

  denormalize(
    message: NormalizedOutboundMessage,
    contactExternalId: string,
  ): Record<string, any> {
    const base = { recipient: { id: contactExternalId } };

    // Instagram Messenger Platform NÃO permite reply nativo em DM
    // (api só aceita reply em comentários/stories de outro fluxo).
    // Fallback: prefixa a mensagem com um quote textual mostrando o
    // sender + trecho da msg citada. Cliente vê uma "citação" inline
    // ao invés da bolha-resposta nativa, mas a referência fica clara.
    const quotePrefix = buildIgQuotePrefix(message.replyTo);
    const applyQuoteToText = (text: string): string =>
      quotePrefix ? `${quotePrefix}${text}` : text;

    switch (message.type) {
      case MessageContentType.TEXT:
        return {
          ...base,
          message: { text: applyQuoteToText(message.content.text || '') },
        };

      case MessageContentType.IMAGE: {
        // Mídia não tem campo "caption" no payload da MP — se houver
        // quote pra anexar, manda o quote como mensagem separada antes.
        // Aqui só retorna a mídia; o adapter não suporta envio composto,
        // então degradamos: quote vira texto antes da mídia via 2 sends
        // já existentes (typing indicator), mas pra simplicidade hoje
        // apenas ignoramos quote em mídia. UI sinaliza o usuário.
        return {
          ...base,
          message: {
            attachment: {
              type: 'image',
              payload: { url: message.content.mediaUrl, is_reusable: true },
            },
          },
        };
      }

      case MessageContentType.AUDIO:
        return {
          ...base,
          message: {
            attachment: {
              type: 'audio',
              payload: { url: message.content.mediaUrl, is_reusable: true },
            },
          },
        };

      case MessageContentType.VIDEO:
        return {
          ...base,
          message: {
            attachment: {
              type: 'video',
              payload: { url: message.content.mediaUrl, is_reusable: true },
            },
          },
        };

      case MessageContentType.DOCUMENT:
        return {
          ...base,
          message: {
            attachment: {
              type: 'file',
              payload: { url: message.content.mediaUrl, is_reusable: true },
            },
          },
        };

      default:
        return {
          ...base,
          message: { text: applyQuoteToText(message.content.text || '') },
        };
    }
  }

  private resolveContentType(msg: Record<string, any>): MessageContentType {
    if (msg.text) return MessageContentType.TEXT;
    if (msg.attachments?.length) {
      const type = msg.attachments[0].type;
      const map: Record<string, MessageContentType> = {
        image: MessageContentType.IMAGE,
        audio: MessageContentType.AUDIO,
        video: MessageContentType.VIDEO,
        file: MessageContentType.DOCUMENT,
        share: MessageContentType.TEXT,
        story_mention: MessageContentType.TEXT,
        reel: MessageContentType.VIDEO,
        template: MessageContentType.TEMPLATE,
      };
      return map[type] || MessageContentType.TEXT;
    }
    return MessageContentType.TEXT;
  }

  private extractContent(msg: Record<string, any>): NormalizedInboundMessage['content'] {
    if (msg.text) {
      return { text: msg.text };
    }

    if (msg.attachments?.length) {
      const att = msg.attachments[0];
      const payload = att.payload || {};

      switch (att.type) {
        case 'image':
          return { mediaUrl: payload.url, mimeType: 'image/jpeg' };
        case 'audio':
          return { mediaUrl: payload.url, mimeType: 'audio/mp4' };
        case 'video':
        case 'reel':
          return { mediaUrl: payload.url, mimeType: 'video/mp4' };
        case 'file':
          return { mediaUrl: payload.url };
        case 'share':
          return { text: payload.url || '[Shared content]' };
        case 'story_mention':
          return { text: '[Story mention]', mediaUrl: payload.url };
        case 'template':
          return this.extractTemplateContent(payload);
        default:
          return { text: `[${att.type}]` };
      }
    }

    return { text: '[Unsupported message]' };
  }

  private extractTemplateContent(payload: Record<string, any>): NormalizedInboundMessage['content'] {
    // Instagram nests data under a key named after the template type
    // (e.g. payload.generic.elements, payload.button.buttons). Older shapes
    // also expose template_type + sibling fields directly on payload.
    const wrapperKey = Object.keys(payload).find(
      (k) => payload[k] && typeof payload[k] === 'object' && !Array.isArray(payload[k]),
    );
    const inner =
      wrapperKey && (payload[wrapperKey] as Record<string, any>) ? payload[wrapperKey] : payload;
    const templateType =
      (payload.template_type as string | undefined) || wrapperKey || undefined;

    const mapBtn = (b: any): TemplateButton => ({
      type: String(b?.type ?? 'web_url'),
      title: String(b?.title ?? ''),
      url: b?.url ? String(b.url) : undefined,
      payload: b?.payload ? String(b.payload) : undefined,
    });

    const rawButtons = Array.isArray(inner.buttons)
      ? inner.buttons
      : Array.isArray(payload.buttons)
        ? payload.buttons
        : [];
    const buttons: TemplateButton[] = rawButtons.map(mapBtn);

    const rawElements = Array.isArray(inner.elements)
      ? inner.elements
      : Array.isArray(payload.elements)
        ? payload.elements
        : [];
    const elements: TemplateElement[] = rawElements.map((el: any) => ({
      title: el?.title ? String(el.title) : undefined,
      subtitle: el?.subtitle ? String(el.subtitle) : undefined,
      imageUrl: el?.image_url ? String(el.image_url) : undefined,
      defaultActionUrl: el?.default_action?.url ? String(el.default_action.url) : undefined,
      buttons: Array.isArray(el?.buttons) ? el.buttons.map(mapBtn) : undefined,
    }));

    const headerText =
      (inner.text ? String(inner.text) : undefined) ||
      (payload.text ? String(payload.text) : undefined);
    const elementText = elements
      .map((el) => [el.title, el.subtitle].filter(Boolean).join(' — '))
      .filter(Boolean)
      .join('\n');
    const text = headerText || elementText || undefined;

    return {
      text,
      template: {
        templateType,
        text: headerText,
        buttons: buttons.length ? buttons : undefined,
        elements: elements.length ? elements : undefined,
      },
    };
  }
}

/**
 * Monta o prefixo de quote pro fallback de reply no Instagram DM.
 *
 *   > [Nome] disse:
 *   > trecho da mensagem citada
 *
 *   resposta original
 *
 * Limita o trecho a 120 chars pra não inflar mensagens curtas. Retorna
 * string vazia quando não há replyTo ou quando previewText/senderName
 * vêm sem conteúdo útil — nesse caso melhor não citar nada do que
 * mostrar "> undefined" pro cliente.
 */
function buildIgQuotePrefix(
  replyTo: NormalizedOutboundMessage['replyTo'],
): string {
  if (!replyTo) return '';
  const sender = replyTo.senderName?.trim();
  let preview = replyTo.previewText?.trim() ?? '';
  if (!sender && !preview) return '';
  if (preview.length > 120) preview = preview.slice(0, 117) + '…';
  // Newline-formatado pra renderizar como bloco "citado" no IG.
  const senderLine = sender ? `> ${sender} disse:\n` : '';
  const previewLine = preview ? `> ${preview}\n\n` : '\n';
  return `${senderLine}${previewLine}`;
}
