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

const DEFAULT_PORT = 45873

function resolvePort() {
  const raw = Number(process.env.PORT ?? DEFAULT_PORT)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PORT
}

function getAppVersion() {
  return process.env.APP_VERSION ?? process.env.npm_package_version ?? "dev"
}

function isServerConflict(container: ContainerListItem) {
  const image = String(container.Image ?? "").toLowerCase()
  const labels = container.Labels ?? {}
  const names = (container.Names ?? []).map((name) =>
    name.replace(/^\//, "").toLowerCase(),
  )

  if (labels["com.docksentinel.role"] === "server") {
    return true
  }

  const hasServerName = names.some((name) => {
    if (name.includes("agent")) return false
    return name === "docksentinel" || name.startsWith("docksentinel-")
  })
  if (hasServerName) return true

  if (image.includes("docksentinel") && !image.includes("docksentinel-agent")) {
    return true
  }

  return false
}

async function assertNoDockSentinelServerConflict(logger: Logger) {
  const docker = new Docker({ socketPath: "/var/run/docker.sock" })
  const containers = (await docker.listContainers({ all: true })) as ContainerListItem[]
  const conflicts = containers.filter(isServerConflict)

  if (conflicts.length === 0) {
    return
  }

  for (const conflict of conflicts) {
    const name = conflict.Names?.[0]?.replace(/^\//, "") ?? "unknown"
    const image = conflict.Image ?? "unknown"
    const id = conflict.Id?.slice(0, 12) ?? "unknown"
    logger.error(
      `DockSentinel server detected on this host. Conflict container name=${name} image=${image} id=${id}`,
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
