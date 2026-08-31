/**
 * End-to-end test of the remote MCP OAuth flow, including the attacks it must
 * refuse. Spawns its own server against a throwaway SIM_HARNESS_HOME.
 *
 * Run with: npm test
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const PORT = 8000 + (process.pid % 1000);
const BASE = `http://localhost:${PORT}`;
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-oauth-'));
const REDIRECT = 'http://localhost:9999/cb';
const env = { ...process.env, SIM_HARNESS_HOME: HOME, SIM_HARNESS_PUBLIC_URL: BASE, SIM_HARNESS_REMOTE_PORT: String(PORT) };

let server;

before(async () => {
  server = spawn(process.execPath, ['dist/mcp-remote.js'], { env, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try { await fetch(`${BASE}/health`); return; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error('remote MCP server did not start');
});

after(() => {
  server?.kill();
  fs.rmSync(HOME, { recursive: true, force: true });
});

const pin = () => execFileSync(process.execPath, ['dist/cli.js', 'pair'], { encoding: 'utf8', env }).trim();
const form = (o) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o) });

async function registerClient() {
  const res = await fetch(`${BASE}/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'test', redirect_uris: [REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'], token_endpoint_auth_method: 'none',
    }),
  });
  return res.json();
}

/** Drive authorize -> consent -> code, returning the authorization code. */
async function authorize(clientId, challenge, { state = '', code = null } = {}) {
  const url = `${BASE}/authorize?response_type=code&client_id=${clientId}`
    + `&redirect_uri=${encodeURIComponent(REDIRECT)}`
    + `&code_challenge=${challenge}&code_challenge_method=S256&state=${state}`;
  const ticket = (await (await fetch(url)).text()).match(/name="ticket" value="([^"]+)"/)?.[1];
  const res = await fetch(`${BASE}/oauth/approve`, { ...form({ ticket, pairing: code ?? pin(), state }), redirect: 'manual' });
  return { res, ticket };
}

const pkce = () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
};

const mcp = (body, headers = {}) => fetch(`${BASE}/mcp`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }),
});
const INIT = { method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } };

/* ------------------------------------------------------------- discovery -- */

test('publishes authorization server metadata', async () => {
  const m = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  assert.equal(m.issuer, `${BASE}/`);
  assert.ok(m.code_challenge_methods_supported.includes('S256'), 'PKCE S256 must be advertised');
});

test('publishes protected resource metadata', async () => {
  const m = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(m.resource, `${BASE}/mcp`);
});

/* ------------------------------------------------------------- authorize -- */

test('registers a client dynamically', async () => {
  assert.ok((await registerClient()).client_id);
});

test('consent page never reveals the pairing code', async () => {
  const { client_id } = await registerClient();
  pin();
  const url = `${BASE}/authorize?response_type=code&client_id=${client_id}`
    + `&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${pkce().challenge}&code_challenge_method=S256`;
  const page = (await (await fetch(url)).text()).replace(/placeholder="[^"]*"/g, '');
  assert.ok(!/[A-Z0-9]{4}-[A-Z0-9]{4}/.test(page), 'a code appeared in the consent HTML');
});

test('rejects a wrong pairing code', async () => {
  const { client_id } = await registerClient();
  pin();
  const { res } = await authorize(client_id, pkce().challenge, { code: 'AAAA-BBBB' });
  assert.equal(res.status, 400);
});

test('a correct pairing code yields an authorization code and echoes state', async () => {
  const { client_id } = await registerClient();
  const { res } = await authorize(client_id, pkce().challenge, { state: 'xyz' });
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.get('location'));
  assert.ok(loc.searchParams.get('code'));
  assert.equal(loc.searchParams.get('state'), 'xyz');
});

test('a pairing code is single use', async () => {
  const { client_id } = await registerClient();
  const code = pin();
  const first = await authorize(client_id, pkce().challenge, { code });
  assert.equal(first.res.status, 302);
  const second = await authorize(client_id, pkce().challenge, { code });
  assert.equal(second.res.status, 400, 'the same pairing code worked twice');
});

/* ----------------------------------------------------------------- token -- */

async function tokenFor(clientId, verifier, challenge) {
  const { res } = await authorize(clientId, challenge);
  const code = new URL(res.headers.get('location')).searchParams.get('code');
  return {
    code,
    tokens: await (await fetch(`${BASE}/token`, form({
      grant_type: 'authorization_code', code, client_id: clientId,
      redirect_uri: REDIRECT, code_verifier: verifier,
    }))).json(),
  };
}

