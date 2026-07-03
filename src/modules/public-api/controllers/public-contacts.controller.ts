import { Controller, Get, Post, Patch, Delete, Param, Query, Body, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ApiKeyAuthGuard } from '../../../common/guards';
import { CurrentOrg } from '../../../common/decorators';
import { ApiKeyThrottleGuard } from '../guards/api-key-throttle.guard';
import { ContactsService } from '../../messaging/contacts/contacts.service';
import { mapContact } from '../mappers/contact.mapper';
import { toPublicPage } from '../dto/public-page';
import { CreateContactPublicDto } from '../dto/create-contact.public.dto';
import { UpdateContactPublicDto } from '../dto/update-contact.public.dto';

@ApiTags('Public API · Contacts')
@ApiSecurity('api-key')
@UseGuards(ApiKeyAuthGuard, ApiKeyThrottleGuard)
@Controller('public/contacts')
export class PublicContactsController {
  constructor(private readonly contacts: ContactsService) {}

  @Get()
  @ApiOperation({ summary: 'Lista contatos (paginado)' })
  async list(
    @CurrentOrg('id') orgId: string,
    @Query('search') search?: string,
    @Query('page') page = 1,
    @Query('limit') limit = 20,
  ) {
    const p = Number(page) || 1;
    const l = Math.min(Number(limit) || 20, 100);
    const { contacts, pagination } = await this.contacts.findAll(orgId, search, p, l);
    return toPublicPage(contacts.map(mapContact), pagination.total, p, l);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalha um contato' })
  async get(@CurrentOrg('id') orgId: string, @Param('id') id: string) {
    return mapContact(await this.contacts.findOne(id, orgId));
  }

  @Post()
  @ApiOperation({ summary: 'Cria (ou resolve) um contato — idempotente por (canal, telefone)' })
  async create(@CurrentOrg('id') orgId: string, @Body() dto: CreateContactPublicDto) {
    return mapContact(await this.contacts.create(orgId, dto));
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Atualiza um contato' })
  async update(@CurrentOrg('id') orgId: string, @Param('id') id: string, @Body() dto: UpdateContactPublicDto) {
    return mapContact(await this.contacts.update(id, orgId, dto as any));
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Remove (soft-delete) um contato' })
  async remove(@CurrentOrg('id') orgId: string, @Param('id') id: string) {
    await this.contacts.remove(id, orgId);
    return { deleted: true };
  }
}
