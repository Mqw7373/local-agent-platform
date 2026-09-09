import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const defaultStatuses = {
  running: 'in_progress',
  human: 'in_review',
  blocked: 'blocked',
  go: 'done',
  noGo: 'cancelled',
  canceled: 'cancelled',
};

const defaultTrigger = {
  bindingKey: 'mastra_bridge.binding',
  actionKey: 'mastra_bridge.action',
  actionValue: 'start',
};

function expandEnvironment(value, environment) {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_match, key) => environment[key] ?? '');
  }
  if (Array.isArray(value)) return value.map(item => expandEnvironment(item, environment));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandEnvironment(item, environment)]));
  }
  return value;
}

function requiredObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

export function normalizeConfig(raw, { configPath, environment = process.env } = {}) {
  const effectiveEnvironment = {
    ...environment,
    USERPROFILE: environment.USERPROFILE ?? os.homedir(),
    LOCAL_AGENT_PLATFORM_HOME:
      environment.LOCAL_AGENT_PLATFORM_HOME ?? path.join(os.homedir(), '.local-agent-platform'),
  };
  const expanded = expandEnvironment(requiredObject(raw, 'config'), effectiveEnvironment);
  if (expanded.version !== 1) throw new Error('config.version must be 1');

  const server = requiredObject(expanded.server ?? {}, 'server');
  const polling = requiredObject(expanded.polling ?? {}, 'polling');
  const multicaConnections = requiredObject(expanded.multicaConnections, 'multicaConnections');
  const mastraConnections = requiredObject(expanded.mastraConnections, 'mastraConnections');
  const rawBindings = requiredObject(expanded.bindings, 'bindings');

  const normalizedMultica = Object.fromEntries(Object.entries(multicaConnections).map(([id, connection]) => {
    requiredObject(connection, `multicaConnections.${id}`);
    return [id, {
      id,
      baseUrl: requiredString(connection.baseUrl, `multicaConnections.${id}.baseUrl`).replace(/\/$/, ''),
      workspaceId: typeof connection.workspaceId === 'string' ? connection.workspaceId.trim() : '',
      token: typeof connection.token === 'string' ? connection.token.trim() : '',
      timeoutMs: Number(connection.timeoutMs ?? 15_000),
    }];
  }));

  const normalizedMastra = Object.fromEntries(Object.entries(mastraConnections).map(([id, connection]) => {
    requiredObject(connection, `mastraConnections.${id}`);
    const apiPrefix = connection.apiPrefix ?? '/api';
    return [id, {
      id,
      baseUrl: requiredString(connection.baseUrl, `mastraConnections.${id}.baseUrl`).replace(/\/$/, ''),
      apiPrefix: apiPrefix.startsWith('/') ? apiPrefix.replace(/\/$/, '') : `/${apiPrefix.replace(/\/$/, '')}`,
      timeoutMs: Number(connection.timeoutMs ?? 15_000),
    }];
  }));

  const bindings = Object.fromEntries(Object.entries(rawBindings).map(([id, binding]) => {
    requiredObject(binding, `bindings.${id}`);
    const multicaConnection = requiredString(binding.multicaConnection, `bindings.${id}.multicaConnection`);
    const mastraConnection = requiredString(binding.mastraConnection, `bindings.${id}.mastraConnection`);
    if (!normalizedMultica[multicaConnection]) throw new Error(`bindings.${id} references unknown Multica connection ${multicaConnection}`);
    if (!normalizedMastra[mastraConnection]) throw new Error(`bindings.${id} references unknown Mastra connection ${mastraConnection}`);

    const adapter = requiredString(binding.adapter, `bindings.${id}.adapter`);
    const adapterConfig = requiredObject(binding.adapterConfig ?? {}, `bindings.${id}.adapterConfig`);
    if (adapter === 'coding-agent-loop') {
      requiredString(adapterConfig.projectProfile, `bindings.${id}.adapterConfig.projectProfile`);
    }

    return [id, {
      id,
      enabled: binding.enabled !== false,
      multicaConnection,
      multicaProjectId: typeof binding.multicaProjectId === 'string' ? binding.multicaProjectId.trim() : '',
      mastraConnection,
      workflowId: requiredString(binding.workflowId, `bindings.${id}.workflowId`),
      adapter,
      adapterConfig,
      trigger: { ...defaultTrigger, ...(binding.trigger ?? {}) },
      issueStatuses: { ...defaultStatuses, ...(binding.issueStatuses ?? {}) },
    }];
  }));

  const baseDirectory = configPath ? path.dirname(configPath) : process.cwd();
  const stateFile = path.resolve(baseDirectory, expanded.stateFile ?? './runtime/bridge-state.json');

  return {
    version: 1,
    configPath,
    server: {
      host: server.host ?? '127.0.0.1',
      port: Number(server.port ?? 4120),
      controlToken: server.controlTokenEnv ? environment[server.controlTokenEnv] ?? '' : '',
      controlTokenEnv: server.controlTokenEnv ?? '',
    },
    polling: {
      enabled: polling.enabled !== false,
      intervalMs: Math.max(1000, Number(polling.intervalMs ?? 5000)),
    },
    stateFile,
    multicaConnections: normalizedMultica,
    mastraConnections: normalizedMastra,
    bindings,
  };
}

export async function loadConfig(configFile = process.env.MULTICA_MASTRA_BRIDGE_CONFIG ?? './bridge.config.json') {
  const configPath = path.resolve(configFile);
  const raw = JSON.parse(await readFile(configPath, 'utf8'));
  return normalizeConfig(raw, { configPath });
}

export function bindingReadiness(config, binding) {
  const multica = config.multicaConnections[binding.multicaConnection];
  const missing = [];
  if (!binding.enabled) missing.push('binding disabled');
  if (!binding.multicaProjectId) missing.push('Multica project id');
  if (!multica.workspaceId) missing.push('Multica workspace id');
  if (!multica.token) missing.push('Multica token');
  return { ready: missing.length === 0, missing };
}
