import { OrgRole } from '@prisma/client';
import { resolveAssignmentScope } from './conversation-scope';

describe('resolveAssignmentScope', () => {
  it('AGENT é escopado às próprias conversas', () => {
    expect(resolveAssignmentScope(OrgRole.AGENT, 'u1')).toBe('u1');
  });
  it('ADMIN vê tudo (sem escopo)', () => {
    expect(resolveAssignmentScope(OrgRole.ADMIN, 'u1')).toBeUndefined();
  });
  it('OWNER vê tudo (sem escopo)', () => {
    expect(resolveAssignmentScope(OrgRole.OWNER, 'u1')).toBeUndefined();
  });
  it('role indefinido falha fechado (escopa)', () => {
    expect(resolveAssignmentScope(undefined, 'u1')).toBe('u1');
  });
});
