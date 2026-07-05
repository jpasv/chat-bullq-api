import { ContactsService } from './contacts.service';

describe('ContactsService.create (aditivo)', () => {
  const build = () => {
    const repo = {
      createWithChannel: jest.fn().mockResolvedValue({ id: 'c1', name: 'Ana', phone: '5511999' }),
      findByChannelExternal: jest.fn().mockResolvedValue(null),
    };
    return { repo, service: new ContactsService(repo as any) };
  };

  it('cria contato novo com canal', async () => {
    const { repo, service } = build();
    const out = await service.create('org1', { name: 'Ana', phone: '5511999', channelId: 'ch1' });
    expect(repo.createWithChannel).toHaveBeenCalledWith('org1', { name: 'Ana', phone: '5511999', channelId: 'ch1' });
    expect(out).toMatchObject({ id: 'c1' });
  });

  it('é idempotente: se já existe contactChannel (channel, phone), retorna o existente', async () => {
    const { repo, service } = build();
    repo.findByChannelExternal.mockResolvedValue({ contact: { id: 'existing', name: 'Ana' } });
    const out = await service.create('org1', { name: 'Ana', phone: '5511999', channelId: 'ch1' });
    expect(repo.createWithChannel).not.toHaveBeenCalled();
    expect(out).toMatchObject({ id: 'existing' });
  });
});
