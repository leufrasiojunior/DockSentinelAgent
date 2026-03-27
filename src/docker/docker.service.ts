import { Injectable } from "@nestjs/common"
import Docker from "dockerode"
import type { ContainerDetailsDto } from "./dto/container-details.dto"
import { RecreatePlanDto } from "./dto/recreate-plan.dto"

export type ContainerSummary = {
  id: string
  name: string
  image: string
  state: string
  status: string
  labels: Record<string, string>
}

@Injectable()
export class DockerService {
  private readonly docker = new Docker({ socketPath: "/var/run/docker.sock" })

  async listContainers(): Promise<ContainerSummary[]> {
    const items = await this.docker.listContainers({ all: true })
    return items.map((c) => ({
      id: c.Id,
      name: c.Names?.[0]?.replace(/^\//, "") ?? c.Id.slice(0, 12),
      image: c.Image,
      state: c.State,
      status: c.Status,
      labels: c.Labels ?? {},
    }))
  }

  async getContainerDetails(id: string): Promise<ContainerDetailsDto> {
    const container = this.docker.getContainer(id)
    const info = await container.inspect()
    const name = (info.Name ?? "").replace(/^\//, "") || id.slice(0, 12)
    const env = info.Config?.Env ?? []
    const labels = info.Config?.Labels ?? {}
    const restartPolicy = info.HostConfig?.RestartPolicy
      ? {
          name: info.HostConfig.RestartPolicy.Name,
          maximumRetryCount: info.HostConfig.RestartPolicy.MaximumRetryCount,
        }
      : undefined

    const ports: ContainerDetailsDto["ports"] = []
    const portsMap = info.NetworkSettings?.Ports ?? {}
    for (const containerPort of Object.keys(portsMap)) {
      const bindings = portsMap[containerPort]
      if (!bindings) {
        ports.push({ containerPort })
        continue
      }
      for (const binding of bindings) {
        ports.push({
          containerPort,
          hostIp: binding.HostIp,
          hostPort: binding.HostPort,
        })
      }
    }

    const mounts =
      info.Mounts?.map((mount) => ({
        type: mount.Type,
        source: mount.Source,
        target: mount.Destination,
        readOnly: !mount.RW,
      })) ?? []

    const networks: ContainerDetailsDto["networks"] = []
    const networksMap = info.NetworkSettings?.Networks ?? {}
    for (const netName of Object.keys(networksMap)) {
      const network = networksMap[netName]
      networks.push({
        name: netName,
        ipv4Address: network.IPAddress,
        ipv6Address: network.GlobalIPv6Address,
        macAddress: network.MacAddress,
      })
    }

    return {
      id: info.Id,
      name,
      image: info.Config?.Image ?? "",
      state: info.State?.Status ?? "unknown",
      status: info.State?.Status ?? "unknown",
      env,
      labels,
      restartPolicy,
      ports,
      mounts,
      networks,
    }
  }

  async buildRecreatePlan(id: string): Promise<RecreatePlanDto> {
    const container = this.docker.getContainer(id)
    const info = await container.inspect()
    const name = (info.Name ?? "").replace(/^\//, "") || id.slice(0, 12)
    const env = info.Config?.Env ?? []
    const labels = info.Config?.Labels ?? {}
    const exposedPorts = info.Config?.ExposedPorts ?? {}
    const portBindings = info.HostConfig?.PortBindings ?? {}
    const binds = info.HostConfig?.Binds ?? []
    const restartPolicy = info.HostConfig?.RestartPolicy
      ? {
          Name: info.HostConfig.RestartPolicy.Name,
          MaximumRetryCount: info.HostConfig.RestartPolicy.MaximumRetryCount,
        }
      : undefined

    const networks: RecreatePlanDto["networks"] = []
    const networksMap = info.NetworkSettings?.Networks ?? {}
    for (const netName of Object.keys(networksMap)) {
      const network = networksMap[netName]
      networks.push({
        name: netName,
        ipv4Address: network.IPAddress,
        ipv6Address: network.GlobalIPv6Address,
      })
    }

    return {
      oldId: info.Id,
      name,
      image: info.Config?.Image ?? "",
      env,
      labels,
      exposedPorts,
      portBindings,
      binds,
      restartPolicy,
      networks,
    }
  }
}