test('rejects a token exchange with the wrong PKCE verifier', async () => {
  const { client_id } = await registerClient();
  const { challenge } = pkce();
  const { res } = await authorize(client_id, challenge);
  const code = new URL(res.headers.get('location')).searchParams.get('code');
  const bad = await fetch(`${BASE}/token`, form({
    grant_type: 'authorization_code', code, client_id,
    redirect_uri: REDIRECT, code_verifier: crypto.randomBytes(32).toString('base64url'),
  }));
  assert.ok(bad.status >= 400, `expected failure, got ${bad.status}`);
});

test('issues tokens and refuses to replay the authorization code', async () => {
  const { client_id } = await registerClient();
  const { verifier, challenge } = pkce();
  const { code, tokens } = await tokenFor(client_id, verifier, challenge);
  assert.ok(tokens.access_token && tokens.refresh_token);

  const replay = await fetch(`${BASE}/token`, form({
    grant_type: 'authorization_code', code, client_id, redirect_uri: REDIRECT, code_verifier: verifier,
  }));
  assert.ok(replay.status >= 400, 'an authorization code was accepted twice');
});

test('rotates refresh tokens', async () => {
  const { client_id } = await registerClient();
  const { verifier, challenge } = pkce();
  const { tokens } = await tokenFor(client_id, verifier, challenge);

  const next = await (await fetch(`${BASE}/token`, form({
    grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id,
  }))).json();
  assert.ok(next.access_token);

  const reuse = await fetch(`${BASE}/token`, form({
    grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id,
  }));
  assert.ok(reuse.status >= 400, 'a rotated refresh token was accepted again');
});

test('in-flight consent state is written to disk, so a restart cannot void it', async () => {
  const { client_id } = await registerClient();
  const url = `${BASE}/authorize?response_type=code&client_id=${client_id}`
    + `&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${pkce().challenge}&code_challenge_method=S256`;
  const ticket = (await (await fetch(url)).text()).match(/name="ticket" value="([^"]+)"/)?.[1];
  assert.ok(ticket);

  // Restarting the server used to wipe these, which surfaced to the user as a
  // spurious "this request has expired" seconds after starting.
  const state = JSON.parse(fs.readFileSync(path.join(HOME, 'oauth.json'), 'utf8'));
  assert.ok(state.codes?.[`pending:${ticket}`], 'the consent ticket was not persisted');
});

test('an issued access token is persisted, so a restart does not sign the client out', async () => {
  const { client_id } = await registerClient();
  const { verifier, challenge } = pkce();
  const { tokens } = await tokenFor(client_id, verifier, challenge);
  const state = JSON.parse(fs.readFileSync(path.join(HOME, 'oauth.json'), 'utf8'));
  assert.equal(Object.keys(state.access ?? {}).length > 0, true, 'access tokens were not persisted');
  assert.ok(!JSON.stringify(state).includes(tokens.access_token), 'the raw access token was stored, not a hash');
});

/* ------------------------------------------------------------------- mcp -- */

test('MCP endpoint refuses unauthenticated and bogus tokens with 401', async () => {
  assert.equal((await mcp(INIT)).status, 401);
  assert.equal((await mcp(INIT, { authorization: 'Bearer nope' })).status, 401,
    'must be 401 so the client re-authenticates rather than treating it as an outage');
});

test('MCP endpoint serves tools to an authorised caller', async () => {
  const { client_id } = await registerClient();
  const { verifier, challenge } = pkce();
  const { tokens } = await tokenFor(client_id, verifier, challenge);
  const auth = { authorization: `Bearer ${tokens.access_token}` };

  const init = await mcp(INIT, auth);
  assert.equal(init.status, 200);

  const parse = async (res) => {
    const text = await res.text();
    const line = text.split('\n').find((l) => l.startsWith('data:')) ?? text;
    return JSON.parse(line.replace(/^data:\s*/, ''));
  };
  assert.equal((await parse(init)).result.serverInfo.name, 'sim-harness');

  const tools = await parse(await mcp({ method: 'tools/list', params: {} }, auth));
  assert.ok(tools.result.tools.length >= 10, `expected the full tool set, saw ${tools.result.tools.length}`);
  assert.ok(tools.result.tools.some((t) => t.name === 'run_ios_test'));
});
