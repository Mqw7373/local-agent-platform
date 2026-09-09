import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { runDeveloperCodexDryRun } from '../src/mastra/codex-cli.js';
import { getProjectConfig } from '../src/mastra/config.js';
import {
  PONYTAIL_BINDING,
  verifyPonytailBinding,
  type DeveloperPromptVariant,
} from '../src/mastra/ponytail.js';
import { developerResultSchema } from '../src/mastra/schemas.js';

const execFileAsync = promisify(execFile);
const fixturePackageSource = `${JSON.stringify({
  name: 'ponytail-ab-date-picker',
  private: true,
  type: 'module',
}, null, 2)}\n`;

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredArgument(name: string): string {
  const value = argument(name);
  if (!value) throw new Error('Usage: npm run ponytail-ab-test -- --profile <enabled-profile-id>');
  return value;
}

const projectProfile = requiredArgument('--profile');

async function command(executable: string, args: string[], cwd: string, timeout = 120_000) {
  try {
    const result = await execFileAsync(executable, args, {
      cwd,
      encoding: 'utf8',
      timeout,
      windowsHide: true,
      maxBuffer: 2_000_000,
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    return {
      exitCode: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? failure.message,
    };
  }
}

async function initializeFixture(root: string): Promise<void> {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), fixturePackageSource, 'utf8');
  await writeFile(path.join(root, 'README.md'), [
    '# Date picker fixture',
    '',
    'This deliberately tiny repository contains no UI dependencies.',
    '',
  ].join('\n'), 'utf8');
  for (const args of [
    ['init', '-b', 'ponytail-ab'],
    ['add', '-A'],
    ['-c', 'user.name=Local Agent Platform', '-c', 'user.email=local-agent-platform@invalid', 'commit', '-m', 'A/B baseline', '--quiet'],
  ]) {
    const result = await command('git', args, root);
    if (result.exitCode !== 0) throw new Error(`A/B fixture git setup failed: ${result.stderr}`);
  }
}

const verifierSource = `
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const root = process.argv[2];
const moduleUrl = pathToFileURL(path.join(root, 'src', 'date-picker.mjs')).href;
const { renderDatePicker } = await import(moduleUrl);

const html = renderDatePicker({
  id: 'trade-date',
  name: 'trade&date',
  label: 'When <now>',
  value: '2026-09-08',
  min: '2026-01-01',
  max: '2026-12-31',
});
assert.match(html, /<label\\b/);
assert.match(html, /for=["']trade-date["']/);
assert.match(html, /When &lt;now&gt;/);
assert.match(html, /<input\\b/);
assert.match(html, /type=["']date["']/);
assert.match(html, /name=["']trade&amp;date["']/);
assert.match(html, /value=["']2026-09-08["']/);
assert.match(html, /min=["']2026-01-01["']/);
assert.match(html, /max=["']2026-12-31["']/);
assert.throws(() => renderDatePicker({ id: '', name: 'date', label: 'Date' }));
assert.throws(() => renderDatePicker({ id: 'date', name: 'date', label: 'Date', value: '09/08/2026' }));
console.log('hidden acceptance verifier passed');
`;

const task = `
Implement an accessible reusable date-picker field for this tiny JavaScript repository.

Frozen acceptance contract:
- Create src/date-picker.mjs and export renderDatePicker(options).
- options contains non-empty string id, name, and label; value defaults to an empty string; min and max are optional.
- value, min, and max must be empty or strict YYYY-MM-DD calendar dates. Reject invalid inputs instead of silently repairing them.
- Return HTML containing a label bound to a native input type="date". Include value and supplied min/max.
- Escape all caller-provided text before placing it in HTML text or attributes.
- Add no dependency and do not modify package.json.
- Inspect the repository, implement the complete contract, and report the actual changed paths. Do not claim GO.
`;

const frozenBundle = {
  schema_version: '1',
  bundle_id: 'ponytail-ab-date-picker-v1',
  bundle_version: '1',
  bundle_status: 'FROZEN_FOR_IMPLEMENTATION',
  objective: 'Implement the smallest correct accessible native date-picker field.',
  allowed_scope: ['src/date-picker.mjs'],
  forbidden_scope: ['package.json'],
  acceptance_checks: [
    'hidden verifier validates native date input, accessibility binding, escaping, and strict dates',
    'package.json remains byte-identical',
  ],
  human_approval: { status: 'APPROVED', reference: 'Ponytail A/B fixture contract' },
};

type ArmResult = {
  variant: DeveloperPromptVariant;
  durationMs: number;
  actualChangedPaths: string[];
  reported: unknown;
  verification: { passed: boolean; stdout: string; stderr: string };
  diff: { insertions: number; deletions: number; sha256: string; text: string };
};

