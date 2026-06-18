import { Injectable } from '@nestjs/common';
import { ChannelType } from '@prisma/client';
import {
  NormalizedInboundMessage,
  NormalizedOutboundMessage,
  MessageContentType,
  StatusUpdate,
} from '../../ports/types';

@Injectable()
export class ZappfyMessageMapper {
  normalizeInbound(event: any): NormalizedInboundMessage | null {
    const msg = event?.message;
    if (!msg) return null;

    const chatid = msg.chatid || '';
    const isGroup = chatid.endsWith('@g.us');
    const phone = chatid.replace(/@s\.whatsapp\.net|@g\.us/g, '');
    const isEcho = msg.fromMe === true;

    // contactName resolution:
    //  - Group: chat name (the group's name).
    //  - 1-on-1 inbound: senderName = the contact who sent it = correct.
    //  - 1-on-1 echo (fromMe=true): senderName is OURSELVES (the connected
    //    WhatsApp), NOT the contact. Using it here used to overwrite the
    //    contact's profileName with the operator's own name every time they
    //    replied from their phone. Fall back to chat name only.
    const resolvedContactName = isGroup
      ? event?.chat?.name || msg.chatName
      : isEcho
        ? event?.chat?.name
        : msg.senderName || event?.chat?.name;

    const result: NormalizedInboundMessage = {
      externalMessageId: msg.messageid || msg.id || '',
      externalContactId: chatid,
      contactName: resolvedContactName,
      contactPhone: isGroup ? undefined : phone,
      channelType: ChannelType.WHATSAPP_ZAPPFY,
      timestamp: new Date(msg.messageTimestamp || Date.now()),
      type: this.resolveContentType(msg),
      content: this.extractContent(msg),
      isForwarded: typeof msg.content === 'object' && !!msg.content?.contextInfo?.isForwarded,
      isGroup,
      isEcho,
      senderName: isGroup
        ? (msg.senderName?.trim() || msg.pushName?.trim() || msg.sender_pn?.replace(/@.+/, '') || undefined)
        : (isEcho ? (msg.senderName?.trim() || msg.pushName?.trim() || undefined) : undefined),
      rawPayload: event,
    };

    if (typeof msg.content === 'object' && msg.content?.contextInfo?.stanzaId) {
      result.replyTo = {
        externalMessageId: msg.content.contextInfo.stanzaId,
      };
    }

    return result;
  }

  /**
   * Uazapi/Zappfy send status updates in at least two shapes:
   *  A) { state: 'delivered', event: { MessageIDs: [...], Timestamp, Type } }
   *  B) { event: 'messages.update', message: { messageid, status: 'READ' | ack:3, timestamp } }
   *  C) { messages: [{ id, ack: 3 }] }  (baileys-style numeric ack)
   *
   * We accept all of them and convert to our StatusUpdate.
   */
  normalizeStatus(event: any): StatusUpdate | null {
    if (!event) return null;

    const tsToDate = (ts: any): Date => {
      const num = typeof ts === 'string' ? parseInt(ts, 10) : Number(ts);
      if (!num || isNaN(num)) return new Date();
      return new Date(num > 9999999999 ? num : num * 1000);
    };

    const numericAckMap: Record<number, StatusUpdate['status']> = {
      1: 'sent',
      2: 'delivered',
      3: 'read',
      4: 'read',
      5: 'failed',
    };

    const stringStatusMap: Record<string, StatusUpdate['status']> = {
      sent: 'sent',
      delivered: 'delivered',
      read: 'read',
      played: 'read',
      failed: 'failed',
      error: 'failed',
      pending: 'sent',
    };

    // Shape A
    const statusEvent = event?.event;
    if (statusEvent && Array.isArray(statusEvent.MessageIDs) && statusEvent.MessageIDs.length > 0) {
      const stateStr = String(event?.state || statusEvent?.Type || '').toLowerCase();
      const status = stringStatusMap[stateStr];
      if (status) {
        return {
          externalMessageId: String(statusEvent.MessageIDs[0]),
          status,
          timestamp: tsToDate(statusEvent?.Timestamp),
        };
      }
    }

    // Shape B
    const bMsg = event?.message;
    if (bMsg && (bMsg.messageid || bMsg.id)) {
      const stateStr = String(bMsg.status || event?.state || '').toLowerCase();
      const numeric = typeof bMsg.ack === 'number' ? bMsg.ack : undefined;
      const status =
        numeric !== undefined ? numericAckMap[numeric] : stringStatusMap[stateStr];
      if (status) {
        return {
          externalMessageId: String(bMsg.messageid || bMsg.id),
          status,
          timestamp: tsToDate(bMsg.timestamp || bMsg.messageTimestamp),
        };
      }
    }

    // Shape C
    if (Array.isArray(event?.messages)) {
      const first = event.messages.find((m: any) => m?.id && (m.ack != null || m.status));
      if (first) {
        const numeric = typeof first.ack === 'number' ? first.ack : undefined;
        const status =
          numeric !== undefined
            ? numericAckMap[numeric]
            : stringStatusMap[String(first.status || '').toLowerCase()];
        if (status) {
          return {
            externalMessageId: String(first.id),
            status,
            timestamp: tsToDate(first.timestamp),
          };
        }
      }
    }

    return null;
  }

