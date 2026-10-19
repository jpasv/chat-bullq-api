import { isOnboardingVoice, splitBubbles } from './reply-to-conversation.tool';

describe('voz do onboarding no replyToConversation', () => {
  const OLD = process.env.ONBOARDING_AGENT_ID;
  beforeAll(() => (process.env.ONBOARDING_AGENT_ID = 'agent_onboarding_001'));
  afterAll(() => (process.env.ONBOARDING_AGENT_ID = OLD));

  it('vale pro agente de onboarding e pra Lívia numa conversa encaminhada por ele', () => {
    expect(isOnboardingVoice('agent_onboarding_001', {})).toBe(true);
    expect(isOnboardingVoice('agent_livia_001', { returnToAgentId: 'agent_onboarding_001' })).toBe(true);
    expect(isOnboardingVoice('agent_livia_001', {})).toBe(false);
  });

  it('linha em branco separa balões, no máximo 3', () => {
    expect(splitBubbles('boa\n\nqual tarefa te toma mais tempo?')).toEqual(['boa', 'qual tarefa te toma mais tempo?']);
    expect(splitBubbles('uma linha\nsó')).toEqual(['uma linha\nsó']);
    expect(splitBubbles('a\n\nb\n\nc\n\nd')).toEqual(['a', 'b', 'c\nd']);
  });
});
