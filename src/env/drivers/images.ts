// ImageDriver.
//
// With no registry configured this is nearly a no-op: the image was built by the
// same daemon that will run it, so there is nothing to move. Configure a
// registry and the same driver tags and pushes — which is the whole reason the
// seam exists, since the moment the build host and run host differ the image has
// to travel.

import { Docker } from './docker-http.js'
import type { ImageDriver } from './index.js'
import type { ImageRef } from '../types.js'

export interface ImageOptions {
  dockerHost: string
  /** e.g. "localhost:5000" or "registry.example.com/team". Absent = local only. */
  registryUrl?: string | undefined
  /** Base64 X-Registry-Auth payload. An empty credential set is correct for an
   *  unauthenticated registry; the header must still be present or the daemon
   *  will not attempt the push at all. */
  registryAuth?: string | undefined
}

const encodeAuth = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64')

/** Split "repo:tag" on the LAST colon, so a registry host with a port —
 *  localhost:5000/app — is not mistaken for a tag separator. */
export function splitRef(ref: string): { repo: string; tag: string } {
  const slash = ref.lastIndexOf('/')
  const colon = ref.lastIndexOf(':')
  if (colon > slash) return { repo: ref.slice(0, colon), tag: ref.slice(colon + 1) }
  return { repo: ref, tag: 'latest' }
}

export function createImageDriver(opts: ImageOptions): ImageDriver {
  const d = new Docker(opts.dockerHost)
  const auth = opts.registryAuth ?? encodeAuth({})

  async function tagInto(source: string, target: string): Promise<void> {
    const { repo, tag } = splitRef(target)
    await d.json('POST', `/images/${encodeURIComponent(source)}/tag?repo=${encodeURIComponent(repo)}&tag=${encodeURIComponent(tag)}`)
  }

  async function push(ref: string): Promise<void> {
    const { repo, tag } = splitRef(ref)
    const { buf, status } = await d.raw(
      'POST',
      `/images/${encodeURIComponent(repo)}/push?tag=${encodeURIComponent(tag)}`,
      undefined,
      undefined,
      { 'X-Registry-Auth': auth },
    )
    const out = buf.toString('utf8')
    // The daemon streams NDJSON and reports push failures inside a 200 response,
    // so the status code alone does not tell you whether the layers landed.
    if (status >= 400) throw new Error(`push ${ref} failed: ${status} ${out.slice(0, 400)}`)
    const bad = out.split('\n').find((l) => l.includes('"errorDetail"') || l.includes('"error"'))
    if (bad) throw new Error(`push ${ref} failed: ${bad.slice(0, 400)}`)
  }

  return {
    async resolve(ref: ImageRef): Promise<string> {
      switch (ref.kind) {
        case 'tag':
          return ref.tag
        case 'registry':
          return ref.ref
        case 'build':
          return this.build(ref.contextTar, {
            ...(ref.dockerfile ? { dockerfile: ref.dockerfile } : {}),
            ...(ref.buildArgs ? { buildArgs: ref.buildArgs } : {}),
            tag: `envcheck/build:${Date.now().toString(36)}`,
          })
      }
    },

    async build(contextTar, o) {
      const { readFile } = await import('node:fs/promises')
      const tar = Buffer.isBuffer(contextTar) ? contextTar : await readFile(contextTar)
      const q = new URLSearchParams({ t: o.tag, rm: '1' })
      if (o.dockerfile) q.set('dockerfile', o.dockerfile)
      if (o.buildArgs) q.set('buildargs', JSON.stringify(o.buildArgs))

      const { buf, status } = await d.raw('POST', `/build?${q}`, undefined, tar)
      const output = buf.toString('utf8')
      if (status >= 400) throw new Error(`build failed: ${status} ${output.slice(0, 600)}`)
      const errLine = output.split('\n').find((l) => l.includes('"errorDetail"'))
      if (errLine) throw new Error(`build failed: ${errLine.slice(0, 600)}`)

      if (!opts.registryUrl) return o.tag

      // Build host and run host may differ: publish so the runtime can pull it.
      const remote = `${opts.registryUrl.replace(/\/$/, '')}/${o.tag}`
      await tagInto(o.tag, remote)
      await push(remote)
      return remote
    },

    async list() {
      const images = await d.json<Array<{ RepoTags: string[] | null; Size: number; Created: number }>>(
        'GET', '/images/json',
      )
      return images.flatMap((i) =>
        (i.RepoTags ?? []).filter((t) => t !== '<none>:<none>').map((tag) => ({
          tag, sizeBytes: i.Size, createdAt: i.Created * 1000,
        })),
      )
    },
  }
}
