import { IsString, IsOptional, IsEmail } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateContactPublicDto {
  @ApiProperty({ example: '5511999998888', description: 'Telefone E.164 (só dígitos)' })
  @IsString()
  phone: string;

  @ApiPropertyOptional({ example: 'Ana Silva' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ example: 'ana@x.com' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ description: 'Vincula o contato a este canal (externalId = phone)' })
  @IsOptional()
  @IsString()
  channelId?: string;
}
