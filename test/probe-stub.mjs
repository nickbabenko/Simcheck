// A stand-in for the in-app probe's /v1 API, so the executor's probe paths
// can be driven without a simulator. `state` is mutable: a test sets what the
// next call answers.
import http from 'node:http';

export async function stubProbe({ token = 't'.repeat(48), bundleId = 'com.example.app', pid = 1 } = {}) {
  const state = {
    bundleId, pid,
    settle: { settled: true, elapsedMs: 120, settledAtMs: 80, busy: [] },
    requests: [],
    lines: [],
    opened: true,
    calls: [],
    failSettle: false,
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    state.calls.push(`${req.method} ${url.pathname}${url.search}`);
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: { code: 'unauthorized', message: 'no' } });

    const since = Number(url.searchParams.get('since') ?? 0);
    switch (url.pathname) {
      case '/v1/hello':
        return send(200, {
          name: 'simbase-probe', version: '0.1.0', api: 'v1', capabilities: ['settle', 'network'],
          pid: state.pid, bundleId: state.bundleId, systemVersion: '26.3', timings: {},
        });
      case '/v1/wait-settled':
        if (state.failSettle) return send(500, { error: { code: 'internal', message: 'boom' } });
        return send(200, { quietMs: 200, samples: 3, timeline: [], ...state.settle });
      case '/v1/network': {
        const requests = state.requests.filter((request) => request.seq > since);
        return send(200, { requests, cursor: state.requests.length, dropped: 0 });
      }
      case '/v1/console': {
        const lines = state.lines.filter((line) => line.seq > since);
        return send(200, { lines, cursor: state.lines.length, dropped: 0 });
      }
      case '/v1/open-url':
        return send(200, { opened: state.opened, timedOut: false, tookMs: 12 });
      default:
        return send(404, { error: { code: 'not_found', message: url.pathname } });
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { state, token, port: server.address().port, close: () => server.close() };
}

/** A completed request as the probe records it. */
export function request(seq, extra = {}) {
  return {
    seq, kind: 'data', method: 'GET', url: `https://api.example.com/items/${seq}`,
    requestHeaders: {}, startedAt: Date.now(), state: 'completed', durationMs: 40, status: 200,
    ...extra,
  };
}