async function runArm(
  experimentRoot: string,
  verifierFile: string,
  variant: DeveloperPromptVariant,
): Promise<ArmResult> {
  const workspaceRoot = path.join(experimentRoot, variant);
  await mkdir(workspaceRoot, { recursive: true });
  await initializeFixture(workspaceRoot);
  const started = Date.now();
  const execution = await runDeveloperCodexDryRun({
    projectProfile,
    phase: `ponytail-ab-${variant}`,
    runId: `${path.basename(experimentRoot)}-${variant}`,
    developerPromptVariant: variant,
    workspaceRoot,
    outputSchema: developerResultSchema,
    input: {
      phase: 'isolated-ab-experiment',
      task,
      objective: frozenBundle.objective,
      frozenBundleSha256: createHash('sha256').update(JSON.stringify(frozenBundle)).digest('hex'),
      frozenBundle,
      sealedRemediationDecision: null,
      verificationFailure: null,
      instruction: 'Implement the frozen synthetic task in this isolated experiment arm.',
    },
  });
  const durationMs = Date.now() - started;
  const verification = await command(process.execPath, [verifierFile, workspaceRoot], workspaceRoot);
  const packageUnchanged = await readFile(path.join(workspaceRoot, 'package.json'), 'utf8') === fixturePackageSource;
  await command('git', ['add', '-N', '.'], workspaceRoot);
  const diffResult = await command('git', ['diff', '--no-ext-diff', '--no-color', '--unified=3'], workspaceRoot);
  const numstat = await command('git', ['diff', '--numstat'], workspaceRoot);
  let insertions = 0;
  let deletions = 0;
  for (const line of numstat.stdout.trim().split(/\r?\n/).filter(Boolean)) {
    const [added, removed] = line.split('\t');
    if (/^\d+$/.test(added)) insertions += Number(added);
    if (/^\d+$/.test(removed)) deletions += Number(removed);
  }
  return {
    variant,
    durationMs,
    actualChangedPaths: execution.actualChangedPaths,
    reported: execution.result,
    verification: {
      passed: verification.exitCode === 0 && packageUnchanged,
      stdout: verification.stdout,
      stderr: `${verification.stderr}${packageUnchanged ? '' : '\npackage.json was modified'}`.trim(),
    },
    diff: {
      insertions,
      deletions,
      sha256: createHash('sha256').update(diffResult.stdout).digest('hex'),
      text: diffResult.stdout,
    },
  };
}

await verifyPonytailBinding();
const config = await getProjectConfig(projectProfile);
const experimentId = `ponytail-ab-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
const experimentRoot = await mkdtemp(path.join(os.tmpdir(), `${experimentId}-`));
const verifierFile = path.join(experimentRoot, 'hidden-verifier.mjs');
await writeFile(verifierFile, verifierSource, 'utf8');

try {
  const control = await runArm(experimentRoot, verifierFile, 'control');
  const treatment = await runArm(experimentRoot, verifierFile, 'ponytail-lite');
  const report = {
    experimentId,
    createdAt: new Date().toISOString(),
    projectProfile,
    model: config.execution.roles.developer.model,
    design: {
      sameSyntheticTask: true,
      isolatedWorkspaces: true,
      productRepositoryMutated: false,
      upstreamHooksExecuted: false,
      subagentInjection: false,
      binding: PONYTAIL_BINDING,
    },
    arms: { control, treatment },
    comparison: {
      bothPassedHiddenVerification: control.verification.passed && treatment.verification.passed,
      treatmentInsertionDelta: treatment.diff.insertions - control.diff.insertions,
      treatmentDeletionDelta: treatment.diff.deletions - control.diff.deletions,
      treatmentDurationDeltaMs: treatment.durationMs - control.durationMs,
    },
    rolloutDecision: 'NO_AUTOMATIC_ROLLOUT',
    limitations: [
      'n=1 is directional evidence only.',
      'Codex executions are nondeterministic and were run sequentially.',
      'The fixture measures a bounded over-engineering trap, not production-repository outcomes.',
      'Reviewer, Challenger, and Adjudicator were intentionally excluded because Ponytail is Developer-only.',
    ],
  };
  const outputDirectory = path.join(config.runtimeDir, 'experiments');
  await mkdir(outputDirectory, { recursive: true });
  const reportFile = path.join(outputDirectory, `${experimentId}.json`);
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ reportFile, report }, null, 2)}\n`);
} finally {
  await rm(experimentRoot, { recursive: true, force: true });
}
