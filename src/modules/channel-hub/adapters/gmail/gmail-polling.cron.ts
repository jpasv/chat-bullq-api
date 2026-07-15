import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Queue } from 'bullmq';
import { Channel, ChannelType, Prisma } from '@prisma/client';
import { PrismaService } from '../../../../database/prisma.service';
import { GmailHttpClient, GmailMessageStub } from './gmail.http-client';
import { GmailMessageMapper } from './gmail.message-mapper';
import {
  GMAIL_INITIAL_BACKFILL_MAX_DEFAULT,
  GMAIL_INITIAL_LOOKBACK_HOURS_DEFAULT,
  GMAIL_POLL_JOB,
  GMAIL_POLL_PATTERN_DEFAULT,
  GMAIL_POLL_QUEUE,
  GMAIL_SKIP_LABELS,
  GmailChannelConfig,
} from './gmail.constants';

/**
 * Poller do canal Gmail. O Gmail não tem webhook simples (push exige
 * Cloud Pub/Sub + renovação de watch) — então varremos as caixas num
 * cron BullMQ repeatable (mesmo padrão do RecoveryWatchdogCron: registra
 * o repeat job no boot e processa a varredura no worker).
 *
 * Sync incremental via `history.list` + watermark `lastHistoryId` em
 * `Channel.config`; quando o historyId expira (404, retenção ~1 semana)
 * cai pro full sync por query `after:<lastInternalDate>`. Cada email novo
 * vira NormalizedInboundMessage e entra na fila `inbound-messages` — o
 * MESMO ponto onde o WebhookGatewayController injeta os outros canais,
 * então persistência/idempotência/IA funcionam sem alteração.
 */
