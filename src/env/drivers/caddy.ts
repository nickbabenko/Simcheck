// IngressDriver over the Caddy admin API.
//
// Routes are added and removed through the admin API rather than by rewriting a
// Caddyfile and reloading. Envs churn every few minutes; a config file plus
// reload per env is both slow and a way to take down every route at once when
// one env writes something invalid.

export interface CaddyOptions {
  adminUrl: string
  /** Envs publish at <slug>.<baseDomain>. */
  baseDomain: string
  /** Named server in Caddy's config, created on first use. */
  serverName?: string
  listen?: string[]
  /**
   * TLS is off by default so the prototype runs with no certificate authority
   * involved. Turning it on requires a WILDCARD certificate for *.<baseDomain>:
   * a per-env certificate would be published to Certificate Transparency logs
   * within seconds and make every slug publicly enumerable, which defeats the
   * unguessable URL entirely.
   */
  tls?: { certFile: string; keyFile: string }
}

const ID_PREFIX = 'envcheck-env-'
const CATCHALL_ID = 'envcheck-catchall'

export function createCaddyIngress(opts: CaddyOptions) {
  const admin = opts.adminUrl.replace(/\/$/, '')
  const server = opts.serverName ?? 'envcheck'
  const listen = opts.listen ?? [':8080']

  async function call(method: string, path: string, body?: unknown): Promise<Response> {
    const res = await fetch(`${admin}${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    })
    if (!res.ok && res.status !== 404) {
      throw new Error(`caddy ${method} ${path}: ${res.status} ${await res.text()}`)
    }
    return res
  }

  /**
   * A terminal 404 for every hostname that is not a live env.
   *
   * Caddy has no implicit 404: when no route matches it returns an empty 200.
   * That makes probing indistinguishable from a real env — every guessed
   * hostname comes back "success" — so an explicit catch-all is what turns an
   * unknown slug into a refusal. It must be evaluated last, which is why env
   * routes are inserted at index 0 rather than appended.
   */
  /**
   * POST, not PUT.
   *
   * In Caddy's admin API PUT *creates* and returns 409 if the key already
   * exists, while POST sets-or-replaces. Using PUT here meant the first renewal
   * failed with "key already exists: tls" and the proxy carried on serving the
   * expired certificate — a failure that only becomes visible when every env
   * breaks at once. The same applies on a daemon restart, where the tls app is
   * already configured.
   *
   * Routes live under the http app and are untouched by this, so replacing the
   * certificate does not disturb running envs.
   */
  async function setTlsFiles(t: { certFile: string; keyFile: string }): Promise<void> {
    const certificates = { load_files: [{ certificate: t.certFile, key: t.keyFile }] }

    const existing = await fetch(`${admin}/config/apps/tls`)
    const present = existing.ok && (await existing.json().catch(() => null)) !== null
    if (!present) {
      // PUT, not POST: on a fresh Caddy with an empty config there is no
      // /config/apps to post into, and POST answers
      // "invalid traversal path at: config/apps". PUT creates the intermediate
      // structure.
      await call('PUT', '/config/apps/tls', { certificates })
      return
    }

    // Delete before re-adding. Writing an IDENTICAL config value is a no-op to
    // Caddy — it does not re-read load_files from disk and does not watch them
    // — so after a renewal the paths are unchanged and the expired certificate
    // keeps being served. Measured: a plain POST left the old serial in place;
    // delete-then-add swapped it. This briefly leaves no certificate loaded, so
    // a handshake arriving in that sub-second window fails; that is a better
    // trade than serving an expired certificate until someone restarts Caddy.
    await call('DELETE', '/config/apps/tls/certificates')
    await call('POST', '/config/apps/tls/certificates', certificates)
  }

  const catchAllRoute = {
    '@id': CATCHALL_ID,
    handle: [{ handler: 'static_response', status_code: 404 }],
    terminal: true,
  }

  /** Create the server on first use. Idempotent: an existing server keeps its
   *  live routes, so restarting the daemon does not drop running envs. */
  async function ensureServer(): Promise<void> {
    const res = await fetch(`${admin}/config/apps/http/servers/${server}`)
    if (res.ok && (await res.json().catch(() => null))) {
      // Server exists. Make sure the catch-all is present — an older config, or
      // one written before this existed, would otherwise 200 on every host.
      const existing = await fetch(`${admin}/id/${CATCHALL_ID}`)
      if (!existing.ok) await call('POST', `/config/apps/http/servers/${server}/routes`, catchAllRoute)
      return
    }
    if (opts.tls) {
      // Load the wildcard from disk and turn OFF automatic HTTPS regardless:
      // left on, Caddy would try to issue a per-name certificate for every env
      // hostname, which is both an ACME storm and the CT-log leak the wildcard
      // exists to avoid.
      await setTlsFiles(opts.tls)
    }
    await call('PUT', `/config/apps/http/servers/${server}`, {
      listen,
      routes: [catchAllRoute],
      automatic_https: { disable: true },
      ...(opts.tls ? { tls_connection_policies: [{}] } : {}),
    })
  }

  function urlFor(slug: string): string {
    const scheme = opts.tls ? 'https' : 'http'
    const port = listen[0]?.replace(/^.*:/, '') ?? '80'
    const suffix = port === '80' || port === '443' ? '' : `:${port}`
    return `${scheme}://${slug}.${opts.baseDomain}${suffix}`
  }

  return {
    urlFor,

    async attach(slug: string, upstream: { host: string; port: number }): Promise<string> {
      await ensureServer()
      const hostname = `${slug}.${opts.baseDomain}`
      // Delete-then-add rather than add-only, so re-running attach after a
      // partial failure replaces the route instead of duplicating it.
      await call('DELETE', `/id/${ID_PREFIX}${slug}`)
      // PUT at index 0 inserts; POST would append and land *after* the
      // catch-all, which is terminal and would swallow every env route.
      await call('PUT', `/config/apps/http/servers/${server}/routes/0`, {
        '@id': `${ID_PREFIX}${slug}`,
        match: [{ host: [hostname] }],
        handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: `${upstream.host}:${upstream.port}` }] }],
        terminal: true,
      })
      return urlFor(slug)
    },

    async detach(slug: string): Promise<void> {
      await call('DELETE', `/id/${ID_PREFIX}${slug}`)
    },

    async reloadCert(paths: { certFile: string; keyFile: string }): Promise<void> {
      await setTlsFiles(paths)
    },

    async listSlugs(): Promise<string[]> {
      const res = await fetch(`${admin}/config/apps/http/servers/${server}/routes`)
      if (!res.ok) return []
      const routes = (await res.json().catch(() => [])) as Array<{ '@id'?: string }>
      if (!Array.isArray(routes)) return []
      return routes
        .map((r) => r['@id'])
        .filter((id): id is string => typeof id === 'string' && id.startsWith(ID_PREFIX) && id !== CATCHALL_ID)
        .map((id) => id.slice(ID_PREFIX.length))
    },
  }
}

/** No ingress: the env is reachable on the published host port and nothing else.
 *  Useful for a simulator on the same machine, and for tests. */
export function createNullIngress() {
  const seen = new Map<string, string>()
  return {
    // Without a proxy there is no hostname to hand out ahead of time; the real
    // address is only known once a port has been published.
    urlFor(slug: string): string { return seen.get(slug) ?? `http://127.0.0.1/(unrouted:${slug})` },
    async attach(slug: string, upstream: { host: string; port: number }): Promise<string> {
      const url = `http://${upstream.host}:${upstream.port}`
      seen.set(slug, url)
      return url
    },
    async detach(slug: string): Promise<void> { seen.delete(slug) },
    async listSlugs(): Promise<string[]> { return [...seen.keys()] },
  }
}
