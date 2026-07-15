import { Channel, ChannelType } from '@prisma/client';
import {
  GmailMessageMapper,
  GmailRawContext,
  collectAttachments,
  decodeRfc2047,
  encodeRfc2047,
  extractBodies,
  firstLineAsSubject,
  htmlToText,
  parseAddress,
  stripQuotedReply,
} from './gmail.message-mapper';
import { GmailMessage } from './gmail.http-client';
import { MessageContentType } from '../../ports/types';

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

const channel = {
  id: 'ch_1',
  type: ChannelType.GMAIL,
  config: { email: 'suporte@bravy.com.br', refreshToken: 'rt' },
} as unknown as Channel;

function textEmail(overrides: Partial<GmailMessage> = {}): GmailMessage {
  return {
    id: 'msg123',
    threadId: 'thread456',
    labelIds: ['INBOX', 'UNREAD'],
    snippet: 'Olá, preciso de ajuda',
    historyId: '999',
    internalDate: '1750000000000',
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: 'Maria Silva <maria@cliente.com>' },
        { name: 'To', value: 'suporte@bravy.com.br' },
        { name: 'Subject', value: 'Problema no acesso' },
        { name: 'Message-ID', value: '<abc@mail.gmail.com>' },
      ],
      body: { size: 25, data: b64url('Olá, preciso de ajuda com o login.') },
    },
    ...overrides,
  };
}

describe('GmailMessageMapper.normalizeInbound', () => {
  const mapper = new GmailMessageMapper();

  it('normaliza email text/plain com contato, thread e subject', () => {
    const [msg] = mapper.normalizeInbound(textEmail(), channel);

    expect(msg.externalMessageId).toBe('msg123');
    expect(msg.externalContactId).toBe('maria@cliente.com');
    expect(msg.contactName).toBe('Maria Silva');
    expect(msg.channelType).toBe(ChannelType.GMAIL);
    expect(msg.threadExternalId).toBe('thread456');
    expect(msg.subject).toBe('Problema no acesso');
    expect(msg.type).toBe(MessageContentType.TEXT);
    expect(msg.content.text).toBe('Olá, preciso de ajuda com o login.');
    expect(msg.timestamp).toEqual(new Date(1750000000000));
    expect(msg.isEcho).toBe(false);
    expect(msg.isGroup).toBe(false);
  });

  it('guarda o contexto slim de threading no rawPayload (não o payload inteiro)', () => {
    const [msg] = mapper.normalizeInbound(textEmail(), channel);
    const raw = msg.rawPayload as GmailRawContext;

    expect(raw.gmail.threadId).toBe('thread456');
    expect(raw.gmail.messageIdHeader).toBe('<abc@mail.gmail.com>');
    expect(raw.gmail.subject).toBe('Problema no acesso');
    expect((raw as any).payload).toBeUndefined();
  });

  it('multipart/alternative: prefere text/plain sobre text/html', () => {
    const email = textEmail({
      payload: {
        mimeType: 'multipart/alternative',
        headers: [
          { name: 'From', value: 'joao@cliente.com' },
          { name: 'Subject', value: 'Oi' },
        ],
        parts: [
          {
            mimeType: 'text/plain',
            body: { data: b64url('texto puro') },
          },
          {
            mimeType: 'text/html',
            body: { data: b64url('<p>texto <b>rico</b></p>') },
          },
        ],
      },
    });
    const [msg] = mapper.normalizeInbound(email, channel);
    expect(msg.content.text).toBe('texto puro');
  });

  it('email só-HTML: converte pra texto e guarda o HTML no metadata', () => {
    const email = textEmail({
      payload: {
        mimeType: 'text/html',
        headers: [
          { name: 'From', value: 'joao@cliente.com' },
          { name: 'Subject', value: 'Oi' },
        ],
        body: {
          data: b64url('<div>Olá!<br>Tudo bem?</div><style>.x{}</style>'),
        },
      },
    });
    const [msg] = mapper.normalizeInbound(email, channel);
    expect(msg.content.text).toBe('Olá!\nTudo bem?');
    expect((msg.rawPayload as GmailRawContext).gmail.htmlBody).toContain(
      '<div>Olá!',
    );
  });

  it('anexos viram mensagens próprias com externalId composto', () => {
    const email = textEmail({
      payload: {
        mimeType: 'multipart/mixed',
        headers: [
          { name: 'From', value: 'Maria <maria@cliente.com>' },
          { name: 'Subject', value: 'Comprovante' },
        ],
        parts: [
          { mimeType: 'text/plain', body: { data: b64url('segue anexo') } },
          {
            mimeType: 'application/pdf',
            filename: 'comprovante.pdf',
            body: { attachmentId: 'ATT_1', size: 12345 },
          },
          {
            mimeType: 'image/png',
            filename: 'print.png',
            body: { attachmentId: 'ATT_2', size: 999 },
          },
        ],
      },
    });
    const msgs = mapper.normalizeInbound(email, channel);

    expect(msgs).toHaveLength(3);
    expect(msgs[0].type).toBe(MessageContentType.TEXT);

    expect(msgs[1].externalMessageId).toBe('msg123#att0');
    expect(msgs[1].type).toBe(MessageContentType.DOCUMENT);
    expect(msgs[1].content.mediaId).toBe('ATT_1');
    expect(msgs[1].content.fileName).toBe('comprovante.pdf');

    expect(msgs[2].externalMessageId).toBe('msg123#att1');
    expect(msgs[2].type).toBe(MessageContentType.IMAGE);
  });

  it('loop-safety: email enviado pela própria caixa (send-as) retorna vazio', () => {
    const email = textEmail({
      payload: {
        mimeType: 'text/plain',
        headers: [
          { name: 'From', value: 'Suporte <SUPORTE@bravy.com.br>' },
          { name: 'Subject', value: 'Re: Problema' },
        ],
        body: { data: b64url('resposta da própria caixa') },
      },
    });
    expect(mapper.normalizeInbound(email, channel)).toHaveLength(0);
  });

  it('corta a cauda citada do reply antes de entregar pra IA', () => {
    const email = textEmail({
      payload: {
        mimeType: 'text/plain',
        headers: [
          { name: 'From', value: 'maria@cliente.com' },
          { name: 'Subject', value: 'Re: Problema no acesso' },
        ],
        body: {
          data: b64url(
            'Perfeito, funcionou!\n\nEm ter., 15 de jul. de 2026 às 10:00, Suporte escreveu:\n> Tente resetar a senha\n> pelo link abaixo',
          ),
        },
      },
    });
    const [msg] = mapper.normalizeInbound(email, channel);
    expect(msg.content.text).toBe('Perfeito, funcionou!');
  });

  it('subject RFC 2047 encoded é decodificado', () => {
    const encoded = `=?UTF-8?B?${Buffer.from('Orçamento aprovado ✔').toString('base64')}?=`;
    const email = textEmail({
      payload: {
        mimeType: 'text/plain',
        headers: [
          { name: 'From', value: 'maria@cliente.com' },
          { name: 'Subject', value: encoded },
        ],
        body: { data: b64url('ok') },
      },
    });
    const [msg] = mapper.normalizeInbound(email, channel);
    expect(msg.subject).toBe('Orçamento aprovado ✔');
  });

  it('email sem corpo e sem anexo cai pro snippet', () => {
    const email = textEmail({
      payload: {
        mimeType: 'text/plain',
        headers: [{ name: 'From', value: 'maria@cliente.com' }],
        body: {},
      },
    });
    const [msg] = mapper.normalizeInbound(email, channel);
    expect(msg.content.text).toBe('Olá, preciso de ajuda');
  });
});

