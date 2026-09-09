import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { audit, type AuditEvent } from '../src/mastra/audit.js';
import { PROMPT_AUTHORITY } from '../src/mastra/agents.js';
import {
  DeveloperExecutionError,
  assessDeveloperRecovery,
  cleanupDeveloperExecution,
  getDeveloperRunProgress,
  recordDeveloperSideEffectReview,
  resumeDeveloperExecution,
  runDeveloperCodexRole,
  runReadOnlyCodexRole,
} from '../src/mastra/codex-cli.js';
import { getProjectConfig, listProjectProfiles } from '../src/mastra/config.js';
import { runDeepSeekChallengerRole } from '../src/mastra/deepseek-challenger.js';
import { deterministicPreflight } from '../src/mastra/preflight.js';
import {
  adjudicationDecisionSchema,
  developerResultSchema,
  documentConsistencySchema,
  documentPreflightReceiptSchema,
  documentPreflightSchema,
  reviewOutputSchema,
  reviewerDecisionSchema,
  verificationResultSchema,
} from '../src/mastra/schemas.js';
import { runAllVerification } from '../src/mastra/tools.js';
import {
  assertDocumentPreflightReceipt,
  classifyVerificationFailure,
  sealDocumentPreflightReceipt,
} from '../src/mastra/workflow-policy.js';
import { candidateSnapshot } from '../src/mastra/workspace.js';

