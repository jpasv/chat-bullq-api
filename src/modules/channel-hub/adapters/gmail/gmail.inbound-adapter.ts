import { Injectable } from '@nestjs/common';
import { Channel, ChannelType } from '@prisma/client';
import {
  ChannelLocator,
  InboundChannelPort,
} from '../../ports/inbound-channel.port';
import { WebhookParseResult } from '../../ports/types';
import { GmailChannelConfig } from './gmail.constants';

/**
 * Gmail NÃO entrega webhook — a ingestão é 100% polling (GmailPollingCron
 * chama o mapper e enfileira direto na `inbound-messages`, o mesmo ponto
 * onde o WebhookGatewayController injeta os outros canais).
 *
 * Este adapter existe pra satisfazer o contrato do registry
 * (`registry.hasAdapter(GMAIL)`, `getInbound`) — os métodos de webhook
 * são no-ops seguros: qualquer POST engraçadinho em /webhooks/GMAIL
 * morre no `extractLocators → []`.
 */
@Injectable()
export class GmailInboundAdapter implements InboundChannelPort {
  readonly channelType = ChannelType.GMAIL;

  extractLocators(): ChannelLocator[] {
    return [];
  }

  matchesChannel(channel: Channel, locator: ChannelLocator): boolean {
    const cfg = channel.config as unknown as GmailChannelConfig;
    return (
      !!locator.token &&
      !!cfg?.email &&
      locator.token.toLowerCase() === cfg.email.toLowerCase()
    );
  }

  validateWebhook(): boolean {
    return false;
  }

  parseWebhook(): WebhookParseResult {
    return { messages: [], statuses: [], errors: [] };
  }
}
