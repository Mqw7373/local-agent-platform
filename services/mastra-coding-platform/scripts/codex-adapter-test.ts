import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  applyDeveloperWorkspace,
  buildCodexExecArguments,
  createCodexEnvironment,
  createDeveloperWorkspace,
  normalizeCodexOutputSchema,
} from '../src/mastra/codex-cli.js';
import { getProjectConfig, resetProjectConfigForTests } from '../src/mastra/config.js';
import { buildDeepSeekChatRequest } from '../src/mastra/deepseek-challenger.js';
import { z } from 'zod';

const root = await mkdtemp(path.join(os.tmpdir(), 'mastra-codex-adapter-'));
const priorRegistry = process.env.CODING_AGENT_PROFILES;

async function createScenario(profileId: string, allowedDeletions: string[] = []): Promise<void> {
  const projectRoot = path.join(root, 'projects', profileId);
  await mkdir(path.join(projectRoot, 'src'), { recursive: true });
  await mkdir(path.join(projectRoot, 'tests'), { recursive: true });
  await mkdir(path.join(projectRoot, 'docs'), { recursive: true });
  await mkdir(path.join(projectRoot, '.agent'), { recursive: true });
  await writeFile(path.join(projectRoot, 'src', 'index.ts'), 'export const value = 1;\n', 'utf8');
  await writeFile(path.join(projectRoot, 'tests', 'index.test.ts'), 'export {};\n', 'utf8');
  for (const document of ['PRD.md', 'ADR.md', 'System-Design.md', 'API-Contract.md', 'Acceptance-Criteria.md']) {
    await writeFile(path.join(projectRoot, 'docs', document), `# ${document}\n`, 'utf8');
  }
  await writeFile(path.join(projectRoot, '.agent', 'frozen-bundle.json'), '{}\n', 'utf8');
  await writeFile(path.join(root, `${profileId}.json`), JSON.stringify({
    projectName: profileId,
    projectRoot,
    runtimeDir: path.join(root, 'runtime'),
    corePrompt: { path: path.join(root, 'core.md'), sha256: 'a'.repeat(64) },
    bundleFile: path.join(projectRoot, '.agent', 'frozen-bundle.json'),
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
      timeoutMs: 60_000,
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
    protectedPaths: ['docs/**', '.agent/**', 'AGENTS.md'],
    allowedDeletions,
    ignore: ['.git', 'node_modules'],
    verificationCommands: [{ id: 'node', command: process.execPath, args: ['--version'] }],
  }), 'utf8');
}

async function withWorkspace(profileId: string, operation: (workspace: Awaited<ReturnType<typeof createDeveloperWorkspace>>) => Promise<void>) {
  const workspace = await createDeveloperWorkspace(profileId);
  try {
    await operation(workspace);
  } finally {
    await rm(workspace.temporaryRoot, { recursive: true, force: true });
  }
}

