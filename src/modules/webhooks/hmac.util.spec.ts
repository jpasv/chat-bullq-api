import { signPayload } from './hmac.util';
import * as crypto from 'crypto';

describe('signPayload', () => {
  it('gera sha256=<hmac hex> do corpo cru com o secret', () => {
    const body = JSON.stringify({ a: 1 });
    const secret = 'whsec_test';
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
    expect(signPayload(body, secret)).toBe(expected);
  });
  it('assinaturas diferem quando o secret muda', () => {
    const body = '{"a":1}';
    expect(signPayload(body, 's1')).not.toBe(signPayload(body, 's2'));
  });
});
