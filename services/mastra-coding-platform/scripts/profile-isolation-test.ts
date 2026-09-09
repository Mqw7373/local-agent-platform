import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getProjectConfig, resetProjectConfigForTests } from '../src/mastra/config.js';
import { resolveProductPath } from '../src/mastra/workspace.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'mastra-profile-isolation-'));
const priorRegistry = process.env.CODING_AGENT_PROFILES;

function config(projectRoot: string) {
  return {
    projectName: projectRoot,
    projectRoot,
    runtimeDir: './runtime',
    corePrompt: { path: './core.md', sha256: 'a'.repeat(64) },
    bundleFile: `${projectRoot}/.agent/frozen-bundle.json`,
    documents: {
      prd: 'docs/PRD.md',
      adr: 'docs/ADR.md',
      systemDesign: 'docs/System-Design.md',
      apiContract: 'docs/API-Contract.md',
      acceptanceCriteria: 'docs/Acceptance-Criteria.md',
    },
    execution: {
      backend: 'role-routed',
      executable: 'codex',
      timeoutMs: 30 * 60_000,
      ignoreUserConfig: true,
      roles: {
        'document-preflight': { backend: 'codex-cli', model: 'gpt-5.6-sol' },
        developer: { backend: 'codex-cli', model: 'gpt-6-astra' },
        reviewer: { backend: 'codex-cli', model: 'gpt-5.6-sol' },
        challenger: {
          backend: 'openai-compatible', provider: 'openrouter',
          baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY',
          model: 'deepseek/deepseek-v4-flash', maxToolRounds: 10,
        },
        adjudicator: { backend: 'codex-cli', model: 'gpt-6-astra' },
      },
    },
    promptMode: 'distilled',
    maxCodeCycles: 3,
    protectedPaths: ['docs/**', '.agent/**'],
    verificationCommands: [{ id: 'test', command: 'node', args: ['--version'] }],
  };
}

try {
  await mkdir(path.join(root, 'projects', 'alpha'), { recursive: true });
  await mkdir(path.join(root, 'projects', 'beta'), { recursive: true });
  await writeFile(path.join(root, 'alpha.json'), JSON.stringify(config('./projects/alpha')), 'utf8');
  await writeFile(path.join(root, 'beta.json'), JSON.stringify(config('./projects/beta')), 'utf8');
  await writeFile(path.join(root, 'escape.json'), JSON.stringify(config('./outside')), 'utf8');
  await writeFile(path.join(root, 'profiles.json'), JSON.stringify({
    allowedRoots: ['./projects'],
    profiles: {
      alpha: { configFile: './alpha.json', enabled: true },
      beta: { configFile: './beta.json', enabled: true },
      escape: { configFile: './escape.json', enabled: true },
    },
  }), 'utf8');

  process.env.CODING_AGENT_PROFILES = path.join(root, 'profiles.json');
  resetProjectConfigForTests();

  const alpha = await getProjectConfig('alpha');
  const beta = await getProjectConfig('beta');
  assert.notEqual(alpha.projectRoot, beta.projectRoot);
  assert.equal(await resolveProductPath('alpha', 'src/index.ts'), path.join(alpha.projectRoot, 'src', 'index.ts'));
  await assert.rejects(resolveProductPath('alpha', '../beta/secret.ts'), /escapes projectRoot/);
  await assert.rejects(getProjectConfig('escape'), /outside registry allowedRoots/);
  await assert.rejects(getProjectConfig('missing'), /Unknown or disabled/);
  console.log('Profile isolation test passed: selection, allowlisted roots, and cross-profile path denial.');
} finally {
  if (priorRegistry === undefined) delete process.env.CODING_AGENT_PROFILES;
  else process.env.CODING_AGENT_PROFILES = priorRegistry;
  resetProjectConfigForTests();
  await rm(root, { recursive: true, force: true });
}
