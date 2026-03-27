export type RecreatePlanDto = {
  oldId: string
  name: string
  image: string
  env: string[]
  labels: Record<string, string>
  exposedPorts: Record<string, {}>
  portBindings: Record<string, Array<{ HostIp?: string; HostPort?: string }>>
  binds: string[]
  restartPolicy?: {
    Name: string
    MaximumRetryCount?: number
  }
  networks: Array<{
    name: string
    ipv4Address?: string
    ipv6Address?: string
  }>
}
