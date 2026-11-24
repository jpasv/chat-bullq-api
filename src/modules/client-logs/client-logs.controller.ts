import { Body, Controller, HttpCode, Logger, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards';
import { CurrentUser } from '../../common/decorators';
import { CreateClientLogDto } from './dto/create-client-log.dto';

/**
 * Diagnóstico enviado pelo app (ex.: cada etapa do envio de áudio). Só vai
 * pro log do container — não grava no banco. Serve pra ver o que falha no
 * aparelho sem simulador nem print da pessoa.
 */
@ApiTags('Client logs')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('client-logs')
export class ClientLogsController {
  private readonly logger = new Logger('ClientLog');

  @Post()
  @HttpCode(204)
  @ApiOperation({ summary: 'Registra um evento de diagnóstico do app no log da API' })
  create(@CurrentUser('id') userId: string, @Body() dto: CreateClientLogDto): void {
    let context = '';
    if (dto.context) {
      try {
        context = ' ' + JSON.stringify(dto.context).slice(0, 600);
      } catch {
        context = '';
      }
    }
    this.logger.warn(`${userId} ${dto.event}${dto.detail ? ` — ${dto.detail}` : ''}${context}`);
  }
}
