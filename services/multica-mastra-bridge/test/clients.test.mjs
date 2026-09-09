import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { MulticaClient } from '../src/clients/multica-client.mjs';
import { MastraClient } from '../src/clients/mastra-client.mjs';

async function withServer(handler, run) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

test('Multica client sends workspace auth and suppresses native agent starts on status sync', async () => {
  await withServer(async (request, response) => {
    assert.equal(request.url, '/api/issues/issue-1');
    assert.equal(request.headers.authorization, 'Bearer token-1');
    assert.equal(request.headers['x-workspace-id'], 'ws-1');
    assert.deepEqual(await body(request), { status: 'in_progress', suppress_run: true });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  }, async baseUrl => {
    const client = new MulticaClient({ id: 'local', baseUrl, workspaceId: 'ws-1', token: 'token-1', timeoutMs: 2000 });
    await client.updateStatus('issue-1', 'in_progress');
  });
});

test('Mastra client pins a caller-owned run id and registered workflow input', async () => {
  await withServer(async (request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/api/workflows/codingAgentLoopWorkflow/start-async?runId=run-1');
    const payload = await body(request);
    assert.deepEqual(payload.inputData, { projectProfile: 'repo-a', task: 'Implement task' });
    assert.equal(payload.tracingOptions.metadata.bridgeRunId, 'run-1');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"status":"running"}');
  }, async baseUrl => {
    const client = new MastraClient({ id: 'coding', baseUrl, apiPrefix: '/api', timeoutMs: 2000 });
    await client.startAsync('codingAgentLoopWorkflow', 'run-1', { projectProfile: 'repo-a', task: 'Implement task' });
  });
});
