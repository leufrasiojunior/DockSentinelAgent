import { BadRequestException, Inject, Injectable } from "@nestjs/common"
import Docker from "dockerode"
import { DOCKER_CLIENT } from "./docker.constants"
import { DockerUpdateService } from "./docker-update.service"
import { RecreateDto } from "./dto/recreate.dto"
import { UpdateDto } from "./dto/update.dto"
import type { RegistryAuthEntry } from "./registry-auth.util"

@Injectable()
export class DockerOperationsService {
  constructor(
    @Inject(DOCKER_CLIENT) private readonly docker: Docker,
    private readonly updater: DockerUpdateService,
  ) {}

  async updateCheck(name: string, authEntries?: RegistryAuthEntry[]) {
    return this.updater.canUpdateContainer(name, authEntries)
  }

  async recreateContainer(
    name: string,
    body: RecreateDto,
    authEntries?: RegistryAuthEntry[],
  ) {
    const targetFromBody = body.image?.trim()
    const force = body.force ?? false
    const pull = body.pull ?? true

    let targetImage = targetFromBody
    if (!targetImage) {
      const container = this.docker.getContainer(name)
      const inspect = await container.inspect()
      targetImage = inspect?.Config?.Image
    }

    if (!targetImage) {
      throw new BadRequestException("target image is required")
    }

    const check = await this.updater.canUpdateContainer(name, authEntries)
    const isChangingImage = targetFromBody && targetFromBody !== check.imageRef
    if (isChangingImage && !force) {
      throw new BadRequestException("force=true is required when changing image")
    }

    if (
      !isChangingImage &&
      check.canCheckRemote &&
      check.canCheckLocal &&
      check.hasUpdate === false &&
      !force
    ) {
      return {
        status: "noop" as const,
        reason: "already_up_to_date",
        container: name,
        imageRef: check.imageRef,
        remoteDigest: check.remoteDigest,
        repoDigests: check.repoDigests,
        hasUpdate: false,
      }
    }

    return this.updater.recreateContainerWithImage(name, targetImage, {
      force,
      pull,
      authEntries,
    })
  }

  async updateContainer(
    name: string,
    body: UpdateDto,
    authEntries?: RegistryAuthEntry[],
  ) {
    const force = body.force ?? false
    const pull = body.pull ?? true
    const check = await this.updater.canUpdateContainer(name, authEntries)

    if (!check.canCheckRemote && !force) {
      return {
        status: "noop" as const,
        reason: check.reason ?? "cannot_check_remote",
        container: name,
        check,
      }
    }

    if (
      check.canCheckRemote &&
      check.canCheckLocal &&
      check.hasUpdate === false &&
      !force
    ) {
      return {
        status: "noop" as const,
        reason: "already_up_to_date",
        container: name,
        check,
      }
    }

    const targetImage = check.imageRef
    if (!targetImage) {
      throw new BadRequestException("imageRef is required")
    }

    const result = await this.updater.recreateContainerWithImage(name, targetImage, {
      force,
      pull,
      authEntries,
    })

    const after =
      result.status === "success"
        ? {
            ...check,
            localImageId: result.new.localImageId,
            hasUpdate: false,
            reason: "ok" as const,
          }
        : null

    return {
      status: result.status,
      container: name,
      targetImage,
      checkBefore: check,
      result,
      checkAfter: after,
    }
  }
}
