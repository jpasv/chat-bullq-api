import {
  Body,
  Controller,
  HttpCode,
  Logger,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators';
import { LeadOnboardingConfigService } from './lead-onboarding-config.service';
import { LeadOnboardingRepository } from './lead-onboarding.repository';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Acha o id da task no payload da automação do Hoppe ("Tag adicionada →
 * Call webhook"). O formato exato não é documentado, então procura nos
 * caminhos comuns e só aceita UUID.
 */
export function extractTaskId(payload: unknown): string | null {
  const p = (payload ?? {}) as Record<string, any>;
  const candidates = [
    p.taskId,
    p.task_id,
    p.task?.id,
    p.data?.taskId,
    p.data?.task_id,
    p.data?.task?.id,
    p.payload?.taskId,
    p.payload?.task_id,
    p.payload?.task?.id,
    p.entityId,
    p.entity?.id,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && UUID_RE.test(c)) return c;
  }
  return null;
}

@ApiTags('Webhooks')
@Controller('webhooks/hoppe')
export class HoppeWebhookController {
  private readonly logger = new Logger(HoppeWebhookController.name);

  constructor(
    private readonly config: LeadOnboardingConfigService,
    private readonly repo: LeadOnboardingRepository,
  ) {}

  @Post(':secret')
  @Public()
  @HttpCode(200)
  @ApiOperation({ summary: 'Recebe a automação do Hoppe (tag abordar-ia)' })
  @ApiParam({ name: 'secret', description: 'Segredo configurado na URL' })
  async handle(
    @Param('secret') secret: string,
    @Body() payload: any,
  ): Promise<{ status: string }> {
    const expected = this.config.webhookSecret;
    if (!expected || secret !== expected) {
      this.logger.warn('Hoppe webhook com segredo inválido');
      throw new UnauthorizedException('invalid secret');
    }
    const orgId = this.config.orgId;
    if (!orgId) return { status: 'disabled' };

    const taskId = extractTaskId(payload);
    if (!taskId) {
      this.logger.warn(
        `Hoppe webhook sem task id. Chaves: ${JSON.stringify(shapeOf(payload))}`,
      );
      return { status: 'no_task' };
    }

    const status = await this.repo.enqueueFromTag(orgId, taskId);
    this.logger.log(`Hoppe webhook: task=${taskId} → ${status}`);
    return { status };
  }
}

/** Estrutura do payload (só chaves, sem valores) pra depurar formato novo. */
function shapeOf(v: unknown, depth = 0): unknown {
  if (!v || typeof v !== 'object' || depth > 2) return typeof v;
  if (Array.isArray(v)) return [shapeOf(v[0], depth + 1)];
  return Object.fromEntries(
    Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, shapeOf(x, depth + 1)]),
  );
}
