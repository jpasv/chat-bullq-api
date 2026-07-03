import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { OrgRole } from '@prisma/client';

/** Role do usuário na org atual, populado pelo OrgGuard em `request.organization`. */
export const CurrentUserRole = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): OrgRole | undefined => {
    const request = ctx.switchToHttp().getRequest();
    return request.organization?.userRole;
  },
);
