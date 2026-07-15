import { Injectable, Logger } from '@nestjs/common';
import { Channel, ChannelType } from '@prisma/client';
import {
  MessageContentType,
  NormalizedInboundMessage,
  NormalizedOutboundMessage,
} from '../../ports/types';
import {
  GmailMessage,
  GmailMessagePart,
} from './gmail.http-client';
import { GmailChannelConfig } from './gmail.constants';

/** Contexto slim persistido em `message.metadata.rawPayload.gmail` —
 *  o payload completo do Gmail pode ter MBs (corpo inline em base64),
 *  então guardamos só o que threading/render precisam. */
export interface GmailRawContext {
  gmail: {
    threadId: string;
    subject?: string;
    messageIdHeader?: string;
    references?: string;
    inReplyTo?: string;
    from?: string;
    to?: string;
    cc?: string;
    labelIds?: string[];
    historyId?: string;
    snippet?: string;
    /** Corpo HTML sanitizável pra render rico no inbox (fase 2). */
    htmlBody?: string;
  };
}

export interface OutboundAttachment {
  filename: string;
  mimeType: string;
  buffer: Buffer;
}

const MAX_HTML_STORED = 100_000; // ~100KB de HTML guardado no metadata

@Injectable()
export class GmailMessageMapper {
  private readonly logger = new Logger(GmailMessageMapper.name);

  /**
   * Email do Gmail → mensagens normalizadas do pipeline. Retorna um array:
   * a 1ª entrada é o corpo (TEXT) e as demais são os anexos (IMAGE/AUDIO/
   * VIDEO/DOCUMENT) — o pipeline trata cada uma como Message própria,
   * igual ao WhatsApp quando mandam texto + mídia.
   */
  normalizeInbound(
    gmailMsg: GmailMessage,
    channel: Channel,
  ): NormalizedInboundMessage[] {
    const headers = collectHeaders(gmailMsg.payload);
    const from = parseAddress(headers['from'] ?? '');
    const subject = decodeRfc2047(headers['subject'] ?? '').trim() || undefined;
    const timestamp = gmailMsg.internalDate
      ? new Date(Number(gmailMsg.internalDate))
      : new Date();

    const { text, html } = extractBodies(gmailMsg.payload);
    const attachments = collectAttachments(gmailMsg.payload);

    const cfg = channel.config as unknown as GmailChannelConfig;
    // Belt-and-suspenders além do skip por label SENT no poller: se o
    // remetente é a própria caixa (alias/send-as), nunca ingerir como
    // mensagem de cliente.
    if (
      from.email &&
      cfg?.email &&
      from.email.toLowerCase() === cfg.email.toLowerCase()
    ) {
      return [];
    }

    const raw: GmailRawContext = {
      gmail: {
        threadId: gmailMsg.threadId,
        subject,
        messageIdHeader: headers['message-id'],
        references: headers['references'],
        inReplyTo: headers['in-reply-to'],
        from: headers['from'],
        to: headers['to'],
        cc: headers['cc'],
        labelIds: gmailMsg.labelIds,
        historyId: gmailMsg.historyId,
        snippet: gmailMsg.snippet,
        htmlBody: html ? html.slice(0, MAX_HTML_STORED) : undefined,
      },
    };

    const base = {
      externalContactId: (from.email || 'unknown@unknown').toLowerCase(),
      contactName: from.name || from.email || undefined,
      channelType: ChannelType.GMAIL,
      timestamp,
      threadExternalId: gmailMsg.threadId,
      subject,
      senderName: from.name || from.email || undefined,
      isGroup: false,
      isEcho: false,
    };

    const messages: NormalizedInboundMessage[] = [];

    const bodyText = stripQuotedReply(
      text || (html ? htmlToText(html) : ''),
    ).trim();
    if (bodyText || attachments.length === 0) {
      messages.push({
        ...base,
        externalMessageId: gmailMsg.id,
        type: MessageContentType.TEXT,
        content: { text: bodyText || gmailMsg.snippet || '(email sem corpo)' },
        rawPayload: raw,
      });
    }

    attachments.forEach((att, i) => {
      messages.push({
        ...base,
        // Sufixo #att<i> mantém unicidade em (conversationId, externalId);
        // o resolveInboundMediaUrl divide de volta pra achar o pai.
        externalMessageId: `${gmailMsg.id}#att${i}`,
        type: attachmentContentType(att.mimeType),
        content: {
          mediaId: att.attachmentId,
          mimeType: att.mimeType,
          fileName: att.filename,
          fileSize: att.size,
          caption: subject,
        },
        rawPayload: raw,
      });
    });

    return messages;
  }

