export type RegistryAuthEntry = {
  serveraddress: string
  username: string
  password: string
}

export type DockerAuthConfig = {
  username: string
  password: string
  serveraddress: string
}

const DOCKER_HUB_ALIASES = new Set([
  "docker.io",
  "index.docker.io",
  "registry-1.docker.io",
  "registry.hub.docker.com",
  "hub.docker.com",
])

export function normalizeServerAddress(raw: string): string {
  let cleaned = (raw ?? "").trim().toLowerCase()
  cleaned = cleaned.replace(/^https?:\/\//, "")
  cleaned = cleaned.replace(/\/v[12]\/?$/, "")
  cleaned = cleaned.replace(/\/+$/, "")
  if (!cleaned || DOCKER_HUB_ALIASES.has(cleaned)) {
    return "index.docker.io"
  }
  return cleaned
}

export function extractRegistryFromImage(imageRef: string): string {
  const trimmed = (imageRef ?? "").trim()
  if (!trimmed) return "index.docker.io"

  const withoutDigest = trimmed.split("@")[0] ?? trimmed
  const slashIndex = withoutDigest.indexOf("/")
  if (slashIndex === -1) {
    return "index.docker.io"
  }

  const firstSegment = withoutDigest.slice(0, slashIndex).toLowerCase()
  const isExplicitDomain =
    firstSegment.includes(".") ||
    firstSegment.includes(":") ||
    firstSegment === "localhost"

  if (!isExplicitDomain) {
    return "index.docker.io"
  }

  return normalizeServerAddress(firstSegment)
}

export function matchRegistryAuth(
  imageRef: string,
  entries?: RegistryAuthEntry[],
): DockerAuthConfig | undefined {
  if (!entries || entries.length === 0) return undefined

  const targetRegistry = extractRegistryFromImage(imageRef)
  let matched = entries.find(
    (entry) => normalizeServerAddress(entry.serveraddress) === targetRegistry,
  )

  // LinuxServer.io (lscr.io) redirects to ghcr.io; allow ghcr.io credentials as fallback
  if (!matched && targetRegistry === "lscr.io") {
    matched = entries.find(
      (entry) => normalizeServerAddress(entry.serveraddress) === "ghcr.io",
    )
  }

  if (!matched || !matched.username || !matched.password) {
    return undefined
  }

  return {
    username: matched.username,
    password: matched.password,
    serveraddress:
      targetRegistry === "index.docker.io"
        ? "https://index.docker.io/v1/"
        : targetRegistry,
  }
}

export function encodeDockerRegistryAuthHeader(auth: DockerAuthConfig): string {
  return Buffer.from(JSON.stringify(auth), "utf8").toString("base64")
}

export function decodeAgentRegistryAuthHeader(
  headerValue?: string | string[],
): RegistryAuthEntry[] {
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue
  if (!raw || !raw.trim()) return []

  try {
    const json = Buffer.from(raw.trim(), "base64").toString("utf8")
    const parsed: unknown = JSON.parse(json)
    const items = Array.isArray(parsed) ? parsed : [parsed]
    return items.filter((item): item is RegistryAuthEntry => {
      if (!item || typeof item !== "object") return false
      const candidate = item as Record<string, unknown>
      return (
        typeof candidate.serveraddress === "string" &&
        typeof candidate.username === "string" &&
        typeof candidate.password === "string"
      )
    })
  } catch {
    return []
  }
}
