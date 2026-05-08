import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { AiTool, ToolContext, ToolResult } from '../tool.types';

/**
 * Read-only: o cliente já tem acesso a alguma entrega na área de
 * membros? Existe pra resolver o caso "participei da aula e não
 * recebi o brinde / agente de WhatsApp / curso grátis" — antes da
 * IA pedir pro cliente ficar mandando email / telefone repetido,
 * ela checa se o produto JÁ está liberado pro email dele. Bate aqui
 * a diferença entre "não tem conta" (precisa criar), "tem conta mas
 * sem essa entrega" (precisa liberar) e "já tem acesso" (cliente só
 * não viu / esqueceu o login).
 *
 * Backend source: Trivapp /admin/actions/check-access — server-
 * to-server com x-admin-api-key + x-tenant-id (mesmo pattern dos
 * outros admin-actions).
 *
 * Env required:
 * - MEMBERS_TRIVAPP_URL (default https://api.trivapp.com.br)
 * - MEMBERS_ADMIN_KEY
 * - MEMBERS_TENANT_BRAVY
 */
@Injectable()
export class CheckMembersAccessTool implements AiTool {
  private readonly logger = new Logger(CheckMembersAccessTool.name);

  readonly name = 'checkMembersAccess';
  readonly description =
    'Verifica se o cliente já tem acesso a uma entrega na área de membros (Trivapp). Use SEMPRE que cliente disser "não recebi", "cadê o brinde", "participei da aula", "não consegui acessar [produto]" — passe o email do cliente e (opcional) o nome da entrega. Retorna userExists, hasAccess, lista de offers ativas. Diferencia "não cadastrado" de "cadastrado sem acesso" pra IA não pedir email à toa.';
  readonly parameters = {
    type: 'object',
    additionalProperties: false,
    required: ['email'],
    properties: {
      email: {
        type: 'string',
        description:
          'Email que o cliente usa pra logar na área de membros. Confirme com o cliente antes — não chute.',
        minLength: 5,
        maxLength: 200,
      },
      offerSlug: {
        type: 'string',
        description:
          'Nome da entrega específica pra checar (ex: "Agente de WhatsApp", "Dominando Claude Code"). Match case-insensitive. Omita pra listar TODAS as entregas do cliente.',
        maxLength: 120,
      },
    },
  };

  constructor(private readonly config: ConfigService) {}

  async execute(
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const email = String(input.email ?? '').trim().toLowerCase();
    const offerSlug = input.offerSlug
      ? String(input.offerSlug).trim()
      : undefined;
    if (!email || !email.includes('@')) {
      return { output: { ok: false, error: 'email obrigatório e válido' } };
    }

    const baseUrl =
      this.config.get<string>('MEMBERS_TRIVAPP_URL') ??
      'https://api.trivapp.com.br';
    const apiKey = this.config.get<string>('MEMBERS_ADMIN_KEY');
    const tenantId = this.config.get<string>('MEMBERS_TENANT_BRAVY');

    if (!apiKey || !tenantId) {
      this.logger.warn(
        'Trivapp credentials missing (MEMBERS_ADMIN_KEY / MEMBERS_TENANT_BRAVY)',
      );
      return {
        output: {
          ok: false,
          error: 'Trivapp não configurado no servidor — fale com o admin',
        },
      };
    }

    try {
      const resp = await axios.post(
        `${baseUrl}/admin/actions/check-access`,
        { email, ...(offerSlug ? { offerSlug } : {}) },
        {
          headers: {
            'x-admin-api-key': apiKey,
            'x-tenant-id': tenantId,
            'Content-Type': 'application/json',
          },
          timeout: 10_000,
        },
      );

      this.logger.log(
        `checkMembersAccess email=${email} offer=${offerSlug ?? '*'} → hasAccess=${resp.data?.hasAccess} (org=${ctx.organizationId})`,
      );

      return { output: resp.data };
    } catch (err: any) {
      const status = err?.response?.status;
      const detail = err?.response?.data?.message ?? err?.message;
      this.logger.warn(
        `checkMembersAccess failed email=${email}: ${status ?? '?'} ${detail}`,
      );
      // 404 da entrega é resposta legítima — passa o erro pra IA
      // explicar pro cliente em vez de virar exceção.
      if (status === 404) {
        return {
          output: {
            ok: false,
            error: `Não encontrei entrega chamada "${offerSlug}" — confira o nome ou tente sem especificar pra listar todas as do cliente.`,
          },
        };
      }
      return {
        output: {
          ok: false,
          error: `Falha ao consultar área de membros: ${detail}`,
        },
      };
    }
  }
}