@Processor(GMAIL_POLL_QUEUE, { concurrency: 1 })
export class GmailPollingCron extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(GmailPollingCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly httpClient: GmailHttpClient,
    private readonly mapper: GmailMessageMapper,
    private readonly config: ConfigService,
    @InjectQueue(GMAIL_POLL_QUEUE) private readonly pollQueue: Queue,
    @InjectQueue('inbound-messages') private readonly inboundQueue: Queue,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    const pattern =
      this.config.get<string>('GMAIL_POLL_PATTERN') ||
      GMAIL_POLL_PATTERN_DEFAULT;
    try {
      await this.pollQueue.add(
        GMAIL_POLL_JOB,
        {},
        {
          repeat: { pattern },
          jobId: 'gmail-poll-cron',
          removeOnComplete: 10,
          removeOnFail: 10,
        },
      );
      this.logger.log(`gmail_poll_cron_registered pattern=${pattern}`);
    } catch (err) {
      this.logger.error(
        `Falha registrando cron do Gmail poller: ${(err as Error).message}`,
      );
    }
  }

  async process(_job: Job): Promise<{ channels: number; ingested: number }> {
    const channels = await this.prisma.channel.findMany({
      where: { type: ChannelType.GMAIL, isActive: true, deletedAt: null },
    });
    if (channels.length === 0) return { channels: 0, ingested: 0 };

    let ingested = 0;
    for (const channel of channels) {
      try {
        ingested += await this.pollChannel(channel);
      } catch (err: any) {
        // Um canal com token revogado não pode derrubar a varredura dos
        // outros — loga e segue.
        this.logger.error(
          `Gmail poll falhou pro canal ${channel.id} (${
            (channel.config as any)?.email ?? '?'
          }): ${err?.message ?? err}`,
        );
      }
    }
    if (ingested > 0) {
      this.logger.log(
        `Gmail poll: channels=${channels.length} ingested=${ingested}`,
      );
    }
    return { channels: channels.length, ingested };
  }

  private async pollChannel(channel: Channel): Promise<number> {
    const cfg = channel.config as unknown as GmailChannelConfig;
    if (!cfg?.refreshToken) {
      this.logger.warn(`Canal GMAIL ${channel.id} sem refreshToken — pulado`);
      return 0;
    }

    let stubs: GmailMessageStub[];
    let nextHistoryId: string | undefined;

    if (!cfg.lastHistoryId) {
      // Primeira varredura: semeia o watermark e backfill limitado.
      ({ stubs, nextHistoryId } = await this.fullSync(channel, cfg));
    } else {
      try {
        ({ stubs, nextHistoryId } = await this.incrementalSync(
          channel,
          cfg.lastHistoryId,
        ));
      } catch (err: any) {
        if (err?.response?.status === 404) {
          // startHistoryId expirou (retenção ~1 semana) → full sync.
          this.logger.warn(
            `historyId expirado no canal ${channel.id} — full sync fallback`,
          );
          ({ stubs, nextHistoryId } = await this.fullSync(channel, cfg));
        } else {
          throw err;
        }
      }
    }

    // Loop-safety + lixo: nunca ingerir SENT/DRAFT/SPAM/TRASH/CHAT.
    const seen = new Set<string>();
    const candidates = stubs.filter((s) => {
      if (seen.has(s.id)) return false;
      seen.add(s.id);
      return !(s.labelIds ?? []).some((l) => GMAIL_SKIP_LABELS.has(l));
    });

    let ingested = 0;
    let maxInternalDate = cfg.lastInternalDate ?? 0;

    for (const stub of candidates) {
      const full = await this.httpClient.getMessage(channel, stub.id, 'full');
      // history.list às vezes entrega o stub sem labels — re-checa no full.
      if ((full.labelIds ?? []).some((l) => GMAIL_SKIP_LABELS.has(l))) {
        continue;
      }
      const internalDate = Number(full.internalDate ?? 0);
      if (internalDate > maxInternalDate) maxInternalDate = internalDate;

      const messages = this.mapper.normalizeInbound(full, channel);
      for (const message of messages) {
        // Shape idêntico ao enqueue do WebhookGatewayController — daqui em
        // diante o pipeline (idempotência, contato, conversa, IA) é o mesmo.
        await this.inboundQueue.add(
          'process-inbound',
          {
            channelId: channel.id,
            organizationId: channel.organizationId,
            message,
          },
          {
            attempts: 5,
            backoff: { type: 'exponential', delay: 2000 },
            removeOnComplete: true,
            removeOnFail: false,
          },
        );
        ingested++;
      }
    }

    // Avança o watermark SÓ depois de enfileirar tudo — se o tick morrer no
    // meio, o próximo re-varre e a idempotência do pipeline descarta dups.
    if (nextHistoryId || maxInternalDate !== (cfg.lastInternalDate ?? 0)) {
      await this.prisma.channel.update({
        where: { id: channel.id },
        data: {
          config: {
            ...(channel.config as Prisma.JsonObject),
            ...(nextHistoryId ? { lastHistoryId: nextHistoryId } : {}),
            ...(maxInternalDate ? { lastInternalDate: maxInternalDate } : {}),
          } as Prisma.InputJsonValue,
        },
      });
    }

    return ingested;
  }

  /** Sync incremental: drena todas as páginas do history.list. */
  private async incrementalSync(
    channel: Channel,
    startHistoryId: string,
  ): Promise<{ stubs: GmailMessageStub[]; nextHistoryId?: string }> {
    const stubs: GmailMessageStub[] = [];
    let pageToken: string | undefined;
    let nextHistoryId: string | undefined;

    do {
      const page = await this.httpClient.listHistory(
        channel,
        startHistoryId,
        pageToken,
      );
      nextHistoryId = page.historyId ?? nextHistoryId;
      for (const record of page.history ?? []) {
        for (const added of record.messagesAdded ?? []) {
          stubs.push(added.message);
        }
      }
      pageToken = page.nextPageToken;
    } while (pageToken);

    return { stubs, nextHistoryId };
  }

  /**
   * Full sync: semeia o watermark do profile e lista mensagens recentes
   * por query (`after:` aceita epoch em segundos). messages.list já exclui
   * SPAM/TRASH por default; SENT/DRAFT saem no filtro de labels acima.
   */
  private async fullSync(
    channel: Channel,
    cfg: GmailChannelConfig,
  ): Promise<{ stubs: GmailMessageStub[]; nextHistoryId?: string }> {
    const profile = await this.httpClient.getProfile(channel);

    const lookbackHours = Number(
      this.config.get('GMAIL_INITIAL_LOOKBACK_HOURS') ??
        GMAIL_INITIAL_LOOKBACK_HOURS_DEFAULT,
    );
    const sinceMs =
      cfg.lastInternalDate ?? Date.now() - lookbackHours * 60 * 60 * 1000;
    const q = `after:${Math.floor(sinceMs / 1000)} -in:chats`;

    const backfillMax = Number(
      this.config.get('GMAIL_INITIAL_BACKFILL_MAX') ??
        GMAIL_INITIAL_BACKFILL_MAX_DEFAULT,
    );
    const stubs: GmailMessageStub[] = [];
    let pageToken: string | undefined;
    do {
      const page = await this.httpClient.listMessages(
        channel,
        q,
        Math.min(100, backfillMax - stubs.length),
        pageToken,
      );
      stubs.push(...(page.messages ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken && stubs.length < backfillMax);

    // messages.list não traz labelIds no stub — o filtro definitivo roda
    // no re-check pós messages.get (pollChannel).
    return { stubs, nextHistoryId: profile.historyId };
  }
}
