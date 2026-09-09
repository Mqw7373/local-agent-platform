import assert from 'node:assert/strict';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  DeveloperExecutionError,
  assessDeveloperRecovery,
  buildCodexExecArguments,
  classifyProcessFailure,
  cleanupDeveloperExecution,
  recordDeveloperSideEffectReview,
  redactCodexEvent,
  resumeDeveloperExecution,
  runDeveloperCodexRole,
} from '../src/mastra/codex-cli.js';
import { getProjectConfig, resetProjectConfigForTests } from '../src/mastra/config.js';

const root = path.join(os.tmpdir(), `coding-platform-recovery-${process.pid}-${Date.now()}`);
const priorRegistry = process.env.CODING_AGENT_PROFILES;
const priorMode = process.env.FAKE_CODEX_MODE;

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

try {
  const projectRoot = path.join(root, 'product');
  const runtimeDir = path.join(root, 'runtime');
  await mkdir(path.join(projectRoot, 'src'), { recursive: true });
  await mkdir(path.join(projectRoot, 'tests'), { recursive: true });
  await mkdir(path.join(projectRoot, 'docs'), { recursive: true });
  await mkdir(path.join(projectRoot, '.agent'), { recursive: true });
  await writeFile(path.join(projectRoot, 'src', 'value.ts'), 'export const value = 1;\n');
  await writeFile(path.join(projectRoot, 'tests', 'value.test.ts'), 'export {};\n');
  for (const document of ['PRD.md', 'ADR.md', 'System-Design.md', 'API-Contract.md', 'Acceptance-Criteria.md']) {
    await writeFile(path.join(projectRoot, 'docs', document), `# ${document}\n`);
  }
  const bundleBytes = '{"bundle":"test"}\n';
  await writeFile(path.join(projectRoot, '.agent', 'frozen-bundle.json'), bundleBytes);
  const corePromptPath = path.resolve(process.cwd(), '../../prompts/coding-agent-loop/tc-agent-loop-v2.9-v1.0-r10-bundle-v1/core-prompt-v2.9.md');
  await writeFile(path.join(projectRoot, 'exec'), [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const args = process.argv.slice(2);",
    "const output = args[args.indexOf('--output-last-message') + 1];",
    "fs.writeFileSync(path.join(process.cwd(), 'src', 'value.ts'), 'export const value = 2;\\n');",
    "process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'thread-recovery-test'})+'\\n');",
    "process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'command_execution',command:'npm test --token sk-secret',status:'completed'},api_key:'super-secret'})+'\\n');",
    "if (process.env.FAKE_CODEX_MODE === 'scope') {",
    "  fs.writeFileSync(path.join(process.cwd(), 'outside.txt'), 'escaped\\n');",
    "  fs.writeFileSync(output, JSON.stringify({summary:'bad scope',changedPaths:['src/value.ts','outside.txt'],testsAddedOrChanged:[],unresolved:[]}));",
    "  process.exit(0);",
    "}",
    "if (process.env.FAKE_CODEX_MODE === 'success') {",
    "  fs.writeFileSync(output, JSON.stringify({summary:'done',changedPaths:['src/value.ts'],testsAddedOrChanged:[],unresolved:[]}));",
    "  process.exit(0);",
    "}",
    "process.stderr.write('telemetry warning\\nDIRECT_FAILURE: simulated timeout\\n');",
    "process.exit(7);",
  ].join('\n'));
  const config = {
    projectName: 'recovery-test', projectRoot, runtimeDir,
    corePrompt: { path: corePromptPath, sha256: '865da58c80dc9afd904ab476c0407bad4258b6edc7505f78c9473d7c5174481e' },
    bundleFile: path.join(projectRoot, '.agent', 'frozen-bundle.json'),
    documents: {
      prd: 'docs/PRD.md', adr: 'docs/ADR.md', systemDesign: 'docs/System-Design.md',
      apiContract: 'docs/API-Contract.md', acceptanceCriteria: 'docs/Acceptance-Criteria.md',
    },
    execution: {
      backend: 'role-routed', executable: process.execPath, timeoutMs: 10_000,
      inactivityTimeoutMs: 2_000, networkRetryLimit: 2, ignoreUserConfig: true,
      roles: {
        'document-preflight': { backend: 'codex-cli', model: 'gpt-5.6-sol' },
        developer: { backend: 'codex-cli', model: 'gpt-6-astra' },
        reviewer: { backend: 'codex-cli', model: 'gpt-5.6-sol' },
        challenger: { backend: 'openai-compatible', provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', model: 'deepseek/deepseek-v4-flash', maxToolRounds: 10 },
        adjudicator: { backend: 'codex-cli', model: 'gpt-6-astra' },
      },
    },
    protectedPaths: ['docs/**', '.agent/**'], allowedDeletions: [], ignore: ['.git'],
    verificationCommands: [{ id: 'node', command: process.execPath, args: ['--version'] }],
  };
  await writeFile(path.join(root, 'profile.json'), JSON.stringify(config));
  await writeFile(path.join(root, 'profiles.json'), JSON.stringify({
    allowedRoots: [root], profiles: { recovery: { configFile: './profile.json', enabled: true } },
  }));
  process.env.CODING_AGENT_PROFILES = path.join(root, 'profiles.json');
  resetProjectConfigForTests();

  const parsedConfig = await getProjectConfig('recovery');
  const developerArgs = buildCodexExecArguments({
    config: parsedConfig, role: 'developer', schemaFile: 'schema.json', outputFile: 'output.json', workspaceRoot: projectRoot,
  });
  const reviewerArgs = buildCodexExecArguments({
    config: parsedConfig, role: 'reviewer', schemaFile: 'schema.json', outputFile: 'output.json', workspaceRoot: projectRoot,
  });
  assert.equal(developerArgs.includes('--ephemeral'), false, 'Developer must retain a resumable Codex session.');
  assert.equal(reviewerArgs.includes('--ephemeral'), true, 'Read-only roles remain fresh and ephemeral.');

  const redacted = redactCodexEvent({ api_key: 'secret', nested: { authorization: 'Bearer abc' }, text: 'token sk-1234567890' }) as Record<string, unknown>;
  assert.equal(redacted.api_key, '[REDACTED]');
  assert.equal((redacted.nested as Record<string, unknown>).authorization, '[REDACTED]');
  assert.equal(String(redacted.text).includes('sk-1234567890'), false);
  const processBase = { exitCode: 1, stdout: '', stderr: '', durationMs: 1, timedOut: false, terminationStatus: 'NOT_REQUIRED' as const };
  assert.equal(classifyProcessFailure({ ...processBase, timedOut: true, timeoutKind: 'TOTAL_TIMEOUT', terminationStatus: 'TERMINATION_REQUESTED' }).code, 'TOTAL_TIMEOUT');
  assert.equal(classifyProcessFailure({ ...processBase, timedOut: true, timeoutKind: 'INACTIVITY_TIMEOUT', terminationStatus: 'TERMINATION_REQUESTED' }).code, 'INACTIVITY_TIMEOUT');
  assert.equal(classifyProcessFailure({ ...processBase, stderr: 'ECONNRESET from provider' }).code, 'NETWORK_FAILURE');

  process.env.FAKE_CODEX_MODE = 'fail';
  let failure: DeveloperExecutionError | undefined;
  try {
    await runDeveloperCodexRole({
      projectProfile: 'recovery', phase: 'initial-development', runId: 'run-failed',
      input: { task: 'test task', frozenBundleSha256: 'b'.repeat(64), workPackage: { id: 'WP-1' } },
      outputSchema: z.object({ summary: z.string(), changedPaths: z.array(z.string()), testsAddedOrChanged: z.array(z.string()), unresolved: z.array(z.string()) }),
      allowedScope: ['src/**', 'tests/*.test.ts'],
    });
  } catch (error) {
    assert.ok(error instanceof DeveloperExecutionError);
    failure = error;
  }
  assert.ok(failure, 'A failed Developer process must return a structured execution error.');
  assert.equal(await exists(failure.executionRoot), true, 'Failure evidence root must survive.');
  assert.equal(await exists(failure.workspaceRoot), true, 'Failed Developer workspace must survive.');
  assert.equal(await readFile(path.join(projectRoot, 'src', 'value.ts'), 'utf8'), 'export const value = 1;\n', 'Failure retention must not write back to the product repo.');
  const failedManifest = JSON.parse(await readFile(path.join(failure.executionRoot, 'recovery-manifest.json'), 'utf8'));
  const events = await readFile(path.join(failure.executionRoot, 'events.jsonl'), 'utf8');
  assert.match(events, /thread\.started/, JSON.stringify(failedManifest.failure));
  assert.doesNotMatch(events, /super-secret|sk-secret/);
  assert.match(await readFile(path.join(failure.executionRoot, 'diff.patch'), 'utf8'), /value = 2/);
  assert.equal(failedManifest.runId, 'run-failed');
  assert.equal(failedManifest.bundleSha256, 'b'.repeat(64));
  assert.equal(failedManifest.session.threadId, 'thread-recovery-test');
  assert.equal(failedManifest.failure.code, 'CODEX_EXIT_NONZERO');
  assert.doesNotMatch(failedManifest.failure.directReason, /telemetry warning/);
  assert.match(await readFile(path.join(failure.executionRoot, 'stderr.log'), 'utf8'), /telemetry warning/);
  assert.equal(failedManifest.cleanupEligible, false);

  const assessment = await assessDeveloperRecovery('recovery', failure.executionId);
  assert.equal(assessment.bundleMatch, false, 'A stale Bundle binding must block blind continuation.');
  assert.equal(assessment.decision, 'REJECT');
  await cleanupDeveloperExecution('recovery', failure.executionId, { reason: 'discard stale test execution', confirmedBy: 'test' });

  process.env.FAKE_CODEX_MODE = 'scope';
  let gateFailure: DeveloperExecutionError | undefined;
  try {
    await runDeveloperCodexRole({
      projectProfile: 'recovery', phase: 'initial-development', runId: 'run-gate',
      input: { task: 'test task', frozenBundleSha256: failedManifest.currentBundleSha256, workPackage: { id: 'WP-1' } },
      outputSchema: z.object({ summary: z.string(), changedPaths: z.array(z.string()), testsAddedOrChanged: z.array(z.string()), unresolved: z.array(z.string()) }),
      allowedScope: ['src/**'],
    });
  } catch (error) {
    assert.ok(error instanceof DeveloperExecutionError);
    gateFailure = error;
  }
  assert.ok(gateFailure);
  assert.equal(gateFailure.code, 'APPLY_GATE_FAILURE');
  const gateManifest = JSON.parse(await readFile(gateFailure.recoveryManifestFile, 'utf8'));
  assert.equal(gateManifest.status, 'FAILED_RECOVERABLE');
  assert.match(gateManifest.failure.directReason, /allowed_scope/);
  assert.equal(await readFile(path.join(projectRoot, 'src', 'value.ts'), 'utf8'), 'export const value = 1;\n');
  await cleanupDeveloperExecution('recovery', gateFailure.executionId, { reason: 'discard rejected test diff', confirmedBy: 'test' });

  process.env.FAKE_CODEX_MODE = 'fail';
  let resumableFailure: DeveloperExecutionError | undefined;
  try {
    await runDeveloperCodexRole({
      projectProfile: 'recovery', phase: 'initial-development', runId: 'run-resume',
      input: { task: 'test task', frozenBundleSha256: failedManifest.currentBundleSha256, workPackage: { id: 'WP-1' } },
      outputSchema: z.object({ summary: z.string(), changedPaths: z.array(z.string()), testsAddedOrChanged: z.array(z.string()), unresolved: z.array(z.string()) }),
      allowedScope: ['src/**', 'tests/*.test.ts'],
    });
  } catch (error) {
    assert.ok(error instanceof DeveloperExecutionError);
    resumableFailure = error;
  }
  assert.ok(resumableFailure);
  await recordDeveloperSideEffectReview('recovery', resumableFailure.executionId, {
    status: 'NONE_OBSERVED',
    evidence: ['Fake adapter test performed only a retained workspace edit.'],
    reviewedBy: 'test',
  });
  assert.equal((await assessDeveloperRecovery('recovery', resumableFailure.executionId)).decision, 'RESUME');
  process.env.FAKE_CODEX_MODE = 'success';
  const resumed = await resumeDeveloperExecution({
    projectProfile: 'recovery',
    executionId: resumableFailure.executionId,
    outputSchema: z.object({ summary: z.string(), changedPaths: z.array(z.string()), testsAddedOrChanged: z.array(z.string()), unresolved: z.array(z.string()) }),
  });
  assert.deepEqual(resumed.changedPaths, ['src/value.ts']);
  assert.equal(await readFile(path.join(projectRoot, 'src', 'value.ts'), 'utf8'), 'export const value = 2;\n');
  await cleanupDeveloperExecution('recovery', resumed.platformExecution.executionId, { reason: 'test recovered acceptance cleanup', confirmedBy: 'test' });

  await writeFile(path.join(projectRoot, 'src', 'value.ts'), 'export const value = 1;\n');

  process.env.FAKE_CODEX_MODE = 'success';
  const success = await runDeveloperCodexRole({
    projectProfile: 'recovery', phase: 'initial-development', runId: 'run-success',
    input: { task: 'test task', frozenBundleSha256: failedManifest.currentBundleSha256, workPackage: { id: 'WP-1' } },
    outputSchema: z.object({ summary: z.string(), changedPaths: z.array(z.string()), testsAddedOrChanged: z.array(z.string()), unresolved: z.array(z.string()) }),
    allowedScope: ['src/**', 'tests/*.test.ts'],
  });
  assert.equal(await exists(success.platformExecution.executionRoot), true, 'Successful but unaccepted evidence must remain until explicit cleanup.');
  await cleanupDeveloperExecution('recovery', success.platformExecution.executionId, { reason: 'test acceptance cleanup', confirmedBy: 'test' });
  assert.equal(await exists(success.platformExecution.executionRoot), false, 'Explicit cleanup removes an accepted execution.');

  console.log('Runtime recovery test passed: persistent Developer sessions, redacted events, retained process/apply failures, safe resume assessment, session continuation, and explicit cleanup.');
} finally {
  if (priorRegistry === undefined) delete process.env.CODING_AGENT_PROFILES;
  else process.env.CODING_AGENT_PROFILES = priorRegistry;
  if (priorMode === undefined) delete process.env.FAKE_CODEX_MODE;
  else process.env.FAKE_CODEX_MODE = priorMode;
  resetProjectConfigForTests();
  await rm(root, { recursive: true, force: true });
}
