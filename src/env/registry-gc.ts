// Registry retention.
//
// Pushed images accumulate forever otherwise. The policy mirrors the build
// server's: keep the newest N per repository, drop the rest.
//
// Two things about the registry API make this less obvious than it looks:
//
//  1. Deletion is by *digest*, not by tag, and several tags can point at one
//     digest. Deleting a digest removes every tag on it — so a digest may only
//     be deleted when none of its tags are being kept.
//  2. Deleting a manifest only unlinks it. Reclaiming disk needs the registry's
//     own `garbage-collect` pass, which is a separate, registry-side operation.

const MANIFEST_ACCEPT = [
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.oci.image.index.v1+json',
].join(', ')

export interface TagInfo {
  tag: string
  digest: string
  /** Image creation time from the config blob; undefined if undeterminable. */
  createdAt?: number
}

export interface GcPlan {
  repository: string
  keep: TagInfo[]
  /** Digests safe to delete: every tag on them is being dropped. */
  deleteDigests: string[]
  /** Tags dropped from the index but whose digest is pinned by a kept tag. */
  retainedBySharedDigest: string[]
}

export interface GcResult {
  plans: GcPlan[]
  deleted: number
  failures: Array<{ repository: string; digest: string; error: string }>
}

async function api(base: string, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${base.replace(/\/$/, '')}${path}`, init)
}

export async function listRepositories(base: string): Promise<string[]> {
  const res = await api(base, '/v2/_catalog?n=1000')
  if (!res.ok) throw new Error(`catalog: ${res.status} ${await res.text()}`)
  return ((await res.json()) as { repositories?: string[] }).repositories ?? []
}

export async function listTags(base: string, repo: string): Promise<string[]> {
  const res = await api(base, `/v2/${repo}/tags/list`)
  if (res.status === 404) return []
  if (!res.ok) throw new Error(`tags ${repo}: ${res.status}`)
  return ((await res.json()) as { tags?: string[] | null }).tags ?? []
}

export async function describeTag(base: string, repo: string, tag: string): Promise<TagInfo | undefined> {
  const res = await api(base, `/v2/${repo}/manifests/${tag}`, { headers: { Accept: MANIFEST_ACCEPT } })
  if (!res.ok) return undefined
  const digest = res.headers.get('docker-content-digest')
  if (!digest) return undefined

  const manifest = (await res.json()) as { config?: { digest?: string } }
  const info: TagInfo = { tag, digest }

  // A manifest list has no config blob of its own; leaving createdAt undefined
  // is honest, and the sort below keeps such tags rather than guessing.
  const configDigest = manifest.config?.digest
  if (configDigest) {
    const blob = await api(base, `/v2/${repo}/blobs/${configDigest}`)
    if (blob.ok) {
      const created = ((await blob.json()) as { created?: string }).created
      const t = created ? Date.parse(created) : NaN
      if (!Number.isNaN(t)) info.createdAt = t
    }
  }
  return info
}

/**
 * Decide what to drop, without deleting anything.
 *
 * Tags whose age cannot be determined sort as newest and are kept. Deleting
 * something we cannot reason about is the wrong default for an operation with
 * no undo.
 */
export function planRepository(repository: string, tags: TagInfo[], keepPerRepo: number): GcPlan {
  const sorted = [...tags].sort((a, b) => (b.createdAt ?? Infinity) - (a.createdAt ?? Infinity))
  const keep = sorted.slice(0, keepPerRepo)
  const drop = sorted.slice(keepPerRepo)

  const keptDigests = new Set(keep.map((t) => t.digest))
  const deleteDigests: string[] = []
  const retainedBySharedDigest: string[] = []
  for (const t of drop) {
    if (keptDigests.has(t.digest)) {
      // Deleting this digest would take a kept tag with it.
      retainedBySharedDigest.push(t.tag)
    } else if (!deleteDigests.includes(t.digest)) {
      deleteDigests.push(t.digest)
    }
  }
  return { repository, keep, deleteDigests, retainedBySharedDigest }
}

export interface GcOptions {
  registryUrl: string
  keepPerRepo: number
  /** Plan only. Worth defaulting to on for anything destructive. */
  dryRun?: boolean
}

export async function garbageCollect(o: GcOptions): Promise<GcResult> {
  const plans: GcPlan[] = []
  const failures: GcResult['failures'] = []
  let deleted = 0

  for (const repo of await listRepositories(o.registryUrl)) {
    const tags = (await Promise.all(
      (await listTags(o.registryUrl, repo)).map((t) => describeTag(o.registryUrl, repo, t)),
    )).filter((t): t is TagInfo => Boolean(t))

    const plan = planRepository(repo, tags, o.keepPerRepo)
    plans.push(plan)
    if (o.dryRun) continue

    for (const digest of plan.deleteDigests) {
      const res = await api(o.registryUrl, `/v2/${repo}/manifests/${digest}`, { method: 'DELETE' })
      if (res.ok || res.status === 202) {
        deleted++
      } else {
        // 405 is the registry telling you deletion is switched off entirely —
        // worth surfacing verbatim rather than as a generic failure count.
        const detail = res.status === 405
          ? 'registry has deletion disabled (set REGISTRY_STORAGE_DELETE_ENABLED=true)'
          : `${res.status} ${(await res.text()).slice(0, 200)}`
        failures.push({ repository: repo, digest, error: detail })
      }
    }
  }
  return { plans, deleted, failures }
}
