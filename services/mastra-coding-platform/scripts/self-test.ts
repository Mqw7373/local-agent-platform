import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { listProjectProfiles, loadProjectConfig } from '../src/mastra/config.js';
import { frozenBundleSchema, projectConfigSchema } from '../src/mastra/schemas.js';
import { bundleIndexIssues } from '../src/mastra/preflight.js';
import { isInside, sha256 } from '../src/mastra/workspace.js';
import { instructionsForRole, PROMPT_AUTHORITY } from '../src/mastra/agents.js';
import { PONYTAIL_BINDING, verifyPonytailBinding } from '../src/mastra/ponytail.js';
import {
  assertDocumentPreflightReceipt,
  classifyVerificationFailure,
  developerBatchDisposition,
  routeReviewerDecision,
  sealDocumentPreflightReceipt,
} from '../src/mastra/workflow-policy.js';

const profiles = await listProjectProfiles();
assert.ok(profiles.length > 0);
for (const profile of profiles) {
  const profileConfig = await loadProjectConfig(profile.id);
  assert.equal(profileConfig.corePrompt.sha256, PROMPT_AUTHORITY.sha256, `${profile.id} Prompt SHA binding`);
  assert.equal(sha256(await readFile(profileConfig.corePrompt.path)), PROMPT_AUTHORITY.sha256, `${profile.id} Prompt bytes`);
}
const config = await loadProjectConfig(profiles[0].id);
assert.equal(projectConfigSchema.safeParse(config).success, true);
assert.equal(sha256(await readFile(config.corePrompt.path)), PROMPT_AUTHORITY.sha256);
assert.equal(PROMPT_AUTHORITY.revision, 'TC-SESSION-PROMPT-v2.9');
const promptDirectory = dirname(config.corePrompt.path);
const publicationManifest = JSON.parse(await readFile(join(promptDirectory, 'publication-manifest-v1.json'), 'utf8')) as {
  revision: string;
  files: Array<{ path: string; sha256: string }>;
};
assert.equal(publicationManifest.revision, PROMPT_AUTHORITY.revision);
for (const file of publicationManifest.files) {
  const bytes = await readFile(join(promptDirectory, file.path));
  assert.equal(sha256(bytes), file.sha256, `Prompt publication SHA mismatch for ${file.path}`);
  assert.equal(
    (await readFile(join(promptDirectory, `${file.path}.sha256`), 'utf8')).trim(),
    file.sha256,
    `Prompt sidecar mismatch for ${file.path}`,
  );
}
const workflowSource = await readFile(new URL('../src/mastra/workflow.ts', import.meta.url), 'utf8');
const agentSource = await readFile(new URL('../src/mastra/agents.ts', import.meta.url), 'utf8');
const bridgeSource = await readFile(new URL('./langgraph-runtime-bridge.ts', import.meta.url), 'utf8');
assert.equal(workflowSource.includes("role: 'final-challenger'"), false);
assert.equal(workflowSource.includes("phase: 'final-fresh-challenger'"), false);
assert.equal(agentSource.includes("'final-challenger':"), false);
assert.equal(workflowSource.includes('acceptedP2Ledger'), true);
assert.equal(workflowSource.includes("id: 'developer-verification-cycle'"), true);
assert.equal(workflowSource.includes("id: 'candidate-review-cycle'"), true);
assert.equal(workflowSource.includes('.parallel([reviewerStep, freshChallengerStep])'), false);
assert.equal(workflowSource.includes("disposition === 'ESCALATE'"), true);
assert.equal(workflowSource.match(/\.dountil\(/g)?.length, 2);
assert.equal(agentSource.includes('Fresh Clean-room Challenger'), true);
assert.equal(workflowSource.includes('runDeepSeekChallengerRole'), true);
assert.equal(bridgeSource.includes("if (role === 'challenger')"), true);
assert.equal(config.execution.roles.developer.model, 'gpt-6-astra');
assert.equal(config.execution.roles.reviewer.model, 'gpt-5.6-sol');
assert.equal(config.execution.roles.challenger.model, 'deepseek/deepseek-v4-flash');
assert.equal(config.execution.roles.challenger.backend, 'openai-compatible');
assert.equal(config.execution.roles.adjudicator.model, 'gpt-6-astra');
assert.deepEqual(config.developerOptimization.ponytail, {
  role: PONYTAIL_BINDING.role,
  mode: PONYTAIL_BINDING.mode,
  rollout: PONYTAIL_BINDING.rollout,
  version: PONYTAIL_BINDING.version,
  sourceCommit: PONYTAIL_BINDING.sourceCommit,
  sourceSha256: PONYTAIL_BINDING.sourceSha256,
  subagentInjection: false,
  upstreamHooksExecuted: false,
  authorityPrecedence: 'frozen-bundle-core-prompt-and-verification-first',
});
await verifyPonytailBinding();
const developerControlInstructions = await instructionsForRole(profiles[0].id, 'developer', 'control');
const developerTreatmentInstructions = await instructionsForRole(profiles[0].id, 'developer', 'ponytail-lite');
const reviewerInstructions = await instructionsForRole(profiles[0].id, 'reviewer', 'ponytail-lite');
assert.ok(developerControlInstructions.includes('CONTROL/OFF'));
assert.equal(developerControlInstructions.includes(PONYTAIL_BINDING.sourceCommit), false);
assert.ok(developerTreatmentInstructions.includes(PONYTAIL_BINDING.sourceCommit));
assert.ok(developerTreatmentInstructions.includes('Mandatory non-reduction rule'));
assert.ok(reviewerInstructions.includes('Ponytail status for this role: DISABLED'));
assert.equal(reviewerInstructions.includes('Ponytail Lite guidance:'), false);
assert.equal(isInside('C:\\project', 'C:\\project\\src\\index.ts'), true);
assert.equal(isInside('C:\\project', 'C:\\other\\secret.txt'), false);
assert.equal(Object.keys(config.documents).length, 5);
assert.ok(config.verificationCommands.length > 0);

const task = 'Implement the receipt-bound feature';
const bundleSha256 = '9'.repeat(64);
const preflightReceipt = sealDocumentPreflightReceipt({
  projectProfile: profiles[0].id,
  task,
  deterministic: {
    status: 'READY',
    bundleSha256,
    summary: 'Frozen bytes verified.',
    issues: [],
  },
  independentReview: {
    status: 'CONSISTENT',
    summary: 'Documents are sufficient.',
    issues: [],
  },
});
assert.equal(preflightReceipt.bundleSha256, bundleSha256);
assert.equal(assertDocumentPreflightReceipt({
  receipt: preflightReceipt,
  projectProfile: profiles[0].id,
  task,
  bundleSha256,
}).receiptId, preflightReceipt.receiptId);
assert.throws(() => assertDocumentPreflightReceipt({
  receipt: preflightReceipt,
  projectProfile: profiles[0].id,
  task: `${task} tampered`,
  bundleSha256,
}), /task binding/);
assert.deepEqual(developerBatchDisposition([], false), {
  cycleIncrement: 0,
  stop: false,
  summary: 'Developer returned no changed paths; verification will determine whether the frozen task was already satisfied, and the no-op did not consume a Developer cycle.',
});
assert.equal(developerBatchDisposition([], true).stop, true);
const profileFailure = classifyVerificationFailure({
  passed: false,
  commands: [{
    id: 'pytest',
    exitCode: 2,
    stdout: "ImportError while importing test module\nModuleNotFoundError: No module named 'test_example'",
    stderr: '',
    durationMs: 1,
    timedOut: false,
  }],
}, []);
assert.deepEqual(profileFailure.classifications, ['EXECUTION_VIOLATION', 'PROFILE_DEFECT']);
assert.equal(profileFailure.developerActionable, false);
const codeFailure = classifyVerificationFailure({
  passed: false,
  commands: [{
    id: 'focused-test',
    exitCode: 1,
    stdout: 'AssertionError: expected 2, received 1',
    stderr: '',
    durationMs: 1,
    timedOut: false,
  }],
}, ['src/example.ts']);
assert.deepEqual(codeFailure.classifications, ['CODE_DEFECT']);
assert.equal(codeFailure.developerActionable, true);
assert.equal(routeReviewerDecision({
  disposition: 'NO_P0_P1', summary: 'green', findings: [], escalationReasons: [],
}), 'HUMAN_CONFIRMATION');
assert.equal(routeReviewerDecision({
  disposition: 'DIRECT_CODE_REMEDIATION', summary: 'code',
  findings: [{
    findingId: 'REV-CODE-1', sourceProposalIds: ['reviewer'], accepted: true,
    severity: 'P1', rootCause: 'CODE_DEFECT', rationale: 'reachable', remediation: 'fix code',
  }],
  escalationReasons: [],
}), 'DEVELOP');
assert.equal(routeReviewerDecision({
  disposition: 'DIRECT_DOCUMENT_REVIEW', summary: 'document',
  findings: [{
    findingId: 'REV-DOC-1', sourceProposalIds: ['reviewer'], accepted: true,
    severity: 'P1', rootCause: 'FROZEN_DOCUMENT_DEFECT', rationale: 'contract gap', remediation: 'revise document',
  }],
  escalationReasons: [],
}), 'STOP_DOCUMENT');
assert.equal(routeReviewerDecision({
  disposition: 'DIRECT_EXTERNAL_STOP', summary: 'profile',
  findings: [{
    findingId: 'REV-EXT-1', sourceProposalIds: ['reviewer'], accepted: true,
    severity: 'P1', rootCause: 'PROFILE_DEFECT', rationale: 'profile mismatch', remediation: 'repair profile',
  }],
  escalationReasons: [],
}), 'STOP_EXTERNAL');
assert.equal(routeReviewerDecision({
  disposition: 'ESCALATE', summary: 'conflict', findings: [], escalationReasons: ['evidence conflict'],
}), 'ESCALATE');

const financialProfile = profiles.find(profile => profile.id === 'financial-agent-theme-stage3-codex-sessions-v1');
if (financialProfile) {
  const financialConfig = await loadProjectConfig(financialProfile.id);
  const pytestCommands = financialConfig.verificationCommands.filter(command => command.command === 'python');
  assert.ok(pytestCommands.slice(0, 2).every(command => command.env.PYTHONPATH === 'tests'));
  assert.ok(pytestCommands[1].args.includes('tests'));
  assert.ok(pytestCommands[1].args.includes('stage3_codex_sessions'));
}

const validBundle = frozenBundleSchema.parse({
  schema_version: '1',
  bundle_id: 'self-test',
  bundle_version: '1',
  bundle_status: 'FROZEN_FOR_IMPLEMENTATION',
  predecessor_bundle_sha256: null,
  objective: 'Exercise the full Frozen Bundle schema.',
  documents: [
    { document_roles: ['prd', 'acceptance_criteria'], path_or_embedded_id: 'docs/PRD.md', sha256: 'a'.repeat(64) },
    { document_roles: ['adr'], path_or_embedded_id: 'docs/adr.md', sha256: 'b'.repeat(64) },
    { document_roles: ['system_design'], path_or_embedded_id: 'docs/design.md', sha256: 'c'.repeat(64) },
    { document_roles: ['api_contract'], path_or_embedded_id: 'docs/api.md', sha256: 'd'.repeat(64) },
  ],
  allowed_scope: ['app/example.py'],
  forbidden_scope: ['docs/**'],
  acceptance_checks: ['example check'],
  changes_existing_persisted_data: false,
  human_approval: { status: 'APPROVED', reference: 'self-test approval' },
});
assert.deepEqual(bundleIndexIssues(validBundle), []);
assert.ok(bundleIndexIssues({ ...validBundle, allowed_scope: ['docs/example.md'] })
  .some(issue => issue.code === 'CONFLICT'));
assert.ok(bundleIndexIssues({ ...validBundle, changes_existing_persisted_data: true })
  .some(issue => issue.detail.includes('migration_contract')));

console.log('Self-test passed: config, Prompt binding, structured DocumentPreflightReceipt, classified verification routing, no-op cycle gate, Developer-only pinned Ponytail policy, path boundary, and Full Frozen Bundle gate.');
