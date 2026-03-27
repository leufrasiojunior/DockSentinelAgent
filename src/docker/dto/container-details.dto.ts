export type ContainerPortBinding = {
  containerPort: string
  hostIp?: string
  hostPort?: string
}

export type ContainerMount = {
  type: string
  source?: string
  target: string
  readOnly: boolean
}

export type ContainerNetwork = {
  name: string
  ipv4Address?: string
  ipv6Address?: string
  macAddress?: string
}

export type RestartPolicyDto = {
  name: string
  maximumRetryCount?: number
}

export type ContainerDetailsDto = {
  id: string
  name: string
  image: string
  state: string
  status: string
  env: string[]
  labels: Record<string, string>
  restartPolicy?: RestartPolicyDto
  ports: ContainerPortBinding[]
  mounts: ContainerMount[]
  networks: ContainerNetwork[]
}
