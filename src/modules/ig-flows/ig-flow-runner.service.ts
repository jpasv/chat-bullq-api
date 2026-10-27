import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import axios from 'axios';
import {
  Channel,
  IgFlow,
  IgFlowRun,
  MessageContentType,
  MessageDirection,
  MessageStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { InstagramHttpClient } from '../channel-hub/adapters/instagram/instagram.http-client';
import { ContactResolverService } from '../messaging/pipeline/contact-resolver.service';
import { ConversationResolverService } from '../messaging/pipeline/conversation-resolver.service';
import { MessagesRepository } from '../messaging/messages/messages.repository';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import {
  IG_FLOWS_QUEUE,
  IgFlowButton,
  IgFlowDelayNode,
  IgFlowMessageNode,
  IgFlowNode,
  IgFlowPostbackJob,
  IgFlowResumeJob,
  IgFlowRunStatus,
  IgFlowStartCommentJob,
  IgFlowStartStoryJob,
  IgFlowTriggerConfig,
  POSTBACK_PREFIX,
} from './ig-flows.types';
import { dayLabel, nextDailyAt } from './ig-flows.schedule';
import { matchesKeywords } from './ig-flows.validator';

const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_STEPS = 30;
const MAX_LOG = 100;
const FINISHED: IgFlowRunStatus[] = ['DONE', 'FAILED'];

@Injectable()
export class IgFlowRunnerService {
  private readonly logger = new Logger(IgFlowRunnerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly instagram: InstagramHttpClient,
    private readonly contactResolver: ContactResolverService,
    private readonly conversationResolver: ConversationResolverService,
    private readonly messagesRepo: MessagesRepository,
    private readonly realtime: RealtimeGateway,
    private readonly config: ConfigService,
    @InjectQueue(IG_FLOWS_QUEUE) private readonly queue: Queue,
  ) {}

  // ─── Gatilhos ─────────────────────────────────

  async startFromComment(job: IgFlowStartCommentJob): Promise<void> {
    const flows = await this.activeFlows(job.organizationId, job.channelId, 'COMMENT');
    const flow = flows.find((f) => {
      const cfg = (f.triggerConfig ?? {}) as IgFlowTriggerConfig;
      if (cfg.mediaIds?.length && !cfg.mediaIds.includes(job.mediaId)) return false;
      return matchesKeywords(job.text, cfg.keywords, cfg.match);
    });
    if (!flow) return;

    const cfg = (flow.triggerConfig ?? {}) as IgFlowTriggerConfig;
    if (await this.alreadyRan(flow, cfg, job.authorExternalId)) {
      this.logger.log(`Flow ${flow.id}: ${job.authorExternalId} já passou pelo fluxo, comentário ${job.commentExternalId} ignorado`);
      return;
    }

    let run: IgFlowRun;
    try {
      run = await this.prisma.igFlowRun.create({
        data: {
          flowId: flow.id,
          organizationId: job.organizationId,
          channelId: job.channelId,
          contactExternalId: job.authorExternalId,
          contactUsername: job.authorUsername ?? null,
          commentExternalId: job.commentExternalId,
          mediaId: job.mediaId,
          triggerText: job.text,
          currentNodeId: flow.startNodeId,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return;
      throw err;
    }
    this.logger.log(`Flow ${flow.id} (${flow.name}) disparado: run=${run.id} comment=${job.commentExternalId}`);

    if (cfg.publicReplies?.length) {
      const reply = cfg.publicReplies[Math.floor(Math.random() * cfg.publicReplies.length)];
      const channel = await this.prisma.channel.findUnique({ where: { id: job.channelId } });
      if (channel && reply) {
        await this.instagram
          .replyToComment(channel, job.commentExternalId, this.render(reply, run))
          .then(() => this.appendLog(run.id, { nodeId: 'trigger', event: 'public_reply' }))
          .catch((err) => this.appendLog(run.id, { nodeId: 'trigger', event: 'public_reply_failed', error: err.message }));
      }
    }

    await this.execute(run.id, flow.startNodeId);
  }

  async startFromStory(job: IgFlowStartStoryJob): Promise<void> {
    const flows = await this.activeFlows(job.organizationId, job.channelId, 'STORY_REPLY');
    const flow = flows.find((f) => {
      const cfg = (f.triggerConfig ?? {}) as IgFlowTriggerConfig;
      return matchesKeywords(job.text, cfg.keywords, cfg.match);
    });
    if (!flow) return;
    const cfg = (flow.triggerConfig ?? {}) as IgFlowTriggerConfig;
    if (await this.alreadyRan(flow, cfg, job.contactExternalId)) return;

    const run = await this.prisma.igFlowRun.create({
      data: {
        flowId: flow.id,
        organizationId: job.organizationId,
        channelId: job.channelId,
        contactExternalId: job.contactExternalId,
        triggerText: job.text,
        currentNodeId: flow.startNodeId,
        // Resposta a story já abre a janela; não há comentário pra private reply.
        privateReplyUsed: true,
        lastInteractionAt: new Date(),
      },
    });
    this.logger.log(`Flow ${flow.id} (${flow.name}) disparado por story: run=${run.id}`);
    await this.execute(run.id, flow.startNodeId);
  }

  /** Clique em botão de resposta (postback) dos nossos templates. */
  async handlePostback(job: IgFlowPostbackJob): Promise<void> {
    if (!job.payload?.startsWith(POSTBACK_PREFIX)) return;
    const [runId, buttonId] = job.payload.slice(POSTBACK_PREFIX.length).split(':');
    const run = await this.prisma.igFlowRun.findUnique({ where: { id: runId }, include: { flow: true } });
    if (!run || run.channelId !== job.channelId) return;

    await this.prisma.igFlowRun.update({
      where: { id: run.id },
      data: { lastInteractionAt: new Date(), contactExternalId: job.contactExternalId },
    });
    const button = this.findButton(run.flow, buttonId);
    await this.appendLog(run.id, { nodeId: buttonId, event: 'postback' });
    if (button?.next) await this.execute(run.id, button.next);
  }

  /**
   * Mensagem da pessoa na DM: renova a janela de 24h e destrava runs que
   * pararam esperando a primeira interação depois do private reply.
   */
  async handleInteraction(channelId: string, contactExternalId: string): Promise<void> {
    const runs = await this.prisma.igFlowRun.findMany({
      where: { channelId, contactExternalId, status: { notIn: FINISHED } },
    });
    if (!runs.length) return;
    await this.prisma.igFlowRun.updateMany({
      where: { id: { in: runs.map((r) => r.id) } },
      data: { lastInteractionAt: new Date() },
    });
    for (const run of runs) {
      if (run.status === 'WAITING_INTERACTION' && run.currentNodeId) {
        await this.execute(run.id, run.currentNodeId);
      }
    }
  }

  /** Clique em botão de link: devolve a URL final e segue o `next` do botão. */
  async handleLinkClick(runId: string, buttonId: string): Promise<string | null> {
    const run = await this.prisma.igFlowRun.findUnique({ where: { id: runId }, include: { flow: true } });
    if (!run) return null;
    const button = this.findButton(run.flow, buttonId);
    if (!button?.url) return null;
    if (button.next) {
      await this.queue.add(
        'resume',
        { runId, nodeId: button.next } satisfies IgFlowResumeJob,
        // Um clique segue o fluxo; cliques repetidos só redirecionam.
        { jobId: `click-${runId}-${buttonId}`, removeOnComplete: false, removeOnFail: false, attempts: 3, backoff: { type: 'exponential', delay: 2000 } },
      );
    }
    await this.appendLog(runId, { nodeId: buttonId, event: 'link_click' });
    return button.url;
  }

  async resume(job: IgFlowResumeJob): Promise<void> {
    if (job.interaction) {
      await this.prisma.igFlowRun.update({ where: { id: job.runId }, data: { lastInteractionAt: new Date() } });
    }
    await this.execute(job.runId, job.nodeId);
  }

  // ─── Engine ───────────────────────────────────

  async execute(runId: string, startNodeId: string): Promise<void> {
    let run = await this.prisma.igFlowRun.findUnique({ where: { id: runId }, include: { flow: true } });
    if (!run) return;
    const flow = run.flow;
    if (!flow.isActive || flow.deletedAt) {
      await this.finish(run.id, 'DONE', { nodeId: startNodeId, event: 'flow_inactive' });
      return;
    }
    const channel = await this.prisma.channel.findUnique({ where: { id: run.channelId } });
    if (!channel) {
      await this.finish(run.id, 'FAILED', { nodeId: startNodeId, event: 'channel_missing' });
      return;
    }
    const nodes = new Map(((flow.nodes ?? []) as unknown as IgFlowNode[]).map((n) => [n.id, n]));

    let nodeId: string | undefined = startNodeId;
    for (let step = 0; nodeId && step < MAX_STEPS; step++) {
      const node = nodes.get(nodeId);
      if (!node) break;
      run = (await this.prisma.igFlowRun.update({
        where: { id: run.id },
        data: { currentNodeId: node.id, status: 'RUNNING' },
        include: { flow: true },
      }))!;

      switch (node.type) {
        case 'message': {
          const usePrivateReply = !run.privateReplyUsed && !!run.commentExternalId;
          if (!usePrivateReply) {
            if (!run.lastInteractionAt) {
              // Meta: depois do private reply, só dá pra mandar outra mensagem
              // quando a pessoa responder ou clicar.
              await this.setStatus(run.id, 'WAITING_INTERACTION', { nodeId: node.id, event: 'waiting_interaction' });
              return;
            }
            if (Date.now() - run.lastInteractionAt.getTime() > WINDOW_MS) {
              await this.appendLog(run.id, { nodeId: node.id, event: 'skipped_outside_24h' });
              nodeId = node.next;
              continue;
            }
          }
          try {
            await this.sendMessage(channel, run, node, usePrivateReply);
          } catch (err: any) {
            await this.finish(run.id, 'FAILED', { nodeId: node.id, event: 'send_failed', error: err.message });
            return;
          }
          if (usePrivateReply) {
            await this.prisma.igFlowRun.update({ where: { id: run.id }, data: { privateReplyUsed: true } });
          }
          await this.appendLog(run.id, { nodeId: node.id, event: 'sent' });
          if (!node.next) {
            const waitsClick = (node.buttons ?? []).some((b) => b.next);
            await this.setStatus(run.id, waitsClick ? 'WAITING' : 'DONE');
            return;
          }
          nodeId = node.next;
          break;
        }
        case 'condition': {
          const follows = await this.instagram.getFollowsBusiness(channel, run.contactExternalId);
          await this.appendLog(run.id, { nodeId: node.id, event: 'condition', result: follows });
          nodeId = follows === true ? node.onTrue : node.onFalse;
          break;
        }
        case 'http': {
          await this.callHttp(run, node);
          nodeId = node.next;
          break;
        }
        case 'delay': {
          const ms = node.dailyAt
            ? nextDailyAt(node.dailyAt, node.graceMinutes).getTime() - Date.now()
            : node.until
              ? Date.parse(node.until) - Date.now()
              : (node.seconds ?? 0) * 1000;
          if (!node.next) break;
          if (ms <= 0) {
            nodeId = node.next;
            break;
          }
          await this.queue.add(
            'resume',
            { runId: run.id, nodeId: node.next } satisfies IgFlowResumeJob,
            {
              delay: ms,
              jobId: `delay-${run.id}-${node.id}`,
              attempts: 3,
              backoff: { type: 'exponential', delay: 5000 },
              removeOnComplete: true,
              removeOnFail: false,
            },
          );
          await this.setStatus(run.id, 'WAITING', { nodeId: node.id, event: 'delay', ms });
          return;
        }
      }
      if (node.type === 'delay' && !node.next) nodeId = undefined;
    }
    await this.setStatus(run.id, 'DONE');
  }

  // ─── Envio ────────────────────────────────────

  private async sendMessage(
    channel: Channel,
    run: IgFlowRun,
    node: IgFlowMessageNode,
    usePrivateReply: boolean,
  ): Promise<void> {
    const text = this.render(node.text, run);
    const buttons = node.buttons ?? [];
    const message = buttons.length
      ? {
          attachment: {
            type: 'template',
            payload: {
              template_type: 'button',
              text,
              buttons: buttons.map((b) =>
                b.type === 'url'
                  ? { type: 'web_url', title: b.title, url: this.linkFor(run.id, b) }
                  : { type: 'postback', title: b.title, payload: `${POSTBACK_PREFIX}${run.id}:${b.id}` },
              ),
            },
          },
        }
      : { text };
    const recipient = usePrivateReply
      ? { comment_id: run.commentExternalId }
      : { id: run.contactExternalId };

    const sent = await this.instagram.sendMessage(channel, { recipient, message });
    await this.recordInInbox(channel, run, text, buttons, sent?.message_id).catch((err) =>
      this.logger.warn(`run ${run.id}: falha ao registrar mensagem no inbox: ${err.message}`),
    );
  }

  /** Grava a mensagem enviada na conversa, pra aparecer no inbox. */
  private async recordInInbox(
    channel: Channel,
    run: IgFlowRun,
    text: string,
    buttons: IgFlowButton[],
    externalId?: string,
  ): Promise<void> {
    const { contactId } = await this.contactResolver.resolveByExternalId(
      run.organizationId,
      channel.id,
      run.contactExternalId,
      run.contactUsername ?? undefined,
    );
    const { conversationId } = await this.conversationResolver.resolve(run.organizationId, channel.id, contactId);
    const message = await this.messagesRepo.create({
      conversationId,
      direction: MessageDirection.OUTBOUND,
      type: MessageContentType.TEXT,
      content: {
        text: buttons.length ? `${text}\n\n${buttons.map((b) => `[${b.title}]`).join(' ')}` : text,
      },
      status: MessageStatus.SENT,
      externalId: externalId ?? null,
      sentAt: new Date(),
      metadata: { igFlowId: run.flowId, igFlowRunId: run.id },
    });
    await this.prisma.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: new Date() } });
    this.realtime.emitToChannel(channel.id, 'message:new', { message, conversationId, contactId });
    this.realtime.emitToConversation(conversationId, 'message:new', { message });
  }

  private linkFor(runId: string, button: IgFlowButton): string {
    // Botão sem continuação vai direto pro destino; com continuação passa
    // pelo nosso redirect pra registrar o clique e seguir o fluxo.
    if (!button.next) return button.url!;
    const base = (this.config.get<string>('IG_FLOWS_PUBLIC_URL') ?? 'https://api.chat.bravy.com.br').replace(/\/$/, '');
    return `${base}/api/v1/ig-flows/r/${runId}/${button.id}`;
  }

  private async callHttp(run: IgFlowRun & { flow: IgFlow }, node: Extract<IgFlowNode, { type: 'http' }>) {
    const vars = this.vars(run);
    const body = node.body
      ? JSON.parse(JSON.stringify(node.body), (_k, v) => (typeof v === 'string' ? this.interpolate(v, vars) : v))
      : {
          event: 'ig_flow',
          flow: { id: run.flowId, name: run.flow.name },
          runId: run.id,
          nodeId: node.id,
          channelId: run.channelId,
          contact: { igsid: run.contactExternalId, username: run.contactUsername },
          comment: run.commentExternalId
            ? { id: run.commentExternalId, text: run.triggerText, mediaId: run.mediaId }
            : null,
        };
    try {
      const res = await axios.request({
        url: this.interpolate(node.url, vars),
        method: node.method ?? 'POST',
        headers: node.headers,
        data: (node.method ?? 'POST') === 'GET' ? undefined : body,
        timeout: 15000,
      });
      await this.appendLog(run.id, { nodeId: node.id, event: 'http', status: res.status });
    } catch (err: any) {
      // Webhook fora do ar não trava o funil.
      await this.appendLog(run.id, {
        nodeId: node.id,
        event: 'http_failed',
        status: err?.response?.status,
        error: err.message,
      });
    }
  }

  // ─── Helpers ──────────────────────────────────

  private activeFlows(organizationId: string, channelId: string, triggerType: string) {
    return this.prisma.igFlow
      .findMany({
        where: { organizationId, triggerType, isActive: true, deletedAt: null },
        orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
      })
      .then((flows) => flows.filter((f) => !f.channelIds.length || f.channelIds.includes(channelId)));
  }

  private async alreadyRan(flow: IgFlow, cfg: IgFlowTriggerConfig, contactExternalId: string) {
    if (cfg.oncePerContact === false) return false;
    const prev = await this.prisma.igFlowRun.findFirst({
      where: { flowId: flow.id, contactExternalId },
      select: { id: true },
    });
    return !!prev;
  }

  private findButton(flow: IgFlow, buttonId: string): IgFlowButton | undefined {
    for (const n of (flow.nodes ?? []) as unknown as IgFlowNode[]) {
      if (n.type !== 'message') continue;
      const b = n.buttons?.find((x) => x.id === buttonId);
      if (b) return b;
    }
    return undefined;
  }

  private vars(run: IgFlowRun & { flow?: IgFlow }): Record<string, string> {
    const vars: Record<string, string> = {
      username: run.contactUsername ?? '',
      igsid: run.contactExternalId,
      comment: run.triggerText ?? '',
    };
    // {{dia_aula}} segue o primeiro delay diário do fluxo, pra copy e envio baterem.
    const daily = ((run.flow?.nodes ?? []) as unknown as IgFlowNode[]).find(
      (n): n is IgFlowDelayNode => n.type === 'delay' && !!n.dailyAt,
    );
    if (daily) vars.dia_aula = dayLabel(daily.dailyAt!, daily.graceMinutes);
    return vars;
  }

  private render(text: string, run: IgFlowRun & { flow?: IgFlow }): string {
    return this.interpolate(text, this.vars(run));
  }

  private interpolate(text: string, vars: Record<string, string>): string {
    return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in vars ? vars[k] : m));
  }

  private async setStatus(runId: string, status: IgFlowRunStatus, entry?: Record<string, unknown>) {
    await this.prisma.igFlowRun.update({ where: { id: runId }, data: { status } });
    if (entry) await this.appendLog(runId, entry);
  }

  private finish(runId: string, status: IgFlowRunStatus, entry: Record<string, unknown>) {
    return this.setStatus(runId, status, entry);
  }

  private async appendLog(runId: string, entry: Record<string, unknown>) {
    const run = await this.prisma.igFlowRun.findUnique({ where: { id: runId }, select: { log: true } });
    if (!run) return;
    const log = [...((run.log ?? []) as unknown[]), { at: new Date().toISOString(), ...entry }].slice(-MAX_LOG);
    await this.prisma.igFlowRun.update({ where: { id: runId }, data: { log: log as Prisma.InputJsonValue } });
  }
}
