import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { ContactsRepository } from './contacts.repository';
import { UpdateContactDto } from './dto/update-contact.dto';

@Injectable()
export class ContactsService {
  constructor(private readonly repository: ContactsRepository) {}

  async findAll(organizationId: string, search: string | undefined, page: number, limit: number) {
    const skip = (page - 1) * limit;
    const { contacts, total } = await this.repository.findByOrg(organizationId, search, skip, limit);
    return {
      contacts,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(id: string, organizationId: string) {
    const contact = await this.repository.findById(id);
    if (!contact) throw new NotFoundException('Contact not found');
    if (contact.organizationId !== organizationId) throw new ForbiddenException();
    return contact;
  }

  async update(id: string, organizationId: string, dto: UpdateContactDto) {
    await this.findOne(id, organizationId);
    return this.repository.update(id, dto);
  }

  async remove(id: string, organizationId: string) {
    await this.findOne(id, organizationId);
    return this.repository.softDelete(id);
  }

  async create(
    organizationId: string,
    input: { name?: string; phone: string; email?: string; channelId?: string },
  ) {
    if (input.channelId) {
      const existing = await this.repository.findByChannelExternal(input.channelId, input.phone);
      if (existing) return existing.contact;
    }
    return this.repository.createWithChannel(organizationId, input);
  }
}
