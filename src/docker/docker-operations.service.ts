import { BadRequestException, Inject, Injectable } from "@nestjs/common"
import Docker from "dockerode"
import { DOCKER_CLIENT } from "./docker.constants"
import { DockerDigestService } from "./docker-digest.service"
import { DockerUpdateService } from "./docker-update.service"
import { RecreateDto } from "./dto/recreate.dto"
import { UpdateDto } from "./dto/update.dto"

@Injectable()
export class DockerOperationsService {
  constructor(
    @Inject(DOCKER_CLIENT) private readonly docker: Docker,
    private readonly updater: DockerUpdateService,
    private readonly digests: DockerDigestService,
  ) {}

  async updateCheck(name: string) {
    const container = this.docker.getContainer(name)
    const inspect = await container.inspect()
    const imageRef = inspect?.Config?.Image as string
    const localImageId = inspect?.Image as string
    const remoteDigest = await this.digests.getRemoteDigest(imageRef)

    if (!remoteDigest) {
      return {
        container: name,
        imageRef,
        localImageId,
        canCheckRemote: false,
        canCheckLocal: true,
        hasUpdate: false,
        reason: "remote_digest_not_found" as const,
      }
    }

    const image = this.docker.getImage(localImageId)
    const imageInspect = await image.inspect()
    const repoDigests: string[] = imageInspect?.RepoDigests ?? []
    const hasUpdate = this.updater.hasUpdate(repoDigests, remoteDigest)

    return {
      container: name,
      imageRef,
      localImageId,
      remoteDigest,
      repoDigests,
      canCheckRemote: true,
      canCheckLocal: true,
      hasUpdate,
      reason: "ok" as const,
    }
  }

  async recreateContainer(name: string, body: RecreateDto) {
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

    const check = await this.updater.canUpdateContainer(name)
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
    })
  }

  async updateContainer(name: string, body: UpdateDto) {
    const force = body.force ?? false
    const pull = body.pull ?? true
    const check = await this.updater.canUpdateContainer(name)

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
    })
    const after = await this.updater.canUpdateContainer(name).catch(() => null)

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
