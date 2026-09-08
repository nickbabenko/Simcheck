// Normalising and validating the service map.
//
// One place decides what an environment's services are, what each is called,
// and which hostname each gets — so provisioning, reconciliation and the
// reservation path cannot disagree about it.

import type { EnvSpec, ServiceSpec } from './types.js';

export interface NormalisedService extends ServiceSpec {
  name: string;
  primary: boolean;
}

/** DNS label rules, minus the length allowance the slug already spends. */
const NAME = /^[a-z0-9]([a-z0-9-]{0,20}[a-z0-9])?$/;

/**
 * Turn either spec shape into one list.
 *
 * The single-image shorthand becomes a lone service called "app", so
 * everything downstream handles exactly one case.
 */
export function normaliseServices(spec: EnvSpec): NormalisedService[] {
  const entries = spec.services && Object.keys(spec.services).length
    ? Object.entries(spec.services)
    : spec.image && spec.port
      ? [['app', { image: spec.image, port: spec.port, primary: true }] as [string, ServiceSpec]]
      : [];

  if (!entries.length) throw new Error('an environment needs either image+port or a services map');

  for (const [name] of entries) {
    if (!NAME.test(name)) {
      throw new Error(
        `service name '${name}' is not usable in a hostname; use lowercase letters, digits and hyphens`,
      );
    }
  }

  const flagged = entries.filter(([, svc]) => svc.primary);
  if (entries.length > 1 && flagged.length !== 1) {
    // Guessing here would silently move the bare hostname between deploys,
    // which is the one address most likely to be written down somewhere.
    throw new Error(
      `exactly one service must be marked primary (found ${flagged.length} of ${entries.length}); ` +
      'the primary keeps the bare hostname',
    );
  }

  const primaryName = flagged[0]?.[0] ?? entries[0]![0];
  return entries.map(([name, svc]) => ({ ...svc, name, primary: name === primaryName }));
}

/** Hostname label for one service. Primary keeps the bare slug. */
export function serviceSlug(slug: string, svc: { name: string; primary: boolean }): string {
  return svc.primary ? slug : `${slug}-${svc.name}`;
}

/** Every hostname label an environment occupies, primary first. */
export function allSlugs(slug: string, spec: EnvSpec): string[] {
  return normaliseServices(spec)
    .sort((a, b) => Number(b.primary) - Number(a.primary))
    .map((svc) => serviceSlug(slug, svc));
}

/** Internal address of a service, as seen from inside the environment network. */
export function internalUrl(svc: NormalisedService): string {
  return `http://${svc.name}:${svc.port}`;
}

/** SERVICE_<NAME>_URL for every service, so containers can find each other
 *  without being told the public hostnames. */
export function internalEnv(services: NormalisedService[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const svc of services) {
    out[`SERVICE_${svc.name.replace(/-/g, '_').toUpperCase()}_URL`] = internalUrl(svc);
  }
  return out;
}
