import { access, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  profileRegistrySchema,
  projectConfigSchema,
  type ProfileRegistry,
  type ProjectConfig,
} from './schemas.js';
import { isInside } from './workspace-boundary.js';

let registryCache: Promise<ProfileRegistry> | undefined;
const profileCache = new Map<string, Promise<ProjectConfig>>();

function configurationEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    USERPROFILE: process.env.USERPROFILE ?? os.homedir(),
    LOCAL_AGENT_PLATFORM_HOME:
      process.env.LOCAL_AGENT_PLATFORM_HOME ?? path.join(os.homedir(), '.local-agent-platform'),
  };
}

function expandEnvironment(value: unknown, environment = configurationEnvironment()): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_match, key: string) => {
      const replacement = environment[key];
      if (!replacement) throw new Error(`Missing environment variable in Coding Platform config: ${key}`);
      return replacement;
    });
  }
  if (Array.isArray(value)) return value.map(item => expandEnvironment(item, environment));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandEnvironment(item, environment)]));
  }
  return value;
}

export async function getRegistryFile(): Promise<string> {
  const serviceBase = path.resolve(import.meta.dirname, '../..');
  if (process.env.CODING_AGENT_PROFILES) return path.resolve(process.env.CODING_AGENT_PROFILES);
  const localRegistry = path.resolve(serviceBase, 'coding-agent.profiles.json');
  try {
    await access(localRegistry);
    return localRegistry;
  } catch {
    return path.resolve(serviceBase, 'coding-agent.profiles.example.json');
  }
}

export async function loadProfileRegistry(): Promise<ProfileRegistry> {
  const registryFile = await getRegistryFile();
  const raw = expandEnvironment(JSON.parse(await readFile(registryFile, 'utf8')) as unknown);
  return { ...profileRegistrySchema.parse(raw), registryFile };
}

export function getProfileRegistry(): Promise<ProfileRegistry> {
  registryCache ??= loadProfileRegistry();
  return registryCache;
}

export async function listProjectProfiles() {
  const registry = await getProfileRegistry();
  return Object.entries(registry.profiles)
    .filter(([, value]) => value.enabled)
    .map(([id, value]) => ({ id, description: value.description }));
}

export async function loadProjectConfig(profileId: string): Promise<ProjectConfig> {
  const registry = await getProfileRegistry();
  const entry = registry.profiles[profileId];
  if (!entry?.enabled) throw new Error(`Unknown or disabled projectProfile: ${profileId}`);

  const registryBase = path.dirname(registry.registryFile);
  const configFile = path.resolve(registryBase, entry.configFile);
  const raw = expandEnvironment(JSON.parse(await readFile(configFile, 'utf8')) as unknown);
  const parsed = projectConfigSchema.parse(raw);
  const configBase = path.dirname(configFile);
  const projectRoot = path.resolve(configBase, parsed.projectRoot);
  const allowedRoots = registry.allowedRoots.map(root => path.resolve(registryBase, root));
  if (!allowedRoots.some(root => isInside(root, projectRoot))) {
    throw new Error(`Profile ${profileId} projectRoot is outside registry allowedRoots: ${projectRoot}`);
  }

  return {
    ...parsed,
    profileId,
    configFile,
    projectRoot,
    runtimeDir: path.resolve(configBase, parsed.runtimeDir, profileId),
    bundleFile: path.resolve(configBase, parsed.bundleFile),
    corePrompt: {
      ...parsed.corePrompt,
      path: path.resolve(configBase, parsed.corePrompt.path),
    },
  };
}

export function getProjectConfig(profileId: string): Promise<ProjectConfig> {
  let cached = profileCache.get(profileId);
  if (!cached) {
    cached = loadProjectConfig(profileId);
    profileCache.set(profileId, cached);
  }
  return cached;
}

export function resetProjectConfigForTests(): void {
  registryCache = undefined;
  profileCache.clear();
}
