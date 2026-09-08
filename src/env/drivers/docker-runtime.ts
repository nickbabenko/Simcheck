// RuntimeDriver over the Docker Engine API.

import os from 'node:os'
import { statfs } from 'node:fs/promises'
import { Docker, demux, readStream, tarFile } from './docker-http.js'
import { availableMemoryMb } from '../hostmetrics.js'
import { ENV_LABEL, OWNER_LABEL } from './index.js'
import type { Capacity, ContainerHandle, ContainerSpec, ExecResult, RuntimeDriver } from './index.js'

const NAME_PREFIX = 'envcheck'

type InspectResponse = {
  State: { Running: boolean; Status: string; Health?: { Status: string } }
  NetworkSettings: { Ports: Record<string, Array<{ HostPort: string }> | null> }
}

export interface DockerRuntimeOptions {
  dockerHost: string
  /** Path whose free space is reported by capacity(). Defaults to the daemon
   *  host's own filesystem, which is the right answer when the daemon and the
   *  container runtime share a machine — the usual case, and the one where a
   *  full disk is a real failure mode. */
  diskPath?: string
}

export function createDockerRuntime(opts: DockerRuntimeOptions): RuntimeDriver {
  const d = new Docker(opts.dockerHost)
  const diskPath = opts.diskPath ?? os.homedir()

  const labelFilter = (envId?: string) =>
    encodeURIComponent(JSON.stringify({ label: [envId ? `${ENV_LABEL}=${envId}` : ENV_LABEL] }))

  async function pull(image: string): Promise<void> {
    const ref = image.includes(':') ? image : `${image}:latest`
    const [name, tag] = [ref.slice(0, ref.lastIndexOf(':')), ref.slice(ref.lastIndexOf(':') + 1)]
    // Streams progress as newline-delimited JSON; we only care that it finishes.
    await d.raw('POST', `/images/create?fromImage=${encodeURIComponent(name)}&tag=${encodeURIComponent(tag)}`)
  }

  async function inspect(id: string): Promise<InspectResponse> {
    return d.json<InspectResponse>('GET', `/containers/${id}/json`)
  }

  return {
    async createNetwork(envId) {
      const name = `${NAME_PREFIX}-${envId}`
      try {
        await d.json('POST', '/networks/create', {
          Name: name,
          Driver: 'bridge',
          // Each env gets its own bridge, so one env cannot reach another.
          Labels: { [ENV_LABEL]: envId },
        })
      } catch (err) {
        // Idempotent: re-running provisioning after a partial failure must not
        // trip over the network it created last time.
        if (!/already exists|409/i.test(String(err))) throw err
      }
      // The name, not the id, so it can be used as both NetworkMode and the
      // EndpointsConfig key below.
      return name
    },

    async run(spec) {
      // Pull unconditionally: cheap when the image is present, and the failure
      // mode of not pulling is a confusing "no such image" at create time.
      await pull(spec.image)

      const name = `${NAME_PREFIX}-${spec.envId}-${spec.role}`
      const body: Record<string, unknown> = {
        Image: spec.image,
        Env: Object.entries(spec.env ?? {}).map(([k, v]) => `${k}=${v}`),
        Labels: { [ENV_LABEL]: spec.envId, [`${ENV_LABEL}.role`]: spec.role },
        HostConfig: {
          NetworkMode: spec.networkId,
          // Never restart. An env that dies should surface as failed, not
          // silently loop and look healthy-ish while serving nothing.
          RestartPolicy: { Name: 'no' },
          ...(spec.resources?.memoryMb ? { Memory: spec.resources.memoryMb * 1024 * 1024 } : {}),
          ...(spec.resources?.cpus ? { NanoCpus: Math.round(spec.resources.cpus * 1e9) } : {}),
          ...(spec.publish ? { PortBindings: { [`${spec.publish}/tcp`]: [{ HostPort: '' }] } } : {}),
        },
        ...(spec.publish ? { ExposedPorts: { [`${spec.publish}/tcp`]: {} } } : {}),
        ...(spec.cmd ? { Cmd: spec.cmd } : {}),
        // Alias by role, so the app connects to `db:5432` regardless of the
        // generated container name.
        NetworkingConfig: { EndpointsConfig: { [spec.networkId]: { Aliases: [spec.role] } } },
        ...(spec.healthcheck
          ? {
              Healthcheck: {
                Test: spec.healthcheck.test,
                Interval: spec.healthcheck.intervalMs * 1e6,
                Retries: spec.healthcheck.retries,
              },
            }
          : {}),
      }

      let id: string
      try {
        id = (await d.json<{ Id: string }>('POST', `/containers/create?name=${name}`, body)).Id
      } catch (err) {
        // A name collision means a previous attempt got this far. Adopt it
        // rather than failing — that is what makes provisioning re-runnable.
        if (!/already in use|409/i.test(String(err))) throw err
        const existing = await d.json<Array<{ Id: string }>>(
          'GET', `/containers/json?all=true&filters=${encodeURIComponent(JSON.stringify({ name: [name] }))}`,
        )
        if (!existing[0]) throw err
        id = existing[0].Id
      }
      // Starting an already-running container is a 304, not an error.
      await d.raw('POST', `/containers/${id}/start`)

      const handle: ContainerHandle = { id, hostname: spec.role }
      if (spec.publish) {
        const info = await inspect(id)
        const binding = info.NetworkSettings.Ports?.[`${spec.publish}/tcp`]?.[0]
        if (!binding) throw new Error(`container ${name} published no host port for ${spec.publish}`)
        handle.hostPort = Number(binding.HostPort)
      }
      return handle
    },

    /**
     * Wait on the container's own healthcheck when it has one, and on Running
     * otherwise. Polling the daemon beats sleeping a fixed interval: a slow
     * database start is not a failure, and a fast one should not cost a wait.
     */
    async waitHealthy(handle, timeoutMs) {
      const deadline = Date.now() + timeoutMs
      let last = ''
      while (Date.now() < deadline) {
        const info = await inspect(handle.id)
        const health = info.State.Health?.Status
        last = health ?? info.State.Status
        if (health === 'healthy') return
        if (!health && info.State.Running) return
        // Exited before becoming healthy — waiting out the timeout tells the
        // caller nothing they could not learn now.
        if (!info.State.Running && info.State.Status === 'exited') {
          throw new Error(`container ${handle.hostname} exited before becoming healthy`)
        }
        await new Promise((r) => setTimeout(r, 500))
      }
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${handle.hostname} (last state: ${last})`)
    },

    async putFile(handle, dir, name, content) {
      const tar = tarFile(name, content)
      const { status, buf } = await d.raw(
        'PUT', `/containers/${handle.id}/archive?path=${encodeURIComponent(dir)}`, undefined, tar,
      )
      if (status >= 400) throw new Error(`upload ${name}: ${status} ${buf.toString('utf8')}`)
    },

    async exec(handle, cmd) {
      const created = await d.json<{ Id: string }>('POST', `/containers/${handle.id}/exec`, {
        Cmd: cmd,
        AttachStdout: true,
        AttachStderr: true,
      })
      const stream = await d.hijack(`/exec/${created.Id}/start`, { Detach: false, Tty: false })
      const { stdout, stderr } = demux(await readStream(stream))
      const info = await d.json<{ ExitCode: number | null }>('GET', `/exec/${created.Id}/json`)
      return { exitCode: info.ExitCode ?? 0, stdout, stderr } satisfies ExecResult
    },

    async logs(envId, o) {
      const list = await d.json<Array<{ Id: string; Labels: Record<string, string> }>>(
        'GET', `/containers/json?all=true&filters=${labelFilter(envId)}`,
      )
      const wanted = o?.role ? list.filter((c) => c.Labels[`${ENV_LABEL}.role`] === o.role) : list
      const tail = o?.tail ?? 200
      const parts: string[] = []
      for (const c of wanted) {
        const { buf } = await d.raw('GET', `/containers/${c.Id}/logs?stdout=1&stderr=1&tail=${tail}`)
        const { stdout, stderr } = demux(buf)
        parts.push(`--- ${c.Labels[`${ENV_LABEL}.role`] ?? c.Id.slice(0, 12)} ---\n${stdout}${stderr}`)
      }
      return parts.join('\n')
    },

    /** Idempotent by construction: removing what is already gone is a no-op,
     *  and 404s from the daemon are swallowed for exactly that reason. */
    async destroy(envId) {
      const list = await d.json<Array<{ Id: string }>>(
        'GET', `/containers/json?all=true&filters=${labelFilter(envId)}`,
      )
      for (const c of list) {
        // v=1 removes anonymous volumes too, or a churned env leaks disk.
        await d.raw('DELETE', `/containers/${c.Id}?force=1&v=1`)
      }
      const nets = await d.json<Array<{ Id: string }>>('GET', `/networks?filters=${labelFilter(envId)}`)
      for (const n of nets) await d.raw('DELETE', `/networks/${n.Id}`)
    },

    async runningEnvIds() {
      // No all=true: the daemon then returns only running containers.
      const list = await d.json<Array<{ Labels: Record<string, string> }>>(
        'GET', `/containers/json?filters=${labelFilter()}`,
      )
      return [...new Set(list.map((c) => c.Labels[ENV_LABEL]).filter((v): v is string => Boolean(v)))]
    },

    async listEnvIds() {
      const list = await d.json<Array<{ Labels: Record<string, string> }>>(
        'GET', `/containers/json?all=true&filters=${labelFilter()}`,
      )
      return [...new Set(list.map((c) => c.Labels[ENV_LABEL]).filter((v): v is string => Boolean(v)))]
    },

    async capacity(): Promise<Capacity> {
      const ids = await this.listEnvIds()
      let freeDiskGb = Number.POSITIVE_INFINITY
      try {
        const fs = await statfs(diskPath)
        freeDiskGb = (fs.bavail * fs.bsize) / 1024 ** 3
      } catch {
        // Unknown free space must not read as "none available" — that would
        // refuse every provision on a platform where statfs is unavailable.
      }
      return { freeMemoryMb: await availableMemoryMb(), freeDiskGb, runningEnvs: ids.length }
    },
  }
}

export { OWNER_LABEL }
