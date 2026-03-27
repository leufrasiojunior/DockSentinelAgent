import { Inject, Injectable, Logger } from "@nestjs/common"
import Docker from "dockerode"
import type { ContainerCreateOptions } from "dockerode"
import { DOCKER_CLIENT } from "./docker.constants"
import { DockerDigestService } from "./docker-digest.service"

type PortBinding = { HostPort?: string }
type PortBindings = Record<string, Array<PortBinding> | null>
type NetworkAttachment = { IPAddress?: string; GlobalIPv6Address?: string }
type NetworkMap = Record<string, NetworkAttachment>
type ProgressEvent = { status?: string; id?: string; progress?: string }
type ErrorWithStatus = { statusCode?: number; status?: number; message?: string }

export type ContainerUpdateCheckReason =
  | "registry_auth_required"
  | "remote_digest_error"
  | "remote_digest_not_found"
  | "local_image_missing"
  | "local_digest_error"
  | "local_repo_digests_empty"
  | "ok"

export type ContainerUpdateCheck = {
  container: string
  imageRef: string
  localImageId: string
  canCheckRemote: boolean
  canCheckLocal: boolean
  hasUpdate: boolean
  reason: ContainerUpdateCheckReason
  remoteDigest?: string
  repoDigests?: string[]
  error?: string
}

export type PullResult = { imageRef: string; pulledImageId?: string }
export type PullInfo = PullResult | { skipped: true }
export type ContainerUpdateInfo = {
  containerId: string
  imageRef: string
  localImageId: string
}

export type HealthReason = "no-healthcheck" | "healthy" | "unhealthy" | "timeout"

export type ContainerUpdateResult =
  | {
      status: "success"
      pull: PullInfo
      old: ContainerUpdateInfo
      new: ContainerUpdateInfo
      health: HealthReason
      didChangeImageId: boolean
    }
  | {
      status: "rolled_back"
      pull: PullInfo
      old: ContainerUpdateInfo
      attemptedImage: string
      error: string
    }

@Injectable()
export class DockerUpdateService {
  private readonly logger = new Logger(DockerUpdateService.name)

  constructor(
    @Inject(DOCKER_CLIENT) private readonly docker: Docker,
    private readonly digests: DockerDigestService,
  ) {}

  private hasHostPorts(portBindings: PortBindings | undefined): boolean {
    if (!portBindings) return false
    return Object.values(portBindings).some(
      (arr) => Array.isArray(arr) && arr.some((binding) => binding?.HostPort),
    )
  }

  private hasStaticIps(networks: NetworkMap | undefined): boolean {
    if (!networks) return false
    return Object.values(networks).some((network) => {
      const ipv4 = (network?.IPAddress ?? "").trim()
      const ipv6 = (network?.GlobalIPv6Address ?? "").trim()
      return Boolean(ipv4 || ipv6)
    })
  }

  private async waitForHealthy(
    container: Docker.Container,
    timeoutMs: number,
  ): Promise<{ ok: boolean; reason: HealthReason }> {
    const start = Date.now()

    while (Date.now() - start < timeoutMs) {
      const info = await container.inspect()
      const health = info?.State?.Health
      if (!health) {
        if (info?.State?.Running) {
          return { ok: true, reason: "no-healthcheck" }
        }
      } else if (health.Status === "healthy") {
        return { ok: true, reason: "healthy" }
      } else if (health.Status === "unhealthy") {
        return { ok: false, reason: "unhealthy" }
      }

      await new Promise((resolve) => setTimeout(resolve, 1000))
    }

    return { ok: false, reason: "timeout" }
  }

  async canUpdateContainer(containerName: string): Promise<ContainerUpdateCheck> {
    const container = this.docker.getContainer(containerName)
    const inspect = await container.inspect()
    const imageRef = inspect?.Config?.Image as string
    const localImageId = inspect?.Image as string

    let remoteDigest: string | null = null
    try {
      remoteDigest = await this.digests.getRemoteDigest(imageRef)
    } catch (error: unknown) {
      const status = this.getErrorStatus(error)
      if (status === 401 || status === 403) {
        return {
          container: containerName,
          imageRef,
          localImageId,
          canCheckRemote: false,
          canCheckLocal: true,
          hasUpdate: false,
          reason: "registry_auth_required",
        }
      }

      return {
        container: containerName,
        imageRef,
        localImageId,
        canCheckRemote: false,
        canCheckLocal: true,
        hasUpdate: false,
        reason: "remote_digest_error",
        error: this.getErrorMessage(error),
      }
    }

    if (!remoteDigest) {
      return {
        container: containerName,
        imageRef,
        localImageId,
        canCheckRemote: false,
        canCheckLocal: true,
        hasUpdate: false,
        reason: "remote_digest_not_found",
      }
    }

    let repoDigests: string[] = []
    try {
      const image = this.docker.getImage(localImageId)
      const inspectImage = await image.inspect()
      repoDigests = inspectImage?.RepoDigests ?? []
    } catch (error: unknown) {
      const status = this.getErrorStatus(error)
      if (status === 404) {
        return {
          container: containerName,
          imageRef,
          localImageId,
          remoteDigest,
          repoDigests: [],
          canCheckRemote: true,
          canCheckLocal: false,
          hasUpdate: false,
          reason: "local_image_missing",
        }
      }

      return {
        container: containerName,
        imageRef,
        localImageId,
        remoteDigest,
        repoDigests: [],
        canCheckRemote: true,
        canCheckLocal: false,
        hasUpdate: false,
        reason: "local_digest_error",
        error: this.getErrorMessage(error),
      }
    }

    if (!repoDigests.length) {
      return {
        container: containerName,
        imageRef,
        localImageId,
        remoteDigest,
        repoDigests: [],
        canCheckRemote: true,
        canCheckLocal: false,
        hasUpdate: false,
        reason: "local_repo_digests_empty",
      }
    }

    return {
      container: containerName,
      imageRef,
      localImageId,
      remoteDigest,
      repoDigests,
      canCheckRemote: true,
      canCheckLocal: true,
      hasUpdate: this.hasUpdate(repoDigests, remoteDigest),
      reason: "ok",
    }
  }

