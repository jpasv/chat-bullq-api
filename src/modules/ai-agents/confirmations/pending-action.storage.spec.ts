import { ConflictException } from '@nestjs/common';
import { PendingActionStorage } from './pending-action.storage';
import { PendingActionService } from './pending-action.service';

describe('Pending action conditional transitions', () => {
  function setup() {
    const row: any = {
      id: 'pending', status: 'PENDING', expiresAt: new Date('2099-01-01'),
      createdAt: new Date(), preview: {}, args: {}, approvedAt: null, rejectedAt: null,
    };
    const prisma: any = { aiPendingAction: {
      findUnique: jest.fn(async () => ({ ...row })),
      create: jest.fn(),
      updateMany: jest.fn(async ({ where, data }) => {
        if (row.id !== where.id || row.status !== where.status) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    } };
    const storage = new PendingActionStorage(prisma);
    const queue: any = { add: jest.fn() };
    return { row, prisma, storage, queue, service: new PendingActionService(storage, queue) };
  }

  it('only one concurrent approval saves and enqueues', async () => {
    const s = setup();
    const results = await Promise.allSettled([
      s.service.approve('pending', 'first'), s.service.approve('pending', 'second'),
    ]);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
    expect(s.queue.add).toHaveBeenCalledTimes(1);
    expect(s.row.approvedBy).toBe('first');
    expect(s.prisma.aiPendingAction.updateMany.mock.calls[0][0].where).toEqual({ id: 'pending', status: 'PENDING' });
    expect(s.prisma.aiPendingAction.create).not.toHaveBeenCalled();
  });

  it.each(['REJECTED', 'EXPIRED'])('stale %s transition cannot overwrite approval', async status => {
    const s = setup();
    const stale = (await s.storage.get('pending'))!;
    await s.service.approve('pending', 'first');
    await expect(s.storage.save({ ...stale, status: status as any }, 'PENDING')).rejects.toBeInstanceOf(ConflictException);
    expect(s.row.status).toBe('APPROVED');
  });

  it('does not recreate a missing action during a conditional save', async () => {
    const s = setup();
    const action = (await s.storage.get('pending'))!;
    await expect(s.storage.save({ ...action, id: 'missing' }, 'PENDING')).rejects.toBeInstanceOf(ConflictException);
    expect(s.prisma.aiPendingAction.create).not.toHaveBeenCalled();
  });
});
