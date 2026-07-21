import { ZappfyMessageMapper } from './zappfy.message-mapper';

const mapper = new ZappfyMessageMapper();

/**
 * Envelope mínimo de webhook do Zappfy. Os campos aqui são os mesmos nomes
 * (e a mesma capitalização) observados nos payloads reais gravados em
 * `messages.metadata.rawPayload`.
 */
function event(message: Record<string, any>) {
  return {
    chat: { name: 'Grupo Teste' },
    message: {
      messageid: '3EB0AAA',
      chatid: '120363423936976174@g.us',
      messageType: 'ExtendedTextMessage',
      messageTimestamp: 1784651525000,
      fromMe: false,
      senderName: 'Fulano',
      text: 'mensagem que responde',
      content: { text: 'mensagem que responde' },
      ...message,
    },
  };
}

describe('ZappfyMessageMapper — reply nativo', () => {
  it('lê o id da citada de contextInfo.stanzaID (D maiúsculo, como o provider manda)', () => {
    const out = mapper.normalizeInbound(
      event({
        content: {
          text: 'ok',
          contextInfo: {
            stanzaID: '3EB0ORIGINAL',
            participant: '75269352194085@lid',
            quotedMessage: { conversation: 'texto original' },
          },
        },
      }),
    );

    expect(out?.replyTo).toEqual({
      externalMessageId: '3EB0ORIGINAL',
      previewText: 'texto original',
    });
  });

  it('aceita o campo `quoted`, que é o que vem preenchido na maioria dos payloads', () => {
    const out = mapper.normalizeInbound(event({ quoted: '3EB0OUTRA' }));
    expect(out?.replyTo?.externalMessageId).toBe('3EB0OUTRA');
  });

  it('não inventa reply quando a mensagem não cita ninguém', () => {
    expect(mapper.normalizeInbound(event({}))?.replyTo).toBeUndefined();
    expect(mapper.normalizeInbound(event({ quoted: '' }))?.replyTo).toBeUndefined();
  });

  it('resume a citada por tipo quando ela não é texto', () => {
    const preview = (quotedMessage: Record<string, any>) =>
      mapper.normalizeInbound(
        event({ content: { contextInfo: { stanzaID: 'x', quotedMessage } } }),
      )?.replyTo?.previewText;

    expect(preview({ imageMessage: {} })).toBe('[imagem]');
    expect(preview({ imageMessage: { caption: 'olha isso' } })).toBe('olha isso');
    expect(preview({ audioMessage: {} })).toBe('[áudio]');
    expect(preview({ documentMessage: { fileName: 'contrato.pdf' } })).toBe('contrato.pdf');
    expect(preview({ contactMessage: { displayName: 'Suporte' } })).toBe('Contato: Suporte');
    expect(preview({ pollCreationMessage: { name: 'Vem?' } })).toBe('Enquete: Vem?');
  });

  it('deixa o preview vazio quando o provider não manda a citada — quem completa é o processor', () => {
    const out = mapper.normalizeInbound(event({ quoted: '3EB0SEMPREVIEW' }));
    expect(out?.replyTo).toEqual({ externalMessageId: '3EB0SEMPREVIEW' });
  });
});

describe('ZappfyMessageMapper — convite de grupo', () => {
  it('vira "Convite para o grupo: <nome>" em vez de bolha vazia', () => {
    const out = mapper.normalizeInbound(
      event({
        messageType: 'GroupInviteMessage',
        text: '',
        content: {
          caption: 'Convite para participar do meu grupo no WhatsApp',
          groupJID: '120363409967696699@g.us',
          groupName: 'Maestria',
          inviteCode: '/G3FZAOUxvkJC36n',
        },
      }),
    );

    expect(out?.content.text).toBe('Convite para o grupo: Maestria');
  });

  it('cai no texto do provider quando o convite vem sem nome do grupo', () => {
    const out = mapper.normalizeInbound(
      event({
        messageType: 'GroupInviteMessage',
        text: '',
        content: { caption: 'Convite para participar do meu grupo no WhatsApp' },
      }),
    );

    expect(out?.content.text).toBe('Convite para participar do meu grupo no WhatsApp');
  });
});

describe('ZappfyMessageMapper — enquete', () => {
  it('voto mostra a opção escolhida', () => {
    const out = mapper.normalizeInbound(
      event({ messageType: 'PollUpdateMessage', text: '', vote: 'CONTADOR', content: {} }),
    );
    expect(out?.content.text).toBe('Votou: CONTADOR');
  });

  it('criação continua mostrando pergunta e opções', () => {
    const out = mapper.normalizeInbound(
      event({
        messageType: 'PollCreationMessage',
        text: 'Vem no evento?',
        content: {
          pollCreationMessage: {
            name: 'Vem no evento?',
            options: [{ optionName: 'Sim' }, { optionName: 'Não' }],
          },
        },
      }),
    );
    expect(out?.content.text).toBe('Enquete: Vem no evento?\n• Sim\n• Não');
  });
});