describe('GmailMessageMapper.denormalizeOutbound', () => {
  const mapper = new GmailMessageMapper();

  const decodeRaw = (raw: string) =>
    Buffer.from(raw, 'base64url').toString('utf8');

  it('reply: threadId + In-Reply-To/References + Subject Re:', () => {
    const { raw, threadId } = mapper.denormalizeOutbound(
      {
        type: MessageContentType.TEXT,
        content: { text: 'Claro, vou te ajudar!' },
        emailContext: {
          threadId: 'thread456',
          inReplyTo: '<abc@mail.gmail.com>',
          references: '<primeiro@mail.gmail.com>',
          subject: 'Problema no acesso',
        },
      },
      'maria@cliente.com',
      channel,
    );

    expect(threadId).toBe('thread456');
    const mime = decodeRaw(raw);
    expect(mime).toContain('To: maria@cliente.com');
    expect(mime).toContain('From: suporte@bravy.com.br');
    expect(mime).toContain('Subject: Re: Problema no acesso');
    expect(mime).toContain('In-Reply-To: <abc@mail.gmail.com>');
    expect(mime).toContain(
      'References: <primeiro@mail.gmail.com> <abc@mail.gmail.com>',
    );
    // Corpo em base64 (transfer-encoding segura pra UTF-8)
    expect(mime).toContain(
      Buffer.from('Claro, vou te ajudar!', 'utf8').toString('base64'),
    );
  });

  it('não duplica o prefixo Re: em subject que já é reply', () => {
    const { raw } = mapper.denormalizeOutbound(
      {
        type: MessageContentType.TEXT,
        content: { text: 'ok' },
        emailContext: {
          threadId: 't1',
          inReplyTo: '<x@y>',
          subject: 'Re: Problema',
        },
      },
      'a@b.com',
      channel,
    );
    expect(decodeRaw(raw)).toContain('Subject: Re: Problema');
    expect(decodeRaw(raw)).not.toContain('Re: Re:');
  });

  it('email novo (sem contexto): primeira linha vira subject', () => {
    const { raw, threadId } = mapper.denormalizeOutbound(
      {
        type: MessageContentType.TEXT,
        content: { text: 'Proposta comercial\nSegue em anexo a proposta.' },
      },
      'novo@cliente.com',
      channel,
    );
    expect(threadId).toBeUndefined();
    expect(decodeRaw(raw)).toContain('Subject: Proposta comercial');
  });

  it('subject não-ASCII sai como encoded-word RFC 2047', () => {
    const { raw } = mapper.denormalizeOutbound(
      {
        type: MessageContentType.TEXT,
        content: { text: 'oi' },
        emailContext: { subject: 'Orçamento' },
      },
      'a@b.com',
      channel,
    );
    expect(decodeRaw(raw)).toContain(
      `Subject: =?UTF-8?B?${Buffer.from('Orçamento').toString('base64')}?=`,
    );
  });

  it('anexo outbound vira multipart/mixed com base64', () => {
    const { raw } = mapper.denormalizeOutbound(
      {
        type: MessageContentType.DOCUMENT,
        content: { text: 'segue o contrato', fileName: 'contrato.pdf' },
        emailContext: { threadId: 't', inReplyTo: '<x@y>', subject: 'Contrato' },
      },
      'a@b.com',
      channel,
      [
        {
          filename: 'contrato.pdf',
          mimeType: 'application/pdf',
          buffer: Buffer.from('PDFBYTES'),
        },
      ],
    );
    const mime = decodeRaw(raw);
    expect(mime).toContain('multipart/mixed');
    expect(mime).toContain('Content-Disposition: attachment; filename="contrato.pdf"');
    expect(mime).toContain(Buffer.from('PDFBYTES').toString('base64'));
  });
});

