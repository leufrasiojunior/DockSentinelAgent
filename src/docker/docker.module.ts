import { Module } from "@nestjs/common"
import Docker from "dockerode"
import { DockerController } from "./docker.controller"
import { DOCKER_CLIENT } from "./docker.constants"
import { DockerDigestService } from "./docker-digest.service"
import { DockerOperationsService } from "./docker-operations.service"
import { DockerService } from "./docker.service"
import { DockerUpdateService } from "./docker-update.service"

@Module({
  providers: [
    {
      provide: DOCKER_CLIENT,
      useFactory: () => new Docker({ socketPath: "/var/run/docker.sock" }),
    },
    DockerService,
    DockerDigestService,
    DockerUpdateService,
    DockerOperationsService,
  ],
  controllers: [DockerController],
})
export class DockerModule {}
