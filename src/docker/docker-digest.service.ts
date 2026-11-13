import { Inject, Injectable, Logger } from "@nestjs/common"
import Docker from "dockerode"
import { DOCKER_CLIENT } from "./docker.constants"
import {
  type DockerAuthConfig,
  encodeDockerRegistryAuthHeader,
} from "./registry-auth.util"

type DistributionDescriptor = { Digest?: string; digest?: string }
type DistributionResponse = { Descriptor?: DistributionDescriptor }
type ErrorWithStatus = { statusCode?: number; status?: number; message?: string }

const DIGEST_CACHE_TTL_MS = 90_000
const RATE_LIMIT_BACKOFF_MS = 1_500

@Injectable()
export class DockerDigestService {
  private readonly logger = new Logger(DockerDigestService.name)
  private readonly cache = new Map<string, { digest: string | null; expiresAt: number }>()
  private readonly inFlight = new Map<string, Promise<string | null>>()

  constructor(@Inject(DOCKER_CLIENT) private readonly docker: Docker) {}

  invalidate(imageRef: string): void {
    const prefix = `${imageRef.trim()}::`
    for (const key of this.cache.keys()) {
      if (key === imageRef.trim() || key.startsWith(prefix)) {
        this.cache.delete(key)
      }
    }
  }

  async getRemoteDigest(
    imageRef: string,
    authConfig?: DockerAuthConfig,
  ): Promise<string | null> {
    const cacheKey = `${imageRef.trim()}::${authConfig?.username ?? "anon"}`
    const now = Date.now()
    const cached = this.cache.get(cacheKey)
    if (cached && cached.expiresAt > now) {
      return cached.digest
    }

    const existingInFlight = this.inFlight.get(cacheKey)
    if (existingInFlight) {
      return existingInFlight
    }

    const promise = this.fetchRemoteDigest(imageRef, authConfig)
      .then((digest) => {
        this.cache.set(cacheKey, {
          digest,
          expiresAt: Date.now() + DIGEST_CACHE_TTL_MS,
        })
        return digest
      })
      .finally(() => {
        this.inFlight.delete(cacheKey)
      })

    this.inFlight.set(cacheKey, promise)
    return promise
  }

  private async fetchRemoteDigest(
    imageRef: string,
    authConfig?: DockerAuthConfig,
  ): Promise<string | null> {
    const encoded = encodeURIComponent(imageRef)
    const path = `/distribution/${encoded}/json`

    let data: unknown
    try {
      data = await this.dialEngineJsonWithRetry(path, authConfig)
    } catch (err: unknown) {
      const status = this.getErrorStatus(err)
      if (status === 404) {
        this.logger.warn(`Distribution not found for ${imageRef} (404)`)
        return null
      }
      throw err
    }

    const digest = this.extractDigest(data)
    if (!digest) {
      throw new Error(`Remote digest not found for imageRef=${imageRef}`)
    }
    return digest
  }

  private async dialEngineJsonWithRetry(
    path: string,
    authConfig?: DockerAuthConfig,
  ): Promise<unknown> {
    try {
      return await this.dialEngineJson(path, authConfig)
    } catch (err: unknown) {
      const status = this.getErrorStatus(err)
      if (status === 429) {
        this.logger.warn(`Rate limited (429) querying ${path}, retrying once after backoff...`)
        await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_BACKOFF_MS))
        return await this.dialEngineJson(path, authConfig)
      }
      throw err
    }
  }

  private dialEngineJson(
    path: string,
    authConfig?: DockerAuthConfig,
  ): Promise<unknown> {
    const authHeader = authConfig
      ? encodeDockerRegistryAuthHeader(authConfig)
      : undefined

    return new Promise((resolve, reject) => {
      this.docker.modem.dial(
        {
          method: "GET",
          path,
          ...(authHeader
            ? {
                headers: { "X-Registry-Auth": authHeader },
                authconfig: authConfig,
              }
            : {}),
          statusCodes: {
            200: true,
            401: "unauthorized",
            403: "forbidden",
            404: "not found",
            429: "too many requests",
          },
        },
        (err: unknown, body: unknown) => {
          if (err) return reject(err)
          try {
            resolve(typeof body === "string" ? JSON.parse(body) : body)
          } catch (error) {
            reject(error)
          }
        },
      )
    })
  }

  private extractDigest(data: unknown): string | null {
    if (!data || typeof data !== "object") return null
    const maybe = data as DistributionResponse
    const digest = maybe.Descriptor?.digest ?? maybe.Descriptor?.Digest
    return typeof digest === "string" ? digest : null
  }

  private getErrorStatus(err: unknown): number | undefined {
    if (!err || typeof err !== "object") return undefined
    const maybe = err as ErrorWithStatus
    return maybe.statusCode ?? maybe.status
  }
}
