import { Module, forwardRef } from '@nestjs/common';
import { InstagramModule } from '../channel-hub/adapters/instagram/instagram.module';
import { MessagingModule } from '../messaging/messaging.module';
import { LlmModule } from '../ai-agents/llm/llm.module';
import { SocialCommentsController } from './social-comments.controller';
import { SocialCommentsRepository } from './social-comments.repository';
import { SocialCommentsIngestService } from './social-comments-ingest.service';
import { SocialCommentsService } from './social-comments.service';

@Module({
  imports: [InstagramModule, LlmModule, forwardRef(() => MessagingModule)],
  controllers: [SocialCommentsController],
  providers: [SocialCommentsRepository, SocialCommentsIngestService, SocialCommentsService],
  exports: [SocialCommentsIngestService, SocialCommentsRepository],
})
export class SocialCommentsModule {}
