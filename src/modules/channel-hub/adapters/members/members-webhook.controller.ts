import {
  Controller,
  HttpCode,
  Logger,
  Post,
  RawBodyRequest,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { Public } from '../../../../common/decorators';
import { WebhookThrottleGuard } from '../../webhook-throttle.guard';
import { MembersChannelService } from './members-channel.service';
import { MembersContactMergeService } from './members-contact-merge.service';

/**
 * `POST /api/v1/webhooks/MEMBERS/import` — import de histórico vindo do
 * members-backend. (O `POST /webhooks/MEMBERS` de eventos ao vivo passa pelo
 * WebhookGatewayController, que delega pro MembersChannelService.)
 */
@ApiTags('Webhooks')
@Controller('webhooks/MEMBERS')
@UseGuards(WebhookThrottleGuard)
export class MembersWebhookController {
  private readonly logger = new Logger(MembersWebhookController.name);

  constructor(
    private readonly members: MembersChannelService,
    private readonly merge: MembersContactMergeService,
  ) {}

  @Post('import')
  @Public()
  @HttpCode(200)
  @ApiOperation({ summary: 'Import Área de membros conversation history' })
  async import(@Req() req: RawBodyRequest<Request>, @Res() res: Response) {
    const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body ?? {}));
    try {
      const result = await this.members.receiveImport(
        req.headers as Record<string, string>,
        rawBody,
        req.body,
      );
      return res.status(result.status).json(result.body);
    } catch (err: any) {
      this.logger.error(`Members import failed: ${err?.message ?? err}`, err?.stack);
      return res.status(500).json({ ok: false, error: 'internal_error' });
    }
  }

  /**
   * One-off: funde as conversas duplicadas por contato do canal (1 conversa
   * por contato). Mesma autenticação do import (X-Members-Channel +
   * X-Members-Signature do corpo cru). Corpo: `{ "dryRun": boolean }`.
   */
  @Post('merge-contacts')
  @Public()
  @HttpCode(200)
  @ApiOperation({ summary: 'Merge duplicated Área de membros conversations per contact' })
  async mergeContacts(@Req() req: RawBodyRequest<Request>, @Res() res: Response) {
    const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body ?? {}));
    try {
      const auth = await this.members.authenticate(
        req.headers as Record<string, string>,
        rawBody,
      );
      if ('status' in auth) return res.status(auth.status).json(auth.body);
      const dryRun = (req.body as { dryRun?: unknown } | undefined)?.dryRun;
      if (typeof dryRun !== 'boolean') {
        return res.status(400).json({ ok: false, error: 'dryRun must be a boolean' });
      }
      const result = await this.merge.mergeChannel(auth.channel, { dryRun });
      return res.status(200).json({ ok: true, ...result });
    } catch (err: any) {
      this.logger.error(`Members merge-contacts failed: ${err?.message ?? err}`, err?.stack);
      return res.status(500).json({ ok: false, error: 'internal_error' });
    }
  }
}