  denormalize(
    message: NormalizedOutboundMessage,
    contactExternalId: string,
  ): { endpoint: string; payload: Record<string, any> } {
    const number = contactExternalId.replace(/@s\.whatsapp\.net|@g\.us/g, '');
    // Uazapi/Zappfy aceita `replyid` (id da mensagem citada) em
    // /send/text e /send/media. Quando o cliente recebe, o WhatsApp
    // renderiza a "bolha de resposta" nativa em cima da nossa mensagem.
    // Sem isso, o reply seria apenas textual e perderia o link visual.
    const replyId = message.replyTo?.externalMessageId;
    const withReply = <T extends Record<string, any>>(p: T): T =>
      replyId ? ({ ...p, replyid: replyId } as T) : p;

    switch (message.type) {
      case MessageContentType.TEXT:
        return {
          endpoint: '/send/text',
          payload: withReply({ number, text: message.content.text, delay: 1000 }),
        };

      case MessageContentType.IMAGE:
        return {
          endpoint: '/send/media',
          payload: withReply({
            number,
            file: message.content.mediaUrl,
            type: 'image',
            caption: message.content.caption || '',
          }),
        };

      case MessageContentType.AUDIO:
        return {
          endpoint: '/send/media',
          payload: withReply({
            number,
            file: message.content.mediaUrl,
            // "ptt" renders as a native voice note on WhatsApp. "audio" would
            // render as a forwarded audio file, which is wrong UX for a
            // message the user just recorded in the app.
            type: 'ptt',
          }),
        };

      case MessageContentType.VIDEO:
        return {
          endpoint: '/send/media',
          payload: withReply({
            number,
            file: message.content.mediaUrl,
            type: 'video',
            caption: message.content.caption || '',
          }),
        };

      case MessageContentType.DOCUMENT:
        return {
          endpoint: '/send/media',
          payload: withReply({
            number,
            file: message.content.mediaUrl,
            type: 'document',
            filename: message.content.fileName || '',
            caption: message.content.caption || '',
          }),
        };

      case MessageContentType.STICKER:
        return {
          endpoint: '/send/media',
          payload: withReply({
            number,
            file: message.content.mediaUrl,
            type: 'sticker',
          }),
        };

      case MessageContentType.LOCATION:
        return {
          endpoint: '/send/location',
          payload: withReply({
            number,
            latitude: String(message.content.latitude),
            longitude: String(message.content.longitude),
            name: message.content.text || '',
            address: '',
          }),
        };

      case MessageContentType.REACTION:
        // Reaction já É um reply intrínseco a uma msg específica via
        // targetMessageId — replyid não se aplica aqui.
        return {
          endpoint: '/message/react',
          payload: {
            chatid: contactExternalId,
            messageid: message.content.reaction?.targetMessageId,
            reaction: message.content.reaction?.emoji,
          },
        };

      default:
        return {
          endpoint: '/send/text',
          payload: withReply({ number, text: message.content.text || '' }),
        };
    }
  }

  private resolveContentType(msg: any): MessageContentType {
    const type = (msg.messageType || '').toLowerCase();
    if (type.includes('text') || type === 'conversation' || type === 'extendedtextmessage')
      return MessageContentType.TEXT;
    if (type.includes('image')) return MessageContentType.IMAGE;
    if (type.includes('audio') || type.includes('ptt')) return MessageContentType.AUDIO;
    if (type.includes('video')) return MessageContentType.VIDEO;
    if (type.includes('document')) return MessageContentType.DOCUMENT;
    if (type.includes('sticker')) return MessageContentType.STICKER;
    if (type.includes('location')) return MessageContentType.LOCATION;
    if (type.includes('reaction')) return MessageContentType.REACTION;
    if (type.includes('button') || type.includes('list')) return MessageContentType.INTERACTIVE;
    return MessageContentType.TEXT;
  }

  private extractContent(msg: any): NormalizedInboundMessage['content'] {
    const raw = msg.content;
    const type = (msg.messageType || '').toLowerCase();

    // Zappfy sends content as plain string for Conversation type
    if (typeof raw === 'string') {
      return { text: raw };
    }

    const content = raw || {};

    if (type.includes('text') || type === 'conversation' || type === 'extendedtextmessage') {
      return { text: content.text || content.conversation || '' };
    }
    if (type.includes('image')) {
      return {
        mediaUrl: content.url || content.mediaUrl,
        mimeType: content.mimetype,
        fileSize: content.fileLength,
        caption: content.caption,
      };
    }
    if (type.includes('audio') || type.includes('ptt')) {
      return {
        mediaUrl: content.url || content.mediaUrl,
        mimeType: content.mimetype,
        fileSize: content.fileLength,
      };
    }
    if (type.includes('video')) {
      return {
        mediaUrl: content.url || content.mediaUrl,
        mimeType: content.mimetype,
        fileSize: content.fileLength,
        caption: content.caption,
      };
    }
    if (type.includes('document')) {
      return {
        mediaUrl: content.url || content.mediaUrl,
        mimeType: content.mimetype,
        fileName: content.fileName,
        fileSize: content.fileLength,
        caption: content.caption,
      };
    }
    if (type.includes('sticker')) {
      return {
        mediaUrl: content.url || content.mediaUrl,
        mimeType: content.mimetype,
      };
    }
    if (type.includes('location')) {
      return {
        latitude: content.degreesLatitude,
        longitude: content.degreesLongitude,
        text: content.name || content.address,
      };
    }
    if (type.includes('reaction')) {
      return {
        reaction: {
          emoji: content.text || msg.text || '',
          targetMessageId: msg.reaction || content.key?.ID || '',
        },
      };
    }
    return { text: content.text || '[Unsupported message type]' };
  }
}
