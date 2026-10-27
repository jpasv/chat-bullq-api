import { BadRequestException } from '@nestjs/common';
import { IgFlowNode } from './ig-flows.types';

const MAX_BUTTONS = 3;
const MAX_BUTTON_TITLE = 20;
const MAX_TEXT = 640;

/** Valida o grafo antes de salvar: tipos, referências e limites da Meta. */
export function validateIgFlowNodes(nodes: unknown, startNodeId: string): IgFlowNode[] {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new BadRequestException('nodes deve ser um array não vazio');
  }
  const ids = new Set<string>();
  for (const n of nodes as any[]) {
    if (!n?.id || typeof n.id !== 'string') throw new BadRequestException('todo nó precisa de id');
    if (ids.has(n.id)) throw new BadRequestException(`id duplicado: ${n.id}`);
    ids.add(n.id);
  }
  if (!ids.has(startNodeId)) throw new BadRequestException(`startNodeId ${startNodeId} não existe`);

  const ref = (from: string, to?: string) => {
    if (to !== undefined && to !== null && !ids.has(to)) {
      throw new BadRequestException(`${from} aponta pra nó inexistente: ${to}`);
    }
  };

  for (const n of nodes as any[]) {
    switch (n.type) {
      case 'message': {
        if (!n.text || typeof n.text !== 'string') throw new BadRequestException(`${n.id}: text obrigatório`);
        if (n.text.length > MAX_TEXT) throw new BadRequestException(`${n.id}: text passa de ${MAX_TEXT} caracteres`);
        const buttons = n.buttons ?? [];
        if (buttons.length > MAX_BUTTONS) throw new BadRequestException(`${n.id}: máximo ${MAX_BUTTONS} botões`);
        const buttonIds = new Set<string>();
        for (const b of buttons) {
          if (!b?.id || buttonIds.has(b.id)) throw new BadRequestException(`${n.id}: botão sem id ou id repetido`);
          buttonIds.add(b.id);
          if (!b.title || b.title.length > MAX_BUTTON_TITLE) {
            throw new BadRequestException(`${n.id}/${b.id}: título obrigatório, até ${MAX_BUTTON_TITLE} caracteres`);
          }
          if (b.type === 'url') {
            if (!/^https?:\/\//.test(b.url ?? '')) throw new BadRequestException(`${n.id}/${b.id}: url inválida`);
          } else if (b.type === 'postback') {
            if (!b.next) throw new BadRequestException(`${n.id}/${b.id}: botão de resposta precisa de next`);
          } else {
            throw new BadRequestException(`${n.id}/${b.id}: type deve ser url ou postback`);
          }
          ref(`${n.id}/${b.id}`, b.next);
        }
        ref(n.id, n.next);
        break;
      }
      case 'condition':
        if (n.check !== 'follows') throw new BadRequestException(`${n.id}: check suportado: follows`);
        ref(n.id, n.onTrue);
        ref(n.id, n.onFalse);
        break;
      case 'http':
        if (!/^https?:\/\//.test(n.url ?? '')) throw new BadRequestException(`${n.id}: url inválida`);
        ref(n.id, n.next);
        break;
      case 'delay':
        if (n.seconds === undefined && !n.until && !n.dailyAt) {
          throw new BadRequestException(`${n.id}: informe seconds, until ou dailyAt`);
        }
        if (n.until && Number.isNaN(Date.parse(n.until))) throw new BadRequestException(`${n.id}: until inválido`);
        if (n.dailyAt && !/^([01]\d|2[0-3]):[0-5]\d$/.test(n.dailyAt)) {
          throw new BadRequestException(`${n.id}: dailyAt inválido (HH:mm)`);
        }
        ref(n.id, n.next);
        break;
      default:
        throw new BadRequestException(`${n.id}: tipo desconhecido ${n.type}`);
    }
  }
  return nodes as IgFlowNode[];
}

/** Minúsculo, sem acento, espaços colapsados. */
export function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function matchesKeywords(text: string, keywords: string[] | undefined, match: 'contains' | 'exact' = 'contains'): boolean {
  if (!keywords?.length) return true;
  const t = normalizeText(text);
  return keywords.some((k) => {
    const kw = normalizeText(k);
    if (!kw) return false;
    return match === 'exact' ? t === kw : t.includes(kw);
  });
}
