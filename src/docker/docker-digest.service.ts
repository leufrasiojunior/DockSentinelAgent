import { Inject, Injectable, Logger } from "@nestjs/common"
import Docker from "dockerode"
import { DOCKER_CLIENT } from "./docker.constants"

type DistributionDescriptor = { Digest?: string; digest?: string }
type DistributionResponse = { Descriptor?: DistributionDescriptor }
type ErrorWithStatus = { statusCode?: number; status?: number; message?: string }

@Injectable()
export class DockerDigestService {
  private readonly logger = new Logger(DockerDigestService.name)

  constructor(@Inject(DOCKER_CLIENT) private readonly docker: Docker) {}

  async getRemoteDigest(imageRef: string): Promise<string | null> {
    const encoded = encodeURIComponent(imageRef)
    const path = `/distribution/${encoded}/json`

    let data: unknown
    try {
      data = await this.dialEngineJson(path)
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

  private dialEngineJson(path: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.docker.modem.dial(
        {
          method: "GET",
          path,
          statusCodes: {
            200: true,
            404: "not found",
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
