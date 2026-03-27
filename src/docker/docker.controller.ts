import { Body, Controller, Get, Inject, Param, Post } from "@nestjs/common"
import Docker from "dockerode"
import { DOCKER_CLIENT } from "./docker.constants"
import { DockerOperationsService } from "./docker-operations.service"
import { DockerService } from "./docker.service"
import { RecreateDto } from "./dto/recreate.dto"
import { UpdateDto } from "./dto/update.dto"

@Controller("agent/v1")
export class DockerController {
  constructor(
    private readonly dockerService: DockerService,
    private readonly operations: DockerOperationsService,
    @Inject(DOCKER_CLIENT) private readonly docker: Docker,
  ) {}

  @Get("info")
  async info() {
    const version = await this.docker.version()
    return {
      mode: "agent" as const,
      agentVersion: process.env.APP_VERSION ?? process.env.npm_package_version ?? "dev",
      dockerVersion: version.Version ?? null,
      dockerApiVersion: version.ApiVersion ?? null,
      dockerHost: version.Os ?? null,
    }
  }

  @Get("containers")
  async listContainers() {
    return this.dockerService.listContainers()
  }

  @Get("containers/:id")
  async containerDetails(@Param("id") id: string) {
    return this.dockerService.getContainerDetails(id)
  }

  @Get("containers/:id/recreate-plan")
  async recreatePlan(@Param("id") id: string) {
    return this.dockerService.buildRecreatePlan(id)
  }

  @Get("containers/:name/update-check")
  async updateCheck(@Param("name") name: string) {
    return this.operations.updateCheck(name)
  }

  @Post("containers/:name/recreate")
  async recreate(@Param("name") name: string, @Body() body: RecreateDto) {
    return this.operations.recreateContainer(name, body ?? {})
  }

  @Post("containers/:name/update")
  async updateContainer(@Param("name") name: string, @Body() body: UpdateDto) {
    return this.operations.updateContainer(name, body ?? {})
  }
}