type Request = {
  operation: string;
  projectProfile?: string;
  runId?: string;
  role?: 'document-preflight' | 'developer' | 'reviewer' | 'challenger' | 'adjudicator';
  phase?: string;
  input?: unknown;
  allowedScope?: string[];
  decision?: Record<string, unknown>;
  snapshotSha256?: string;
  bundleSha256?: string;
  task?: string;
  deterministicPreflight?: unknown;
  independentReview?: unknown;
  documentPreflightReceipt?: unknown;
  verification?: unknown;
  changedPaths?: string[];
  event?: AuditEvent;
  executionId?: string;
  cleanupApproval?: { reason: string; confirmedBy: string };
  sideEffectReview?: { status: 'NONE_OBSERVED' | 'SIDE_EFFECTS_DETECTED'; evidence: string[]; reviewedBy: string };
};

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function requireString(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required for this bridge operation.`);
  return value;
}

async function readRequest(): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Request;
}

async function runRole(request: Request) {
  const projectProfile = requireString(request.projectProfile, 'projectProfile');
  const role = request.role;
  const phase = requireString(request.phase, 'phase');
  if (!role) throw new Error('role is required for role execution.');
  if (role === 'developer') {
    return runDeveloperCodexRole({
      projectProfile,
      phase,
      runId: request.runId,
      input: request.input,
      outputSchema: developerResultSchema,
      allowedScope: request.allowedScope ?? [],
    });
  }
  if (role === 'document-preflight') {
    return runReadOnlyCodexRole({
      projectProfile, role, phase, runId: request.runId,
      input: request.input, outputSchema: documentConsistencySchema,
    });
  }
  if (role === 'adjudicator') {
    return runReadOnlyCodexRole({
      projectProfile, role, phase, runId: request.runId,
      input: request.input, outputSchema: adjudicationDecisionSchema,
    });
  }
  if (role === 'challenger') {
    return runDeepSeekChallengerRole({
      projectProfile, phase, runId: request.runId,
      input: request.input, outputSchema: reviewOutputSchema,
    });
  }
  return runReadOnlyCodexRole({
    projectProfile, role, phase, runId: request.runId,
    input: request.input, outputSchema: reviewerDecisionSchema,
  });
}

async function dispatch(request: Request): Promise<unknown> {
  const projectProfile = request.projectProfile;
  switch (request.operation) {
    case 'list-profiles':
      return { profiles: await listProjectProfiles(), promptAuthority: PROMPT_AUTHORITY };
    case 'config': {
      const config = await getProjectConfig(requireString(projectProfile, 'projectProfile'));
      return {
        profileId: config.profileId,
        projectName: config.projectName,
        projectRoot: config.projectRoot,
        runtimeDir: config.runtimeDir,
        bundleFile: config.bundleFile,
        documents: config.documents,
        maxCodeCycles: config.maxCodeCycles,
        developerOptimization: config.developerOptimization,
        promptAuthority: PROMPT_AUTHORITY,
      };
    }
    case 'preflight':
      return deterministicPreflight(requireString(projectProfile, 'projectProfile'));
    case 'seal-preflight-receipt': {
      const deterministic = documentPreflightSchema.parse(request.deterministicPreflight);
      const independentReview = documentConsistencySchema.parse(request.independentReview);
      if (independentReview.status !== 'CONSISTENT') {
        throw new Error('independentReview must be CONSISTENT to seal a preflight receipt.');
      }
      return sealDocumentPreflightReceipt({
        projectProfile: requireString(projectProfile, 'projectProfile'),
        task: requireString(request.task, 'task'),
        deterministic,
        independentReview: { ...independentReview, status: 'CONSISTENT' },
      });
    }
    case 'validate-preflight-receipt':
      return assertDocumentPreflightReceipt({
        receipt: documentPreflightReceiptSchema.parse(request.documentPreflightReceipt),
        projectProfile: requireString(projectProfile, 'projectProfile'),
        task: requireString(request.task, 'task'),
        bundleSha256: requireString(request.bundleSha256, 'bundleSha256'),
      });
    case 'role':
      return runRole(request);
    case 'verify':
      return runAllVerification(requireString(projectProfile, 'projectProfile'));
    case 'classify-verification':
      return classifyVerificationFailure(
        verificationResultSchema.parse(request.verification),
        request.changedPaths ?? [],
      );
    case 'snapshot':
      return candidateSnapshot(requireString(projectProfile, 'projectProfile'));
    case 'developer-progress':
      return getDeveloperRunProgress(
        requireString(projectProfile, 'projectProfile'),
        requireString(request.runId, 'runId'),
      );
    case 'assess-developer-recovery':
      return assessDeveloperRecovery(
        requireString(projectProfile, 'projectProfile'),
        requireString(request.executionId, 'executionId'),
      );
    case 'review-developer-side-effects':
      if (!request.sideEffectReview) throw new Error('sideEffectReview is required.');
      await recordDeveloperSideEffectReview(
        requireString(projectProfile, 'projectProfile'),
        requireString(request.executionId, 'executionId'),
        request.sideEffectReview,
      );
      return { recorded: true };
    case 'resume-developer-execution':
      return resumeDeveloperExecution({
        projectProfile: requireString(projectProfile, 'projectProfile'),
        executionId: requireString(request.executionId, 'executionId'),
        outputSchema: developerResultSchema,
      });
    case 'cleanup-developer-execution':
      if (!request.cleanupApproval) throw new Error('cleanupApproval is required.');
      await cleanupDeveloperExecution(
        requireString(projectProfile, 'projectProfile'),
        requireString(request.executionId, 'executionId'),
        request.cleanupApproval,
      );
      return { cleaned: true };
    case 'seal-decision': {
      const snapshotSha256 = requireString(request.snapshotSha256, 'snapshotSha256');
      if (!request.decision) throw new Error('decision is required for seal-decision.');
      const unsealed = { ...request.decision, decisionId: '', snapshotSha256 };
      const sealed = {
        ...unsealed,
        decisionId: `ADJ-${sha256(JSON.stringify(unsealed)).slice(0, 20)}`,
      };
      return adjudicationDecisionSchema.parse(sealed);
    }
    case 'audit':
      if (!request.event) throw new Error('event is required for audit.');
      await audit(requireString(projectProfile, 'projectProfile'), request.event);
      return { recorded: true };
    case 'read-prompt': {
      const config = await getProjectConfig(requireString(projectProfile, 'projectProfile'));
      return { authority: PROMPT_AUTHORITY, content: await readFile(config.corePrompt.path, 'utf8') };
    }
    default:
      throw new Error(`Unsupported bridge operation: ${request.operation}`);
  }
}

try {
  const result = await dispatch(await readRequest());
  process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
} catch (error) {
  const details = error instanceof DeveloperExecutionError
    ? {
        code: error.code,
        executionId: error.executionId,
        executionRoot: error.executionRoot,
        workspaceRoot: error.workspaceRoot,
        recoveryManifestFile: error.recoveryManifestFile,
        recoverable: true,
      }
    : undefined;
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    details,
  })}\n`);
  process.exitCode = 1;
}
