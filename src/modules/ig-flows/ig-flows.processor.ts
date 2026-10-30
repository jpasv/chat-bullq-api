import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { IgFlowRunnerService } from './ig-flow-runner.service';
import {
  IG_FLOWS_QUEUE,
  IgFlowInteractionJob,
  IgFlowPostbackJob,
  IgFlowResumeJob,
  IgFlowStartCommentJob,
  IgFlowStartStoryJob,
} from './ig-flows.types';

@Processor(IG_FLOWS_QUEUE, { concurrency: 5 })
export class IgFlowsProcessor extends WorkerHost {
  private readonly logger = new Logger(IgFlowsProcessor.name);

  constructor(private readonly runner: IgFlowRunnerService) {
    super();
  }

  async process(job: Job): Promise<void> {
    switch (job.name) {
      case 'comment':
        return this.runner.startFromComment(job.data as IgFlowStartCommentJob);
      case 'story':
        return this.runner.startFromStory(job.data as IgFlowStartStoryJob);
      case 'dm':
        return this.runner.startFromStory(job.data as IgFlowStartStoryJob, 'DM_KEYWORD');
      case 'postback':
        return this.runner.handlePostback(job.data as IgFlowPostbackJob);
      case 'interaction': {
        const data = job.data as IgFlowInteractionJob;
        return this.runner.handleInteraction(data.channelId, data.contactExternalId);
      }
      case 'resume':
        return this.runner.resume(job.data as IgFlowResumeJob);
      default:
        this.logger.warn(`Job desconhecido: ${job.name}`);
    }
  }
}