try {
  const profiles = ['allowed', 'protected', 'deletion', 'authorized-deletion', 'protected-deletion', 'concurrent', 'concurrent-deletion'];
  await mkdir(path.join(root, 'projects'), { recursive: true });
  await writeFile(path.join(root, 'core.md'), 'test\n', 'utf8');
  for (const profileId of profiles) {
    const allowedDeletions = profileId === 'authorized-deletion' || profileId === 'concurrent-deletion'
      ? ['src/index.ts']
      : profileId === 'protected-deletion'
        ? ['docs/PRD.md']
        : [];
    await createScenario(profileId, allowedDeletions);
  }
  await writeFile(path.join(root, 'profiles.json'), JSON.stringify({
    allowedRoots: [path.join(root, 'projects')],
    profiles: Object.fromEntries(profiles.map(profileId => [profileId, {
      configFile: `./${profileId}.json`,
      enabled: true,
    }])),
  }), 'utf8');
  process.env.CODING_AGENT_PROFILES = path.join(root, 'profiles.json');
  resetProjectConfigForTests();

  await withWorkspace('allowed', async workspace => {
    await writeFile(path.join(workspace.workspaceRoot, 'src', 'index.ts'), 'export const value = 2;\n', 'utf8');
    await writeFile(path.join(workspace.workspaceRoot, 'tests', 'new.test.ts'), 'export {};\n', 'utf8');
    const changed = await applyDeveloperWorkspace('allowed', workspace, 'test-run', 'allowed-diff');
    assert.deepEqual(changed, ['src/index.ts', 'tests/new.test.ts']);
    const config = await getProjectConfig('allowed');
    assert.equal(await readFile(path.join(config.projectRoot, 'src', 'index.ts'), 'utf8'), 'export const value = 2;\n');
  });

  await withWorkspace('allowed', async workspace => {
    await writeFile(path.join(workspace.workspaceRoot, 'src', 'index.ts'), 'export const value = 4;\n', 'utf8');
    await writeFile(path.join(workspace.workspaceRoot, 'tests', 'scope-escape.test.ts'), 'export {};\n', 'utf8');
    await assert.rejects(
      applyDeveloperWorkspace('allowed', workspace, 'test-run', 'scope-gate', ['src/**']),
      /escaped Frozen Bundle allowed_scope: tests\/scope-escape.test.ts/,
    );
  });

  await withWorkspace('protected', async workspace => {
    await writeFile(path.join(workspace.workspaceRoot, 'docs', 'PRD.md'), '# tampered\n', 'utf8');
    await assert.rejects(applyDeveloperWorkspace('protected', workspace), /modified protected authority/);
  });

  await withWorkspace('deletion', async workspace => {
    await rm(path.join(workspace.workspaceRoot, 'src', 'index.ts'));
    await assert.rejects(applyDeveloperWorkspace('deletion', workspace), /deletion is not allowed/);
  });

  await withWorkspace('authorized-deletion', async workspace => {
    await rm(path.join(workspace.workspaceRoot, 'src', 'index.ts'));
    const changed = await applyDeveloperWorkspace('authorized-deletion', workspace, 'test-run', 'allowed-deletion');
    assert.deepEqual(changed, ['src/index.ts']);
    const config = await getProjectConfig('authorized-deletion');
    await assert.rejects(readFile(path.join(config.projectRoot, 'src', 'index.ts')), /ENOENT/);
  });

  await withWorkspace('protected-deletion', async workspace => {
    await rm(path.join(workspace.workspaceRoot, 'docs', 'PRD.md'));
    await assert.rejects(applyDeveloperWorkspace('protected-deletion', workspace), /deleted protected authority/);
  });

  await withWorkspace('concurrent', async workspace => {
    await writeFile(path.join(workspace.workspaceRoot, 'src', 'index.ts'), 'export const value = 2;\n', 'utf8');
    const config = await getProjectConfig('concurrent');
    await writeFile(path.join(config.projectRoot, 'src', 'index.ts'), 'export const value = 3;\n', 'utf8');
    await assert.rejects(applyDeveloperWorkspace('concurrent', workspace), /Concurrent product change/);
  });

  await withWorkspace('concurrent-deletion', async workspace => {
    await rm(path.join(workspace.workspaceRoot, 'src', 'index.ts'));
    const config = await getProjectConfig('concurrent-deletion');
    await writeFile(path.join(config.projectRoot, 'src', 'index.ts'), 'export const value = 3;\n', 'utf8');
    await assert.rejects(applyDeveloperWorkspace('concurrent-deletion', workspace), /Concurrent product change/);
    assert.equal(await readFile(path.join(config.projectRoot, 'src', 'index.ts'), 'utf8'), 'export const value = 3;\n');
  });

  const config = await getProjectConfig('allowed');
  const reviewerArgs = buildCodexExecArguments({
    config,
    role: 'reviewer',
    schemaFile: 'schema.json',
    outputFile: 'output.json',
    workspaceRoot: config.projectRoot,
  });
  const developerArgs = buildCodexExecArguments({
    config,
    role: 'developer',
    schemaFile: 'schema.json',
    outputFile: 'output.json',
    workspaceRoot: config.projectRoot,
  });
  const adjudicatorArgs = buildCodexExecArguments({
    config,
    role: 'adjudicator',
    schemaFile: 'schema.json',
    outputFile: 'output.json',
    workspaceRoot: config.projectRoot,
  });
  assert.equal(reviewerArgs[reviewerArgs.indexOf('--sandbox') + 1], 'danger-full-access');
  assert.equal(developerArgs[developerArgs.indexOf('--sandbox') + 1], 'danger-full-access');
  assert.equal(reviewerArgs[reviewerArgs.indexOf('--model') + 1], 'gpt-5.6-sol');
  assert.equal(developerArgs[developerArgs.indexOf('--model') + 1], 'gpt-6-astra');
  assert.equal(adjudicatorArgs[adjudicatorArgs.indexOf('--model') + 1], 'gpt-6-astra');
  assert.throws(() => buildCodexExecArguments({
    config,
    role: 'challenger',
    schemaFile: 'schema.json',
    outputFile: 'output.json',
    workspaceRoot: config.projectRoot,
  }), /not configured for the Codex CLI backend/);
  for (const args of [reviewerArgs, adjudicatorArgs]) {
    assert.ok(args.includes('--ephemeral'));
    assert.ok(args.includes('--output-schema'));
    assert.ok(args.includes('--ignore-user-config'));
    assert.equal(args.some(argument => argument.includes('resume')), false);
  }
  assert.equal(developerArgs.includes('--ephemeral'), false);
  assert.equal(developerArgs.some(argument => argument.includes('resume')), false);

  const isolatedEnvironment = createCodexEnvironment({
    OPENAI_API_KEY: 'must-not-leak',
    CODEX_API_KEY: 'must-not-leak',
    CODEX_CI: '1',
    CODEX_SESSION_ID: 'must-not-share',
    CODEX_THREAD_ID: 'must-not-share',
    CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop',
    CODEX_SANDBOX_NETWORK_DISABLED: '1',
    PONYTAIL_DEFAULT_MODE: 'ultra',
    PONYTAIL_SUBAGENT_MATCHER: '.*',
    PONYTAIL_QUIET_STARTUP: '1',
    PONYTAIL_HIDE_STATUS: '1',
    USERPROFILE: 'preserve-auth-location',
  });
  assert.equal(isolatedEnvironment.OPENAI_API_KEY, undefined);
  assert.equal(isolatedEnvironment.CODEX_API_KEY, undefined);
  assert.equal(isolatedEnvironment.CODEX_CI, undefined);
  assert.equal(isolatedEnvironment.CODEX_SESSION_ID, undefined);
  assert.equal(isolatedEnvironment.CODEX_THREAD_ID, undefined);
  assert.equal(isolatedEnvironment.CODEX_INTERNAL_ORIGINATOR_OVERRIDE, undefined);
  assert.equal(isolatedEnvironment.CODEX_SANDBOX_NETWORK_DISABLED, undefined);
  assert.equal(isolatedEnvironment.PONYTAIL_DEFAULT_MODE, undefined);
  assert.equal(isolatedEnvironment.PONYTAIL_SUBAGENT_MATCHER, undefined);
  assert.equal(isolatedEnvironment.PONYTAIL_QUIET_STARTUP, undefined);
  assert.equal(isolatedEnvironment.PONYTAIL_HIDE_STATUS, undefined);
  assert.equal(isolatedEnvironment.USERPROFILE, 'preserve-auth-location');

  const strictSchema = normalizeCodexOutputSchema(z.toJSONSchema(z.object({
    requiredValue: z.string(),
    optionalValue: z.string().optional(),
    nested: z.object({ optionalNested: z.number().optional() }),
  }))) as { required: string[]; properties: { nested: { required: string[] } } };
  assert.deepEqual(strictSchema.required, ['requiredValue', 'optionalValue', 'nested']);
  assert.deepEqual(strictSchema.properties.nested.required, ['optionalNested']);

  const challengerRequest = buildDeepSeekChatRequest({
    model: config.execution.roles.challenger.model,
    messages: [{ role: 'user', content: 'review' }],
    outputSchema: z.toJSONSchema(z.object({ summary: z.string() })),
  });
  assert.equal(challengerRequest.model, 'deepseek/deepseek-v4-flash');
  assert.equal(challengerRequest.tools.every(tool => !['write_file', 'execute_command'].includes(tool.function.name)), true);

  console.log('Codex adapter test passed: isolated diffs, role-specific models, DeepSeek non-fallback, protection and concurrency gates, strict schemas, fresh read-only calls, persistent Developer calls, and API-key removal.');
} finally {
  if (priorRegistry === undefined) delete process.env.CODING_AGENT_PROFILES;
  else process.env.CODING_AGENT_PROFILES = priorRegistry;
  resetProjectConfigForTests();
  await rm(root, { recursive: true, force: true });
}
