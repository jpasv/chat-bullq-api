import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Configuração da recuperação de vendas, lida do ambiente. Centraliza aqui
 * pra não espalhar `ConfigService.get(...)` pelos services e ter defaults
 * num lugar só.
 *
 * Na 1ª iteração assumimos UMA org/canal de outreach (envs abaixo). Pra
 * multi-org no futuro, trocar `resolveOrg/resolveChannel` por um mapa
 * productUuid → {orgId, channelId}.
 */
@Injectable()
export class RecoveryConfigService {
  private readonly logger = new Logger(RecoveryConfigService.name);

  constructor(private readonly config: ConfigService) {}

  /** Key do pipeline de recuperação (PipelineStage/Pipeline.key). */
  readonly pipelineKey = 'sales_recovery';

  get webhookSecret(): string | null {
    return this.config.get<string>('KIRVANO_WEBHOOK_SECRET') ?? null;
  }

  get orgId(): string | null {
    return this.config.get<string>('RECOVERY_ORG_ID') ?? null;
  }

  /** Canal Zappfy usado pra disparar o cold outreach. */
  get outreachChannelId(): string | null {
    return this.config.get<string>('RECOVERY_OUTREACH_CHANNEL_ID') ?? null;
  }

  /** Agentes de IA autorizados a mexer no pipeline de recuperação. */
  get agentIds(): string[] {
    return this.csv('RECOVERY_AGENT_IDS');
  }

  /** Agente dono das conversas de recuperação (primeiro da lista). */
  get recoveryAgentId(): string | null {
    return this.agentIds[0] ?? null;
  }

  /** UUIDs de produto rastreados (vazio = rastreia todos). */
  get trackedProductUuids(): string[] {
    return this.csv('RECOVERY_TRACKED_PRODUCT_UUIDS');
  }

  isProductTracked(productUuid: string | null): boolean {
    const tracked = this.trackedProductUuids;
    if (tracked.length === 0) return true; // sem allowlist = tudo
    return !!productUuid && tracked.includes(productUuid);
  }

  /** Cadência de follow-up em horas entre tentativas (ex: 24,48,72). */
  get followUpHours(): number[] {
    const raw = this.csv('RECOVERY_FOLLOWUP_HOURS');
    const parsed = raw.map((h) => Number(h)).filter((n) => Number.isFinite(n) && n > 0);
    return parsed.length ? parsed : [24, 48, 72];
  }

  /** Máximo de tentativas de contato antes de marcar Perdido. */
  get maxAttempts(): number {
    const n = Number(this.config.get<string>('RECOVERY_MAX_ATTEMPTS'));
    return Number.isFinite(n) && n > 0 ? n : 3;
  }

  /** Janela mínima entre mensagens de recuperação pro mesmo contato (horas). */
  get cooldownHours(): number {
    const n = Number(this.config.get<string>('RECOVERY_COOLDOWN_HOURS'));
    return Number.isFinite(n) && n > 0 ? n : 24;
  }

  /** Eventos que disparam o opener IMEDIATAMENTE (sem delay). */
  get immediateEvents(): string[] {
    const raw = this.config.get<string>('RECOVERY_IMMEDIATE_EVENTS');
    return (raw ?? 'ABANDONED_CART')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /** Minutos de espera antes do opener pros eventos NÃO imediatos. */
  get delayMinutes(): number {
    const n = Number(this.config.get<string>('RECOVERY_DELAY_MINUTES'));
    return Number.isFinite(n) && n >= 0 ? n : 10;
  }

  /** Delay (ms) do opener pro evento: 0 nos imediatos, senão delayMinutes. */
  outreachDelayMsForEvent(event: string): number {
    if (this.immediateEvents.includes(event)) return 0;
    return this.delayMinutes * 60 * 1000;
  }

  /**
   * Template da 1ª mensagem proativa. Placeholders: {nome} {produto} {link}.
   * Mantido curto de propósito (deliverability via Zappfy não-oficial).
   */
  get openerTemplate(): string {
    return (
      this.config.get<string>('RECOVERY_OPENER_TEMPLATE') ??
      'Oi {nome}! Vi que você se interessou por {produto} mas não finalizou. Posso te ajudar a concluir? Se quiser, é só por aqui: {link}'
    );
  }

  /** Texto do follow-up automático (lembrete). Placeholders: {nome} {produto} {link}. */
  get followUpTemplate(): string {
    return (
      this.config.get<string>('RECOVERY_FOLLOWUP_TEMPLATE') ??
      'Oi {nome}, passando pra saber se ainda tem interesse em {produto}. Qualquer dúvida me chama! {link}'
    );
  }

  /**
   * Nome do template HSM aprovado na Meta pro opener (obrigatório quando o
   * canal de outreach é WhatsApp Oficial — texto livre é bloqueado fora da
   * janela de 24h). Null → no oficial o envio é pulado (card fica em
   * Oportunidade). No Zappfy não é usado (manda texto direto).
   */
  get openerTemplateName(): string | null {
    return this.config.get<string>('RECOVERY_OPENER_TEMPLATE_NAME') ?? null;
  }

  get followUpTemplateName(): string | null {
    return (
      this.config.get<string>('RECOVERY_FOLLOWUP_TEMPLATE_NAME') ??
      this.openerTemplateName
    );
  }

  /** Idioma do template HSM (ex: pt_BR). */
  get templateLang(): string {
    return this.config.get<string>('RECOVERY_TEMPLATE_LANG') ?? 'pt_BR';
  }

  /**
   * Alias amigável por produto pras mensagens (variável {{2}} do template).
   * Formato do env: `uuid=Alias do produto;uuid2=Outro alias` (separador `;`
   * pra permitir vírgula/espaço no alias). Sem entrada → usa o nome cru da
   * Kirvano. Substitui a ideia da tabela recovery_products (config, sem DB).
   */
  productAlias(productUuid: string | null): string | null {
    if (!productUuid) return null;
    const raw = this.config.get<string>('RECOVERY_PRODUCT_ALIASES') ?? '';
    for (const pair of raw.split(';')) {
      const idx = pair.indexOf('=');
      if (idx <= 0) continue;
      const uuid = pair.slice(0, idx).trim();
      const alias = pair.slice(idx + 1).trim();
      if (uuid === productUuid && alias) return alias;
    }
    return null;
  }

  /**
   * IA nas conversas da recuperação. `RECOVERY_AI_ENABLED=false` → a conversa
   * nasce (ou é reaproveitada) com a IA desligada e quem responde é gente/
   * Bravy OS. Default true (comportamento original: a IA conduz o funil).
   */
  get aiEnabled(): boolean {
    return (this.config.get<string>('RECOVERY_AI_ENABLED') ?? 'true').trim().toLowerCase() !== 'false';
  }

  /**
   * Só cards criados a partir deste instante (`RECOVERY_ACTIVE_SINCE`, ISO)
   * recebem mensagem — abertura ou lembrete. Serve pra (re)ligar o envio sem
   * disparar a fila antiga de uma vez. Vazio = sem corte.
   */
  get activeSince(): Date | null {
    const raw = this.config.get<string>('RECOVERY_ACTIVE_SINCE');
    if (!raw) return null;
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  isInActiveWindow(cardCreatedAt: Date): boolean {
    const since = this.activeSince;
    return !since || cardCreatedAt >= since;
  }

  /** Cron do watchdog de cards parados. Default: a cada 30min. */
  get watchdogPattern(): string {
    return (
      this.config.get<string>('RECOVERY_WATCHDOG_CRON') ?? '*/30 * * * *'
    );
  }

  private csv(key: string): string[] {
    return (this.config.get<string>(key) ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
}
