import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from './database/prisma.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { ChannelHubModule } from './modules/channel-hub/channel-hub.module';
import { MessagingModule } from './modules/messaging/messaging.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { RoutingModule } from './modules/routing/routing.module';
import { QuickRepliesModule } from './modules/quick-replies/quick-replies.module';
import { TagsModule } from './modules/tags/tags.module';
import { ChatbotModule } from './modules/chatbot/chatbot.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { RatingsModule } from './modules/ratings/ratings.module';
import { ApiKeysModule } from './modules/api-keys/api-keys.module';
import { PublicApiModule } from './modules/public-api/public-api.module';
import { ChannelAccessModule } from './modules/iam/channel-access/channel-access.module';
import { AiAgentsModule } from './modules/ai-agents/ai-agents.module';
import { InboxViewsModule } from './modules/inbox-views/inbox-views.module';
import { PipelinesModule } from './modules/pipelines/pipelines.module';
import { SegmentsModule } from './modules/segments/segments.module';
import { AutomationsModule } from './modules/automations/automations.module';
// ProductsModule removido — catálogo agora vive no Trivapp e é consumido
// via skill HTTP getProductPitch + CatalogSyncService. Tabela `products`
// fica órfã no DB (cleanup futuro). Não importar aqui.
import redisConfig from './config/redis.config';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [redisConfig] }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>('redis.host', 'localhost'),
          port: config.get<number>('redis.port', 6379),
          password: config.get<string>('redis.password') || undefined,
        },
      }),
    }),
    PrismaModule,
    // AutomationsModule is @Global — register early so every domain
    // module can inject OutboxService without explicit imports.
    AutomationsModule,
    ChannelAccessModule,
    AuthModule,
    UsersModule,
    OrganizationsModule,
    RealtimeModule,
    ChannelHubModule,
    MessagingModule,
    NotificationsModule,
    RoutingModule,
    QuickRepliesModule,
    TagsModule,
    ChatbotModule,
    DashboardModule,
    RatingsModule,
    ApiKeysModule,
    PublicApiModule,
    AiAgentsModule,
    InboxViewsModule,
    PipelinesModule,
    SegmentsModule,
  ],
})
export class AppModule {}
