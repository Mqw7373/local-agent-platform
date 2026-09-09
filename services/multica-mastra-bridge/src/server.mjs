import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

function sendJson(response, status, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': bytes.length,
  });
  response.end(bytes);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error('request body exceeds 1 MB');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function authorized(request, controlToken) {
  if (!controlToken) return true;
  const value = request.headers.authorization ?? '';
  const expected = `Bearer ${controlToken}`;
  const left = Buffer.from(value);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function publicRun(run) {
  if (!run) return run;
  const { lastCommentFingerprint: _fingerprint, ...value } = run;
  return value;
}

export function createBridgeServer({ config, coordinator, logger = console }) {
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    try {
      if (request.method === 'GET' && url.pathname === '/healthz') {
        return sendJson(response, 200, {
          status: 'ok',
          polling: coordinator.pollState,
          bindings: coordinator.bindings(),
          runCount: coordinator.listRuns().length,
        });
      }
      if (request.method === 'GET' && url.pathname === '/v1/bindings') {
        return sendJson(response, 200, { bindings: coordinator.bindings() });
      }
      if (request.method === 'GET' && url.pathname === '/v1/runs') {
        return sendJson(response, 200, { runs: coordinator.listRuns().map(publicRun) });
      }

      const runMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)$/);
      if (request.method === 'GET' && runMatch) {
        const run = coordinator.getRun(decodeURIComponent(runMatch[1]));
        return run ? sendJson(response, 200, publicRun(run)) : sendJson(response, 404, { error: 'run_not_found' });
      }

      if (!authorized(request, config.server.controlToken)) {
        return sendJson(response, 401, { error: 'unauthorized' });
      }

      if (request.method === 'POST' && url.pathname === '/v1/runs') {
        const body = await readJson(request);
        const run = await coordinator.startRun(body);
        return sendJson(response, 202, publicRun(run));
      }
      if (request.method === 'POST' && url.pathname === '/v1/poll') {
        return sendJson(response, 200, await coordinator.pollOnce());
      }

      const actionMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/(sync|decision|cancel)$/);
      if (request.method === 'POST' && actionMatch) {
        const id = decodeURIComponent(actionMatch[1]);
        const action = actionMatch[2];
        if (action === 'sync') return sendJson(response, 200, publicRun(await coordinator.syncRun(id)));
        if (action === 'decision') return sendJson(response, 202, publicRun(await coordinator.submitHumanDecision(id, await readJson(request))));
        if (action === 'cancel') return sendJson(response, 202, publicRun(await coordinator.cancelRun(id)));
      }

      return sendJson(response, 404, { error: 'not_found' });
    } catch (error) {
      logger.error(error);
      const message = error instanceof Error ? error.message : String(error);
      return sendJson(response, 400, { error: 'bridge_request_failed', message });
    }
  });
}
