/**
 * Verifies the Cloudflare Access JWT check against forged and malformed tokens.
 * Run with: node --test test/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { CloudflareAccessVerifier, parseCidr, inCidr, isLoopback } from '../dist/edge.js';

const TEAM = 'testteam.cloudflareaccess.com';
const AUD = 'aud-tag-for-this-app';
const ISS = `https://${TEAM}`;

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const attacker = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'test-key-1';

const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };

// Stand in for https://<team>.cloudflareaccess.com/cdn-cgi/access/certs
globalThis.fetch = async (url) => {
  assert.equal(url, `${ISS}/cdn-cgi/access/certs`, 'verifier must fetch the team JWKS');
  return { ok: true, status: 200, json: async () => ({ keys: [jwk] }) };
};

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

function sign(claims, { key = privateKey, kid = KID, alg = 'RS256' } = {}) {
  const head = b64({ alg, kid, typ: 'JWT' });
  const body = b64(claims);
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${body}`).sign(key).toString('base64url');
  return `${head}.${body}.${sig}`;
}

const now = () => Math.floor(Date.now() / 1000);
const baseClaims = (over = {}) => ({ iss: ISS, aud: [AUD], exp: now() + 600, iat: now(), ...over });

const verifier = () => new CloudflareAccessVerifier(TEAM, [AUD], false);
const reqWith = (jwt) => ({ headers: jwt ? { 'cf-access-jwt-assertion': jwt } : {} });
const REMOTE = '203.0.113.9';

async function rejects(t, jwt, why) {
  await assert.rejects(() => verifier().verify(reqWith(jwt), REMOTE), (e) => {
    assert.match(e.constructor.name, /EdgeAuthError/, `expected EdgeAuthError, got ${e.constructor.name}: ${e.message}`);
    return true;
  }, why);
}

test('accepts a service-token JWT and reports it as a machine', async () => {
  const jwt = sign(baseClaims({ common_name: 'abc123.access', sub: '' }));
  const id = await verifier().verify(reqWith(jwt), REMOTE);
  assert.equal(id.subject, 'abc123.access');
  assert.equal(id.service, true);
  assert.equal(id.via, 'cloudflare-access');
});

test('accepts a user JWT and reports it as a person', async () => {
  const jwt = sign(baseClaims({ email: 'nick@example.com', sub: 'user-1' }));
  const id = await verifier().verify(reqWith(jwt), REMOTE);
  assert.equal(id.subject, 'nick@example.com');
  assert.equal(id.service, false);
});

test('rejects a token signed by someone else', async () => {
  await rejects(null, sign(baseClaims({ email: 'a@b.c' }), { key: attacker.privateKey }), 'forged signature must fail');
});

test('rejects a tampered payload', async () => {
  const jwt = sign(baseClaims({ email: 'a@b.c' }));
  const [h, , s] = jwt.split('.');
  const tampered = `${h}.${b64(baseClaims({ email: 'admin@evil.com' }))}.${s}`;
  await rejects(null, tampered, 'payload swap must fail');
});

test('rejects a JWT for a different Access application', async () => {
  await rejects(null, sign(baseClaims({ aud: ['some-other-app'], email: 'a@b.c' })), 'wrong aud must fail');
});

test('rejects a JWT from a different team', async () => {
  await rejects(null, sign(baseClaims({ iss: 'https://evil.cloudflareaccess.com', email: 'a@b.c' })), 'wrong iss must fail');
});

test('rejects an expired JWT', async () => {
  await rejects(null, sign(baseClaims({ exp: now() - 3600, email: 'a@b.c' })), 'expired must fail');
});

test('rejects an algorithm downgrade', async () => {
  const head = b64({ alg: 'none', kid: KID, typ: 'JWT' });
  await rejects(null, `${head}.${b64(baseClaims({ email: 'a@b.c' }))}.`, 'alg:none must fail');
});

test('rejects a missing assertion header', async () => {
  await rejects(null, undefined, 'no header must fail');
});

test('rejects a JWT with neither email nor common_name', async () => {
  await rejects(null, sign(baseClaims({ sub: 'x' })), 'anonymous token must fail');
});

test('loopback is not exempt unless explicitly allowed', async () => {
  await assert.rejects(() => new CloudflareAccessVerifier(TEAM, [AUD], false).verify(reqWith(undefined), '127.0.0.1'));
  const allowed = await new CloudflareAccessVerifier(TEAM, [AUD], true).verify(reqWith(undefined), '127.0.0.1');
  assert.equal(allowed.via, 'loopback');
});

test('CIDR matching', () => {
  const lan = parseCidr('192.168.4.0/24');
  assert.equal(inCidr('192.168.4.50', lan), true);
  assert.equal(inCidr('192.168.5.50', lan), false);
  assert.equal(inCidr('::ffff:192.168.4.50', lan), true, 'v4-mapped v6 must match a v4 CIDR');
  assert.equal(inCidr('not-an-ip', lan), false);

  const single = parseCidr('10.0.0.7');
  assert.equal(inCidr('10.0.0.7', single), true);
  assert.equal(inCidr('10.0.0.8', single), false);

  assert.equal(inCidr('2001:db8::1', parseCidr('2001:db8::/32')), true);
  assert.equal(inCidr('2001:dbf::1', parseCidr('2001:db8::/32')), false);

  assert.throws(() => parseCidr('192.168.1.0/99'));
});

test('loopback detection', () => {
  for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.10.0.1']) assert.equal(isLoopback(a), true, a);
  for (const a of ['192.168.4.5', '10.0.0.1', '8.8.8.8']) assert.equal(isLoopback(a), false, a);
});
