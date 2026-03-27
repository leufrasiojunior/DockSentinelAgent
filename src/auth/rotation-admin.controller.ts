import { Body, Controller, Post } from "@nestjs/common"
import { AgentAuthStateService } from "./agent-auth-state.service"

@Controller("agent/v1/setup")
export class RotationAdminController {
  constructor(private readonly authState: AgentAuthStateService) {}

  @Post("prepare-rotation")
  async prepareRotation() {
    const state = await this.authState.enterPendingRotation()
    return { ok: true as const, state }
  }

  @Post("complete")
  async complete(@Body("credential") credential?: string, @Body() body?: Record<string, unknown>) {
    const value = credential ?? (typeof body?.credential === "string" ? body.credential : "")
    const state = await this.authState.completeRotation(value)

    return {
      ok: true as const,
      state,
    }
  }
}
