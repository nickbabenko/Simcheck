// Bridge between simcheck's capability-scoped Identity and the env subsystem's
// Principal.
//
// The env code was written against its own auth model. Rather than rewrite it,
// this maps one onto the other in a single place — so there is exactly one
// answer to "which simcheck capability lets you do this", and it lives next to
// the capability list rather than being spread through the service.

import { NotFoundError } from './errors.js';
import type { Capability, Identity } from '../auth.js';

export type Scope = 'env:read' | 'env:write' | 'env:exec' | 'admin';

export interface Principal {
  tokenId: string;
  ownerId: string;
  scopes: Scope[];
}

export class ForbiddenError extends Error {}

const CAPABILITY_TO_SCOPE: Array<[Capability, Scope]> = [
  ['envs:read', 'env:read'],
  ['envs:write', 'env:write'],
  ['envs:exec', 'env:exec'],
];

/**
 * Tenancy is by token *name*, not token id.
 *
 * Rotating a token should not orphan the envs it created — a new token issued
 * to the same name still sees them, which is what someone rotating a credential
 * expects. Two different people must therefore not share a token name.
 */
export function toPrincipal(who: Identity): Principal {
  const scopes = CAPABILITY_TO_SCOPE
    .filter(([cap]) => who.capabilities.includes(cap))
    .map(([, scope]) => scope);
  return { tokenId: who.id, ownerId: who.name, scopes };
}

export function requireScope(p: Principal, scope: Scope): void {
  if (p.scopes.includes('admin') || p.scopes.includes(scope)) return;
  throw new ForbiddenError(`token lacks required scope '${scope}'`);
}

/** Admin sees every tenant; everyone else sees only their own. */
export function assertOwns(p: Principal, ownerId: string): void {
  if (p.scopes.includes('admin') || p.ownerId === ownerId) return;
  // NotFound, not Forbidden, and deliberately the same message a missing env
  // produces. A 403 here would confirm the id exists.
  throw new NotFoundError('no such env');
}

/** Used when the daemon acts on its own behalf, e.g. the reconciler. */
export const SYSTEM_PRINCIPAL: Principal = { tokenId: 'system', ownerId: 'system', scopes: ['admin'] };