  async pullImage(imageRef: string): Promise<PullResult> {
    this.logger.log(`Pulling image: ${imageRef}`)
    const stream = await this.docker.pull(imageRef)

    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(
        stream,
        (err: unknown) => (err ? reject(err) : resolve()),
        (event: ProgressEvent) => {
          if (event?.status) {
            const id = event?.id ? ` (${event.id})` : ""
            const progress = event?.progress ? ` ${event.progress}` : ""
            this.logger.debug(`${event.status}${id}${progress}`)
          }
        },
      )
    })

    let pulledImageId: string | undefined
    try {
      const image = this.docker.getImage(imageRef)
      const inspect = await image.inspect()
      pulledImageId = inspect?.Id
    } catch {
      pulledImageId = undefined
    }

    return { imageRef, pulledImageId }
  }

  hasUpdate(repoDigests: string[], remoteDigest: string): boolean {
    return !repoDigests.some((digest) => digest.includes(remoteDigest))
  }

  async recreateContainerWithImage(
    containerName: string,
    targetImage: string,
    opts?: { force?: boolean; pull?: boolean },
  ): Promise<ContainerUpdateResult> {
    const pullInfo: PullInfo =
      opts?.pull ?? true ? await this.pullImage(targetImage) : { skipped: true }

    const current = this.docker.getContainer(containerName)
    const inspect = await current.inspect()
    const oldContainerId = inspect.Id
    const oldImageRef = inspect.Config.Image
    const oldLocalImageId = inspect.Image
    const networks = inspect?.NetworkSettings?.Networks ?? {}

    const createOptions: ContainerCreateOptions = {
      name: containerName,
      Image: targetImage,
      Env: inspect.Config.Env ?? [],
      Labels: inspect.Config.Labels ?? {},
      ExposedPorts: inspect.Config.ExposedPorts ?? {},
      Cmd: inspect.Config.Cmd ?? undefined,
      Entrypoint: inspect.Config.Entrypoint ?? undefined,
      WorkingDir: inspect.Config.WorkingDir ?? undefined,
      User: inspect.Config.User ?? undefined,
      Hostname: inspect.Config.Hostname ?? undefined,
      Domainname: inspect.Config.Domainname ?? undefined,
      Tty: inspect.Config.Tty ?? undefined,
      OpenStdin: inspect.Config.OpenStdin ?? undefined,
      HostConfig: {
        Binds: inspect.HostConfig.Binds ?? [],
        PortBindings: inspect.HostConfig.PortBindings ?? {},
        RestartPolicy: inspect.HostConfig.RestartPolicy ?? { Name: "no" },
        NetworkMode: inspect.HostConfig.NetworkMode ?? "bridge",
        Privileged: inspect.HostConfig.Privileged ?? false,
        ReadonlyRootfs: inspect.HostConfig.ReadonlyRootfs ?? false,
      },
    }

    const needsStopFirst =
      this.hasHostPorts(createOptions.HostConfig?.PortBindings) ||
      this.hasStaticIps(networks)

    if (needsStopFirst) {
      try {
        await current.stop({ t: 10 })
      } catch {}
    }

    const backupName = `${containerName}__backup__${Date.now()}`
    await current.rename({ name: backupName })
    const created = await this.docker.createContainer(createOptions)

    try {
      await created.start()
      const healthTimeoutMs = Number(process.env.HEALTH_TIMEOUT_MS ?? 60_000)
      const health = await this.waitForHealthy(created, healthTimeoutMs)
      if (!health.ok) {
        throw new Error(`Health-check failed: ${health.reason}`)
      }

      const newInspect = await created.inspect()
      const newLocalImageId = newInspect.Image
      const backup = this.docker.getContainer(backupName)
      try {
        await backup.stop({ t: 10 })
      } catch {}
      await backup.remove({ force: true })

      return {
        status: "success",
        pull: pullInfo,
        old: {
          containerId: oldContainerId,
          imageRef: oldImageRef,
          localImageId: oldLocalImageId,
        },
        new: {
          containerId: newInspect.Id,
          imageRef: targetImage,
          localImageId: newLocalImageId,
        },
        health: health.reason,
        didChangeImageId: oldLocalImageId !== newLocalImageId,
      }
    } catch (error: unknown) {
      try {
        await created.stop({ t: 10 })
      } catch {}
      try {
        await created.remove({ force: true })
      } catch {}

      const backup = this.docker.getContainer(backupName)
      await backup.rename({ name: containerName })

      try {
        await backup.start()
      } catch {}

      return {
        status: "rolled_back",
        pull: pullInfo,
        old: {
          containerId: oldContainerId,
          imageRef: oldImageRef,
          localImageId: oldLocalImageId,
        },
        attemptedImage: targetImage,
        error: this.getErrorMessage(error),
      }
    }
  }

  private getErrorStatus(err: unknown): number | undefined {
    if (!err || typeof err !== "object") return undefined
    const maybe = err as ErrorWithStatus
    return maybe.statusCode ?? maybe.status
  }

  private getErrorMessage(err: unknown): string {
    if (err instanceof Error) return err.message
    if (!err || typeof err !== "object") return String(err)
    const maybe = err as { message?: unknown }
    return typeof maybe.message === "string" ? maybe.message : String(err)
  }
}
