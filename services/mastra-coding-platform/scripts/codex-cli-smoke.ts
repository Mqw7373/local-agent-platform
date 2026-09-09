import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PROMPT_AUTHORITY } from '../src/mastra/agents.js';
import { runReadOnlyCodexRole } from '../src/mastra/codex-cli.js';
import { resetProjectConfigForTests } from '../src/mastra/config.js';
import { documentConsistencySchema } from '../src/mastra/schemas.js';

const executeFile = promisify(execFile);
const root = await mkdtemp(path.join(os.tmpdir(), 'mastra-codex-smoke-'));
const priorRegistry = process.env.CODING_AGENT_PROFILES;

try {
  const projectRoot = path.join(root, 'repo');
  const docsRoot = path.join(projectRoot, 'docs');
  await mkdir(docsRoot, { recursive: true });
  const documents = {
    prd: 'docs/PRD.md',
    adr: 'docs/ADR.md',
    systemDesign: 'docs/System-Design.md',
    apiContract: 'docs/API-Contract.md',
    acceptanceCriteria: 'docs/Acceptance-Criteria.md',
  } as const;
  for (const relativePath of Object.values(documents)) {
    await writeFile(path.join(projectRoot, relativePath), '# Smoke fixture\nA read-only adapter smoke test.\n', 'utf8');
  }
  await mkdir(path.join(projectRoot, '.agent'), { recursive: true });
  await writeFile(path.join(projectRoot, '.agent', 'frozen-bundle.json'), '{}\n', 'utf8');
  await executeFile('git', ['init', '-b', 'smoke'], { cwd: projectRoot });
  await executeFile('git', ['add', '-A'], { cwd: projectRoot });
  await executeFile('git', [
    '-c', 'user.name=Mastra Codex Smoke',
    '-c', 'user.email=local-agent-platform@invalid',
    'commit', '-m', 'Smoke baseline', '--quiet',
  ], { cwd: projectRoot });

  const corePrompt = path.resolve(
    process.cwd(),
    '../../prompts/coding-agent-loop/tc-agent-loop-v2.9-v1.0-r10-bundle-v1/core-prompt-v2.9.md',
  );
  const configFile = path.join(root, 'smoke.json');
  await writeFile(configFile, JSON.stringify({
    projectName: 'Codex CLI smoke fixture',
    projectRoot,
    runtimeDir: path.join(root, 'runtime'),
    corePrompt: { path: corePrompt, sha256: PROMPT_AUTHORITY.sha256 },
    bundleFile: path.join(projectRoot, '.agent', 'frozen-bundle.json'),
    documents,
    execution: {
      backend: 'role-routed',
      executable: 'codex',
      timeoutMs: 5 * 60_000,
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
    protectedPaths: ['docs/**', '.agent/**'],
    ignore: ['.git'],
    verificationCommands: [{ id: 'node', command: process.execPath, args: ['--version'] }],
  }), 'utf8');
  await writeFile(path.join(root, 'profiles.json'), JSON.stringify({
    allowedRoots: [root],
    profiles: { smoke: { configFile, enabled: true } },
  }), 'utf8');

  const before = await readFile(path.join(projectRoot, documents.prd), 'utf8');
  process.env.CODING_AGENT_PROFILES = path.join(root, 'profiles.json');
  resetProjectConfigForTests();
  const result = await runReadOnlyCodexRole({
    projectProfile: 'smoke',
    role: 'document-preflight',
    phase: 'adapter-smoke',
    input: {
      task: 'Validate that this temporary five-document fixture can be inspected without writing it.',
      configuredDocuments: documents,
    },
    outputSchema: documentConsistencySchema,
    runId: 'adapter-smoke',
  });
  assert.ok(result.status === 'CONSISTENT' || result.status === 'NEEDS_DOCUMENT_REVIEW');
  assert.equal(
    result.issues.some(issue => /not readable|could not be inspected|filesystem access/i.test(issue.detail)),
    false,
  );
  assert.equal(await readFile(path.join(projectRoot, documents.prd), 'utf8'), before);
  console.log(`Codex CLI smoke passed: fresh ephemeral read-only task returned ${result.status} without changing the repository.`);
} finally {
  if (priorRegistry === undefined) delete process.env.CODING_AGENT_PROFILES;
  else process.env.CODING_AGENT_PROFILES = priorRegistry;
  resetProjectConfigForTests();
  await rm(root, { recursive: true, force: true });
}
