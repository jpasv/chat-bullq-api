import { AutomationTrigger } from '@prisma/client';
import { OutboxService } from './outbox.service';

describe('OutboxService.deriveDedupKey', () => {
  const svc = new OutboxService({} as any);
  const call = (trigger: AutomationTrigger, payload: any): string | null =>
    (svc as any).deriveDedupKey(trigger, payload);

  it('CONVERSATION_CREATED dedupa por conversationId (um evento por conversa)', () => {
    const key = call(AutomationTrigger.CONVERSATION_CREATED, {
      organizationId: 'org1',
      contactId: 'c1',
      conversationId: 'conv1',
      channelId: 'ch1',
    });
    expect(key).toBe('CONVERSATION_CREATED:conv1');
  });
});