describe('helpers', () => {
  it('parseAddress cobre os formatos comuns', () => {
    expect(parseAddress('Maria Silva <maria@x.com>')).toEqual({
      name: 'Maria Silva',
      email: 'maria@x.com',
    });
    expect(parseAddress('"Silva, Maria" <maria@x.com>')).toEqual({
      name: 'Silva, Maria',
      email: 'maria@x.com',
    });
    expect(parseAddress('maria@x.com')).toEqual({ email: 'maria@x.com' });
    expect(
      parseAddress('=?UTF-8?B?Sm/Do28=?= <joao@x.com>'),
    ).toEqual({ name: 'João', email: 'joao@x.com' });
  });

  it('decodeRfc2047 decodifica B e Q encoding', () => {
    expect(decodeRfc2047('=?UTF-8?B?T2zDoQ==?=')).toBe('Olá');
    expect(decodeRfc2047('=?UTF-8?Q?Ol=C3=A1_mundo?=')).toBe('Olá mundo');
    expect(decodeRfc2047('plain ascii')).toBe('plain ascii');
  });

  it('encodeRfc2047 só encoda quando precisa', () => {
    expect(encodeRfc2047('hello')).toBe('hello');
    expect(encodeRfc2047('Orçamento')).toMatch(/^=\?UTF-8\?B\?.+\?=$/);
  });

  it('stripQuotedReply corta marcadores en/pt e blocos >', () => {
    expect(
      stripQuotedReply('novo\n\nOn Mon, Jul 14, 2026 John wrote:\n> old'),
    ).toBe('novo');
    expect(stripQuotedReply('novo\n> quote\n> quote2')).toBe('novo');
    expect(stripQuotedReply('sem citação nenhuma')).toBe(
      'sem citação nenhuma',
    );
  });

  it('htmlToText remove tags e decodifica entities', () => {
    expect(htmlToText('<p>a &amp; b</p><p>c&nbsp;d</p>')).toBe('a & b\nc d');
  });

  it('extractBodies ignora parts de anexo', () => {
    const { text } = extractBodies({
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'text/plain', body: { data: b64url('corpo') } },
        {
          mimeType: 'text/plain',
          filename: 'log.txt',
          body: { attachmentId: 'A', data: b64url('anexo') },
        },
      ],
    });
    expect(text).toBe('corpo');
  });

  it('collectAttachments acha anexos em qualquer nível do tree', () => {
    const atts = collectAttachments({
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [
            {
              mimeType: 'image/png',
              filename: 'inline.png',
              body: { attachmentId: 'DEEP' },
            },
          ],
        },
      ],
    });
    expect(atts).toHaveLength(1);
    expect(atts[0].attachmentId).toBe('DEEP');
  });

  it('firstLineAsSubject trunca linhas longas', () => {
    expect(firstLineAsSubject('oi\ntchau')).toBe('oi');
    expect(firstLineAsSubject('x'.repeat(100))).toHaveLength(78);
  });
});
