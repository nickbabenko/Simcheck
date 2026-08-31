/**
 * `app.url` lets a caller make the daemon issue an HTTP request, so these
 * cases are mostly about what it must refuse to fetch.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCidr, inCidr } from '../dist/edge.js';

const BLOCKED = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8',
  '169.254.0.0/16', '100.64.0.0/10'].map(parseCidr);
const blocked = (ip) => BLOCKED.some((n) => inCidr(ip, n));

test('private and metadata addresses are inside the blocked ranges', () => {
  for (const ip of [
    '10.1.2.3',           // RFC1918
    '172.16.5.4',         // RFC1918
    '192.168.4.85',       // this LAN -- the Proxmox host
    '192.168.4.50',       // Caddy
    '127.0.0.1',          // loopback
    '169.254.169.254',    // cloud metadata
    '100.125.137.90',     // this Mac's Tailscale address
  ]) assert.equal(blocked(ip), true, `${ip} must be refused`);
});

test('ordinary public addresses are allowed', () => {
  for (const ip of ['140.82.121.4', '8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1']) {
    assert.equal(blocked(ip), false, `${ip} should be fetchable`);
  }
});

test('the CGNAT range covers the whole tailnet, not just this node', () => {
  for (const ip of ['100.64.0.1', '100.76.87.107', '100.127.255.254']) {
    assert.equal(blocked(ip), true, `${ip} is a tailnet address and must be refused`);
  }
  assert.equal(blocked('100.128.0.1'), false, 'just outside CGNAT is public');
});
