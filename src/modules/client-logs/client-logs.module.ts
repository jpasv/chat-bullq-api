import { Module } from '@nestjs/common';
import { ClientLogsController } from './client-logs.controller';

@Module({ controllers: [ClientLogsController] })
export class ClientLogsModule {}
