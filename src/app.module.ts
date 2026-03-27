import { Module } from "@nestjs/common"
import { APP_GUARD } from "@nestjs/core"
import { AgentAuthGuard } from "./auth/agent-auth.guard"
import { AgentAuthStateService } from "./auth/agent-auth-state.service"
import { RotationAdminController } from "./auth/rotation-admin.controller"
import { SetupController } from "./auth/setup.controller"
import { DockerModule } from "./docker/docker.module"

@Module({
  imports: [DockerModule],
  controllers: [SetupController, RotationAdminController],
  providers: [
    AgentAuthStateService,
    {
      provide: APP_GUARD,
      useClass: AgentAuthGuard,
    },
  ],
})
export class AppModule {}
