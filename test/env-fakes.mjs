// In-memory driver doubles, so the reconciler can be tested without a container
// runtime. The point is to drive the loop deterministically — tick() is called
// explicitly rather than waiting on a timer.

export function fakeRuntime(opts = {}) {
  const envs = new Map()          // envId -> Set of roles
  const calls = []
  let capacity = { freeMemoryMb: 8192, freeDiskGb: 100, runningEnvs: 0 }
  return {
    calls,
    setCapacity(c) { capacity = { ...capacity, ...c } },
    /** Simulate containers appearing without the store knowing. */
    injectOrphan(envId) { envs.set(envId, new Set(['app'])) },
    async createNetwork(envId) { envs.set(envId, envs.get(envId) ?? new Set()); return `net-${envId}` },
    async run(spec) {
      if (opts.failRole === spec.role) throw new Error(`boom: ${spec.role}`)
      envs.get(spec.envId).add(spec.role)
      calls.push(`run:${spec.role}`)
      return { id: `${spec.envId}-${spec.role}`, hostname: spec.role, ...(spec.publish ? { hostPort: 40000 } : {}) }
    },
    async waitHealthy() {},
    async exec() { return { exitCode: 0, stdout: '', stderr: '' } },
    async putFile() {},
    async logs() { return 'logs' },
    async destroy(envId) { envs.delete(envId); calls.push(`destroy:${envId}`) },
    async listEnvIds() { return [...envs.keys()] },
    async capacity() { return { ...capacity, runningEnvs: envs.size } },
  }
}

export function fakeIngress() {
  const routes = new Map()
  return {
    routes,
    async attach(slug, up) { const u = `http://${slug}.test:8080`; routes.set(slug, up); return u },
    async detach(slug) { routes.delete(slug) },
    async listSlugs() { return [...routes.keys()] },
  }
}

export function fakeImages() {
  return {
    async resolve(ref) { return ref.kind === 'tag' ? ref.tag : 'built:latest' },
    async build() { return 'built:latest' },
    async list() { return [] },
  }
}
