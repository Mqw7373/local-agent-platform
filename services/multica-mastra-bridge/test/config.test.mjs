import test from 'node:test';
import assert from 'node:assert/strict';
import { bindingReadiness, normalizeConfig } from '../src/config.mjs';

function rawConfig() {
  return {
    version: 1,
    server: {},
    polling: {},
    stateFile: './state.json',
    multicaConnections: {
      local: {
        baseUrl: 'http://localhost:8080/',
        workspaceId: '${WORKSPACE_ID}',
        token: '${TOKEN}',
      },
    },
    mastraConnections: {
      coding: { baseUrl: 'http://localhost:4113/', apiPrefix: 'api/' },
    },
    bindings: {
      alpha: {
        multicaConnection: 'local',
        multicaProjectId: '${PROJECT_ID}',
        mastraConnection: 'coding',
        workflowId: 'codingAgentLoopWorkflow',
        adapter: 'coding-agent-loop',
        adapterConfig: { projectProfile: 'alpha-profile' },
      },
    },
  };
}

test('normalizes connections and expands environment-backed project bindings', () => {
  const config = normalizeConfig(rawConfig(), {
    configPath: 'C:/bridge/bridge.config.json',
    environment: { WORKSPACE_ID: 'ws-1', TOKEN: 'token-1', PROJECT_ID: 'project-1' },
  });
  assert.equal(config.multicaConnections.local.baseUrl, 'http://localhost:8080');
  assert.equal(config.mastraConnections.coding.apiPrefix, '/api');
  assert.equal(config.bindings.alpha.adapterConfig.projectProfile, 'alpha-profile');
  assert.deepEqual(bindingReadiness(config, config.bindings.alpha), { ready: true, missing: [] });
});

test('reports missing operational secrets without rejecting the reusable binding', () => {
  const config = normalizeConfig(rawConfig(), {
    configPath: 'C:/bridge/bridge.config.json',
    environment: {},
  });
  assert.deepEqual(bindingReadiness(config, config.bindings.alpha), {
    ready: false,
    missing: ['Multica project id', 'Multica workspace id', 'Multica token'],
  });
});
