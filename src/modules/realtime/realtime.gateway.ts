import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Server, Socket } from 'socket.io';
import { OrgRole } from '@prisma/client';
import { PresenceService } from './presence.service';
import { PrismaService } from '../../database/prisma.service';
import { ChannelAccessService } from '../iam/channel-access/channel-access.service';

@WebSocketGateway({
  cors: { origin: '*', credentials: true },
  namespace: '/',
})
export class RealtimeGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(RealtimeGateway.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly presence: PresenceService,
    private readonly prisma: PrismaService,
    private readonly channelAccess: ChannelAccessService,
  ) {}

  async handleConnection(client: Socket) {
    try {
      const token =
        client.handshake.auth?.token ||
        client.handshake.headers?.authorization?.replace('Bearer ', '');

      if (!token) {
        client.disconnect();
        return;
      }

      const payload = this.jwtService.verify(token, {
        secret: this.configService.get<string>('JWT_SECRET'),
      });

      client.data.userId = payload.sub;
      client.data.email = payload.email;
      client.join(`user:${payload.sub}`);

      const orgId = client.handshake.auth?.organizationId;
      if (orgId) {
        client.data.organizationId = orgId;
        client.join(`org:${orgId}`);

        const membership = await this.prisma.userOrganization.findUnique({
          where: {
            userId_organizationId: { userId: payload.sub, organizationId: orgId },
          },
          select: { id: true, role: true },
        });

        if (!membership) {
          this.logger.warn(
            `Socket auth: user ${payload.sub} is not a member of org ${orgId}`,
          );
          client.disconnect();
          return;
        }

        client.data.userOrganizationId = membership.id;
        client.data.role = membership.role;

        const channelIds = await this.resolveChannelRoomsForMembership(
          orgId,
          membership.id,
          membership.role,
        );
        for (const channelId of channelIds) {
          client.join(`channel:${channelId}`);
        }
        client.data.channelIds = channelIds;
      }

      await this.presence.setOnline(client.data.userId, orgId);

      // Mark auth as complete. Anything that depends on client.data.role /
      // channelIds (like join:conversation permission checks) MUST wait for
      // this flag — otherwise it sees undefined and rejects the join.
      client.data.authReady = true;

      // Tell the client auth/membership is fully resolved. The client uses
      // this signal to (re)join per-conversation rooms safely. Without this,
      // a fast emit('join:conversation') racing the async handshake fails
      // permission check and the user silently misses message:new events.
      client.emit('ready', {
        userId: client.data.userId,
        organizationId: orgId,
        channelIds: client.data.channelIds ?? [],
      });

      this.logger.log(`Client connected: ${client.data.userId} (org: ${orgId})`);
    } catch (err: any) {
      // Token expirado é o caso comum aqui. Avisa o client antes de derrubar:
      // um disconnect server-side ("io server disconnect") não dispara
      // reconexão automática no socket.io-client, então o front precisa
      // saber que deve renovar o token e reconectar por conta própria.
      this.logger.warn(`Socket auth failed: ${err?.message ?? err}`);
      client.emit('auth:error', { reason: 'invalid-token' });
      client.disconnect();
    }
  }

  private async resolveChannelRoomsForMembership(
    organizationId: string,
    userOrganizationId: string,
    role: OrgRole,
  ): Promise<string[]> {
    if (this.channelAccess.isBypassRole(role)) {
      const channels = await this.prisma.channel.findMany({
        where: { organizationId, deletedAt: null },
        select: { id: true },
      });
      return channels.map((c) => c.id);
    }
    const grants = await this.prisma.channelAgent.findMany({
      where: { userOrganizationId },
      select: { channelId: true },
    });
    return grants.map((g) => g.channelId);
  }

  async handleDisconnect(client: Socket) {
    if (client.data.userId) {
      await this.presence.setOffline(
        client.data.userId,
        client.data.organizationId,
      );
      this.logger.log(`Client disconnected: ${client.data.userId}`);
    }
  }

  @SubscribeMessage('join:conversation')
  async handleJoinConversation(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string },
  ) {
    // Auth handshake (handleConnection) is async — Postgres lookup for
    // org membership + channel grants. If the client races the handshake
    // and emits join:conversation early, client.data.role/channelIds are
    // still undefined and the permission check below silently rejects
    // (undefined.includes(...) → undefined → falsy). Wait up to 2s for
    // auth to complete before evaluating.
    if (!client.data.authReady) {
      const ready = await this.waitForAuthReady(client, 2000);
      if (!ready) {
        this.logger.warn(
          `join:conversation rejected: auth never completed for socket ${client.id}`,
        );
        client.emit('join:conversation:error', {
          conversationId: data.conversationId,
          reason: 'auth-timeout',
        });
        return;
      }
    }

    if (!this.channelAccess.isBypassRole(client.data.role)) {
      const conv = await this.prisma.conversation.findUnique({
        where: { id: data.conversationId },
        select: { channelId: true, organizationId: true },
      });
      if (!conv || conv.organizationId !== client.data.organizationId) {
        this.logger.warn(
          `join:conversation rejected: conv ${data.conversationId} not in org ${client.data.organizationId}`,
        );
        client.emit('join:conversation:error', {
          conversationId: data.conversationId,
          reason: 'org-mismatch',
        });
        return;
      }
      const channelIds = (client.data.channelIds as string[] | undefined) ?? [];
      if (!channelIds.includes(conv.channelId)) {
        this.logger.warn(
          `join:conversation rejected: user ${client.data.userId} has no grant on channel ${conv.channelId}`,
        );
        client.emit('join:conversation:error', {
          conversationId: data.conversationId,
          reason: 'no-channel-grant',
        });
        return;
      }
    }
    client.join(`conv:${data.conversationId}`);
    client.data.activeConversationId = data.conversationId;
    this.presence.setActiveConversation(
      client.data.userId,
      client.data.organizationId,
      data.conversationId,
    );
    client.emit('join:conversation:ack', {
      conversationId: data.conversationId,
    });
  }

  private waitForAuthReady(
    client: Socket,
    timeoutMs: number,
  ): Promise<boolean> {
    if (client.data.authReady) return Promise.resolve(true);
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        if (client.data.authReady) return resolve(true);
        if (!client.connected) return resolve(false);
        if (Date.now() - start >= timeoutMs) return resolve(false);
        setTimeout(tick, 50);
      };
      tick();
    });
  }

  @SubscribeMessage('leave:conversation')
  handleLeaveConversation(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string },
  ) {
    client.leave(`conv:${data.conversationId}`);
    client.data.activeConversationId = null;
    this.presence.setActiveConversation(
      client.data.userId,
      client.data.organizationId,
      null,
    );
  }

  @SubscribeMessage('typing')
  handleTyping(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string; isTyping: boolean },
  ) {
    client.to(`conv:${data.conversationId}`).emit('agent:typing', {
      userId: client.data.userId,
      conversationId: data.conversationId,
      isTyping: data.isTyping,
    });
  }

  emitToOrg(orgId: string, event: string, data: any) {
    this.server.to(`org:${orgId}`).emit(event, data);
  }

  /**
   * Channel-scoped emit. OWNER/ADMIN of the org and AGENTs explicitly granted
   * access to the channel are joined to `channel:<id>` at connect time, so
   * everyone who should see the event receives it — and AGENTs without grant
   * silently miss it. Use this for any event tied to a specific channel
   * (message, conversation update, sync progress).
   */
  emitToChannel(channelId: string, event: string, data: any) {
    this.server.to(`channel:${channelId}`).emit(event, data);
  }

  emitToConversation(conversationId: string, event: string, data: any) {
    this.server.to(`conv:${conversationId}`).emit(event, data);
  }

  emitToUser(userId: string, event: string, data: any) {
    this.server.to(`user:${userId}`).emit(event, data);
  }

  /**
   * Push live channel-permission changes to a user's open sockets without
   * forcing a reconnect. Used when admin grants/revokes access via the
   * channel-access endpoints — the next message on that channel is delivered
   * (or not) immediately, no relogin required.
   */
  async grantChannelToUser(userId: string, channelId: string): Promise<void> {
    const sockets = await this.server.in(`user:${userId}`).fetchSockets();
    for (const s of sockets) {
      s.join(`channel:${channelId}`);
      const ids = (s.data.channelIds as string[] | undefined) ?? [];
      if (!ids.includes(channelId)) s.data.channelIds = [...ids, channelId];
    }
    this.emitToUser(userId, 'permissions:updated', { channelId, granted: true });
  }

  async revokeChannelFromUser(userId: string, channelId: string): Promise<void> {
    const sockets = await this.server.in(`user:${userId}`).fetchSockets();
    for (const s of sockets) {
      s.leave(`channel:${channelId}`);
      const ids = (s.data.channelIds as string[] | undefined) ?? [];
      s.data.channelIds = ids.filter((id) => id !== channelId);
    }
    this.emitToUser(userId, 'permissions:updated', { channelId, granted: false });
  }
}
