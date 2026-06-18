/** Sufixo de JID de grupo no WhatsApp. */
export const GROUP_JID_SUFFIX = '@g.us';

/** Conversa com o mínimo necessário para derivar o JID do grupo. */
export interface ConversationWithChannels {
  channelId: string;
  contact?: {
    channels?: { channelId: string; externalId: string }[];
  } | null;
}

/**
 * Deriva o JID do grupo de uma conversa: o `externalId` do ContactChannel do
 * contato NAQUELE canal (cada canal-membro tem sua própria linha). Retorna null
 * se não for grupo (`@g.us`). É o invariante estável que identifica o grupo
 * entre os vários números/canais — usado por Segmentos e Projetos.
 */
export function deriveGroupJid(conv: ConversationWithChannels): string | null {
  const jid =
    conv.contact?.channels?.find((ch) => ch.channelId === conv.channelId)
      ?.externalId ?? null;
  return jid && jid.endsWith(GROUP_JID_SUFFIX) ? jid : null;
}