  /**
   * Mensagem normalizada → MIME RFC 2822 em base64url pronto pro
   * `messages.send`. Threading: `In-Reply-To`/`References` casando com o
   * Message-ID original + `Subject` "Re:" + `threadId` no send.
   */
  denormalizeOutbound(
    message: NormalizedOutboundMessage,
    toEmail: string,
    channel: Channel,
    attachments: OutboundAttachment[] = [],
  ): { raw: string; threadId?: string } {
    const cfg = channel.config as unknown as GmailChannelConfig;
    const ctx = message.emailContext;
    const text =
      message.content?.text ?? message.content?.caption ?? '';

    let subject = ctx?.subject?.trim() || firstLineAsSubject(text);
    if (ctx?.threadId && subject && !/^re:/i.test(subject)) {
      subject = `Re: ${subject}`;
    }

    const headerLines: string[] = [
      `From: ${cfg?.email ?? 'me'}`,
      `To: ${toEmail}`,
      `Subject: ${encodeRfc2047(subject || '(sem assunto)')}`,
      'MIME-Version: 1.0',
    ];
    if (ctx?.inReplyTo) {
      headerLines.push(`In-Reply-To: ${ctx.inReplyTo}`);
      const references = [ctx.references, ctx.inReplyTo]
        .filter(Boolean)
        .join(' ')
        .trim();
      headerLines.push(`References: ${references}`);
    }

    let mime: string;
    if (attachments.length === 0) {
      mime = [
        ...headerLines,
        'Content-Type: text/plain; charset="UTF-8"',
        'Content-Transfer-Encoding: base64',
        '',
        wrap76(Buffer.from(text, 'utf8').toString('base64')),
      ].join('\r\n');
    } else {
      const boundary = `bq_${Date.now().toString(36)}_boundary`;
      const parts: string[] = [
        ...headerLines,
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        'Content-Type: text/plain; charset="UTF-8"',
        'Content-Transfer-Encoding: base64',
        '',
        wrap76(Buffer.from(text, 'utf8').toString('base64')),
      ];
      for (const att of attachments) {
        parts.push(
          `--${boundary}`,
          `Content-Type: ${att.mimeType}; name="${sanitizeFilename(att.filename)}"`,
          'Content-Transfer-Encoding: base64',
          `Content-Disposition: attachment; filename="${sanitizeFilename(att.filename)}"`,
          '',
          wrap76(att.buffer.toString('base64')),
        );
      }
      parts.push(`--${boundary}--`);
      mime = parts.join('\r\n');
    }

    return {
      raw: Buffer.from(mime, 'utf8').toString('base64url'),
      threadId: ctx?.threadId,
    };
  }
}

// ───────────────────────── helpers (exportados p/ testes) ─────────────────────────

/** Headers do payload raiz, case-insensitive (name → value). */
export function collectHeaders(
  payload?: GmailMessagePart,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of payload?.headers ?? []) {
    out[h.name.toLowerCase()] = h.value;
  }
  return out;
}

/** `"Nome" <a@b.c>` | `Nome <a@b.c>` | `a@b.c` → { name, email }. */
export function parseAddress(value: string): {
  name?: string;
  email?: string;
} {
  const decoded = decodeRfc2047(value).trim();
  const match = decoded.match(/^\s*(?:"?([^"<]*)"?\s*)?<([^>]+)>\s*$/);
  if (match) {
    const name = match[1]?.trim() || undefined;
    return { name, email: match[2].trim() };
  }
  if (decoded.includes('@')) return { email: decoded };
  return { name: decoded || undefined };
}

