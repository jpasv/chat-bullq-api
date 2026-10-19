import axios from 'axios';
import { HoppeLeadsClient } from './hoppe-leads.client';

jest.mock('axios');
const mocked = axios as jest.Mocked<typeof axios>;

describe('HoppeLeadsClient.addTag', () => {
  it('manda corpo {} (Hoppe dá 500 com JSON sem corpo)', async () => {
    mocked.request.mockResolvedValue({ data: {} } as any);
    const client = new HoppeLeadsClient({ get: (k: string) => (k === 'HOPPE_API_KEY' ? 'k' : undefined) } as any);
    await client.addTag('t1', '1º mensagem');
    const req = mocked.request.mock.calls[0][0] as any;
    expect(req.url).toContain('/api/v2/task/t1/tag/1%C2%BA%20mensagem');
    expect(req.data).toEqual({});
  });
});
