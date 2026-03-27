import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import type { Request } from "express"
import { AgentAuthStateService } from "./agent-auth-state.service"
import { IS_PUBLIC_KEY } from "./public.decorator"

@Injectable()
export class AgentAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authState: AgentAuthStateService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ])
    if (isPublic) {
      return true
    }

    const req = context.switchToHttp().getRequest<Request>()
    const token = await this.authState.getExpectedTokenForPath(req.path)
    if (!token) {
      throw new UnauthorizedException("Agent token is not configured")
    }

    const auth = req.headers.authorization ?? ""
    const expected = `Bearer ${token}`
    if (auth !== expected) {
      throw new UnauthorizedException("Invalid agent token")
    }

    return true
  }
}
