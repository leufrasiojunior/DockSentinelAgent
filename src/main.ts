import { Logger } from "@nestjs/common"
import { NestFactory } from "@nestjs/core"
import Docker from "dockerode"
import { AppModule } from "./app.module"

type ContainerListItem = {
  Id: string
  Image?: string
  Names?: string[]
  Labels?: Record<string, string>
}

type ConflictMatch = {
  reason: "label" | "container_name" | "image_name"
  matched: string
}

const DEFAULT_PORT = 45873
const KNOWN_SERVER_IMAGE_REFS = new Set([
  "docksentinel",
  "leufrasiojunior/docksentinel",
  "docker.io/leufrasiojunior/docksentinel",
  "index.docker.io/leufrasiojunior/docksentinel",
])

function resolvePort() {
  const raw = Number(process.env.PORT ?? DEFAULT_PORT)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PORT
}

function getAppVersion() {
  return process.env.APP_VERSION ?? process.env.npm_package_version ?? "dev"
}

function normalizeImageReference(image?: string) {
  const lower = String(image ?? "").trim().toLowerCase()
  if (!lower) return ""

  const withoutDigest = lower.split("@", 1)[0] ?? lower
  const lastSlash = withoutDigest.lastIndexOf("/")
  const lastColon = withoutDigest.lastIndexOf(":")

  if (lastColon > lastSlash) {
    return withoutDigest.slice(0, lastColon)
  }

  return withoutDigest
}

function findServerConflict(container: ContainerListItem): ConflictMatch | null {
  const image = String(container.Image ?? "").toLowerCase()
  const labels = container.Labels ?? {}
  const names = (container.Names ?? []).map((name) =>
    name.replace(/^\//, "").toLowerCase(),
  )

  if (labels["com.docksentinel.role"] === "server") {
    return {
      reason: "label",
      matched: "com.docksentinel.role=server",
    }
  }

  const matchingName = names.find((name) => {
    if (name.includes("agent")) return false
    if (name === "docksentinel") return true
    return /(^|[-_])docksentinel(?:[-_]\d+)?$/.test(name)
  })
  if (matchingName) {
    return {
      reason: "container_name",
      matched: matchingName,
    }
  }

  const normalizedImage = normalizeImageReference(image)
  if (KNOWN_SERVER_IMAGE_REFS.has(normalizedImage)) {
    return {
      reason: "image_name",
      matched: normalizedImage,
    }
  }

  return null
}

async function assertNoDockSentinelServerConflict(logger: Logger) {
  const docker = new Docker({ socketPath: "/var/run/docker.sock" })
  const containers = (await docker.listContainers({ all: true })) as ContainerListItem[]
  const conflicts = containers
    .map((container) => ({
      container,
      match: findServerConflict(container),
    }))
    .filter(
      (
        item,
      ): item is {
        container: ContainerListItem
        match: ConflictMatch
      } => item.match !== null,
    )

  if (conflicts.length === 0) {
    return
  }

  for (const conflict of conflicts) {
    const name = conflict.container.Names?.[0]?.replace(/^\//, "") ?? "unknown"
    const image = conflict.container.Image ?? "unknown"
    const id = conflict.container.Id?.slice(0, 12) ?? "unknown"
    logger.error(
      `DockSentinel server detected on this host. reason=${conflict.match.reason} matched=${conflict.match.matched} container_name=${name} image=${image} id=${id}`,
    )
  }

  throw new Error(
    "DockSentinel agent cannot run on a host that already has DockSentinel server installed. Exiting with code 1.",
  )
}

async function bootstrap() {
  const logger = new Logger("AgentBootstrap")
  await assertNoDockSentinelServerConflict(logger)

  const app = await NestFactory.create(AppModule, { bufferLogs: true })
  app.enableShutdownHooks()
  app.enableCors({
    origin: true,
    credentials: false,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type"],
  })

  const port = resolvePort()
  await app.listen(port)

  logger.log(`DockSentinel agent ${getAppVersion()} listening on http://0.0.0.0:${port}`)
}

bootstrap().catch((error) => {
  const logger = new Logger("AgentBootstrap")
  logger.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
