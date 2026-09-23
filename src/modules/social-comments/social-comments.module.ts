import { Module } from '@nestjs/common';
import { InstagramModule } from '../channel-hub/adapters/instagram/instagram.module';
import { SocialCommentsRepository } from './social-comments.repository';
import { SocialCommentsIngestService } from './social-comments-ingest.service';

@Module({
  imports: [InstagramModule],
  providers: [SocialCommentsRepository, SocialCommentsIngestService],
  exports: [SocialCommentsIngestService, SocialCommentsRepository],
})
export class SocialCommentsModule {}
