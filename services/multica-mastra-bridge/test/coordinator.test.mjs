import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { StateStore } from '../src/state-store.mjs';
import { BridgeCoordinator } from '../src/coordinator.mjs';

function fixtureConfig() {
  return {
    multicaConnections: { local: { id: 'local', workspaceId: 'ws-1', token: 'token', baseUrl: 'http://unused' } },
    mastraConnections: { coding: { id: 'coding', baseUrl: 'http://unused' } },
    bindings: {
      alpha: {
        id: 'alpha',
        enabled: true,
        multicaConnection: 'local',
        multicaProjectId: 'project-1',
        mastraConnection: 'coding',
        workflowId: 'codingAgentLoopWorkflow',
        adapter: 'coding-agent-loop',
        adapterConfig: { projectProfile: 'repo-a' },
        trigger: { bindingKey: 'mastra_bridge.binding', actionKey: 'mastra_bridge.action', actionValue: 'start' },
        issueStatuses: {
          running: 'in_progress', human: 'in_review', blocked: 'blocked',
          go: 'done', noGo: 'cancelled', canceled: 'cancelled',
        },
      },
    },
  };
}

test('starts once per issue, mirrors milestones, and only relays an explicit human decision', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'multica-mastra-bridge-'));
  try {
    const store = new StateStore(path.join(directory, 'state.json'));
    await store.load();
    const multicaEvents = [];
    const multica = {
      async getIssue() { return { id: 'issue-1', title: 'Implement feature', description: 'Implement the frozen task' }; },
      async setMetadataMany(issueId, values) { multicaEvents.push(['metadata', issueId, values]); },
      async updateStatus(issueId, status) { multicaEvents.push(['status', issueId, status]); },
      async addComment(issueId, content) { multicaEvents.push(['comment', issueId, content]); },
      async listTriggeredIssues() { return []; },
    };
    let startCount = 0;
    let resumed;
    let run = { status: 'running', steps: { 'implementation-cycle': { status: 'running' } } };
    const mastra = {
      async startAsync() { startCount += 1; return { status: 'running' }; },
      async getRun() { return run; },
      async resumeHumanDecision(_workflow, _runId, decision) { resumed = decision; },
      async cancel() {},
    };
    const coordinator = new BridgeCoordinator({
      config: fixtureConfig(),
      store,
      multicaClients: { local: multica },
      mastraClients: { coding: mastra },
      logger: { warn() {}, error() {} },
    });

    const first = await coordinator.startRun({ bindingId: 'alpha', issueId: 'issue-1' });
    const second = await coordinator.startRun({ bindingId: 'alpha', issueId: 'issue-1' });
    assert.equal(first.id, second.id);
    assert.equal(startCount, 1);
    assert.ok(multicaEvents.some(event => event[0] === 'status' && event[2] === 'in_progress'));

    run = {
      status: 'suspended',
      steps: {
        'implementation-cycle': {
          status: 'success',
          output: { status: 'READY_FOR_HUMAN_CONFIRMATION', summary: 'Ready, not GO.', cycleCount: 1 },
        },
      },
    };
    const waiting = await coordinator.syncRun(first.id);
    assert.equal(waiting.requiresHuman, true);
    assert.equal(waiting.state, 'AWAITING_HUMAN_FINAL_CONFIRMATION');

    await coordinator.submitHumanDecision(first.id, { decision: 'GO', confirmedBy: 'human', note: 'Reviewed evidence' });
    assert.deepEqual(resumed, { decision: 'GO', confirmedBy: 'human', note: 'Reviewed evidence' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('does not misclassify an acknowledged async start when the first snapshot is not visible yet', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'multica-mastra-bridge-'));
  try {
    const store = new StateStore(path.join(directory, 'state.json'));
    await store.load();
    const multica = {
      async getIssue() { return { id: 'issue-2', title: 'Task' }; },
      async setMetadataMany() {},
      async updateStatus() {},
      async addComment() {},
      async listTriggeredIssues() { return []; },
    };
    const mastra = {
      async startAsync() { return { status: 'running' }; },
      async getRun() { throw new Error('GET run returned 404'); },
      async resumeHumanDecision() {},
      async cancel() {},
    };
    const coordinator = new BridgeCoordinator({
      config: fixtureConfig(), store,
      multicaClients: { local: multica }, mastraClients: { coding: mastra },
      logger: { warn() {}, error() {} },
    });
    const record = await coordinator.startRun({ bindingId: 'alpha', issueId: 'issue-2' });
    assert.equal(record.state, 'RUNNING');
    assert.equal(record.terminal, false);
    assert.match(record.lastError, /404/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