/** Percorre o MIME tree e retorna text/plain + text/html (sem anexos). */
export function extractBodies(payload?: GmailMessagePart): {
  text?: string;
  html?: string;
} {
  let text: string | undefined;
  let html: string | undefined;

  const walk = (part?: GmailMessagePart): void => {
    if (!part) return;
    const isAttachment = !!part.filename && !!part.body?.attachmentId;
    if (!isAttachment && part.body?.data) {
      const decoded = decodeBase64Url(part.body.data);
      if (part.mimeType === 'text/plain' && !text) text = decoded;
      else if (part.mimeType === 'text/html' && !html) html = decoded;
    }
    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);
  return { text, html };
}

export interface InboundAttachment {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size?: number;
}

export function collectAttachments(
  payload?: GmailMessagePart,
): InboundAttachment[] {
  const out: InboundAttachment[] = [];
  const walk = (part?: GmailMessagePart): void => {
    if (!part) return;
    if (part.filename && part.body?.attachmentId) {
      out.push({
        attachmentId: part.body.attachmentId,
        filename: part.filename,
        mimeType: part.mimeType || 'application/octet-stream',
        size: part.body.size,
      });
    }
    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);
  return out;
}

export function attachmentContentType(mimeType: string): MessageContentType {
  if (mimeType.startsWith('image/')) return MessageContentType.IMAGE;
  if (mimeType.startsWith('audio/')) return MessageContentType.AUDIO;
  if (mimeType.startsWith('video/')) return MessageContentType.VIDEO;
  return MessageContentType.DOCUMENT;
}

export function decodeBase64Url(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf8');
}

/**
 * Corta a cauda citada dos replies ("On ... wrote:", "Em ... escreveu:",
 * blocos "> ...") — sem isso a IA lê a conversa inteira repetida a cada
 * email e responde ao histórico em vez da mensagem nova.
 */
export function stripQuotedReply(text: string): string {
  if (!text) return '';
  const lines = text.split(/\r?\n/);
  const markers: RegExp[] = [
    /^On .{5,200} wrote:\s*$/,
    /^Em .{5,200} escreveu:\s*$/,
    /^-{2,}\s*(Original|Forwarded) Message\s*-{2,}$/i,
    /^_{5,}\s*$/,
    /^De:\s.+$/i,
    /^From:\s.+$/,
  ];
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (markers.some((m) => m.test(line))) {
      cut = i;
      break;
    }
    // Bloco contíguo de citação "> ..." até o fim → corta a partir dele.
    if (line.startsWith('>')) {
      const rest = lines.slice(i);
      const quoted = rest.filter((l) => l.trim().startsWith('>') || !l.trim());
      if (quoted.length === rest.length) {
        cut = i;
        break;
      }
    }
  }
  return lines.slice(0, cut).join('\n').trim();
}

/** HTML → texto plano (fallback quando o email não tem text/plain). */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Decodifica encoded-words RFC 2047 (=?UTF-8?B?...?= / =?...?Q?...?=). */
export function decodeRfc2047(value: string): string {
  if (!value) return '';
  return value.replace(
    /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
    (_all, _charset: string, enc: string, data: string) => {
      try {
        if (enc.toUpperCase() === 'B') {
          return Buffer.from(data, 'base64').toString('utf8');
        }
        // Q-encoding: '_' é espaço, =XX é byte hex.
        const bytes: number[] = [];
        for (let i = 0; i < data.length; i++) {
          const ch = data[i];
          if (ch === '_') bytes.push(0x20);
          else if (ch === '=' && i + 2 < data.length + 1) {
            bytes.push(parseInt(data.slice(i + 1, i + 3), 16));
            i += 2;
          } else bytes.push(ch.charCodeAt(0));
        }
        return Buffer.from(bytes).toString('utf8');
      } catch {
        return data;
      }
    },
  );
}

/** Codifica subject não-ASCII como encoded-word RFC 2047 (UTF-8/B). */
export function encodeRfc2047(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** Primeira linha do corpo vira subject de email novo (sem thread). */
export function firstLineAsSubject(text: string): string {
  const first = (text || '').split(/\r?\n/)[0]?.trim() ?? '';
  return first.length > 78 ? `${first.slice(0, 75)}...` : first;
}

export function wrap76(base64: string): string {
  return base64.replace(/(.{76})/g, '$1\r\n');
}

export function sanitizeFilename(name: string): string {
  return name.replace(/["\r\n]/g, '_');
}
