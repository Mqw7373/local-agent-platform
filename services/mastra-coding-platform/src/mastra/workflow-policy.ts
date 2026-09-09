import {
  documentPreflightReceiptSchema,
  type DocumentPreflight,
  type DocumentPreflightReceipt,
  type VerificationFailureDiagnosis,
  type VerificationResult,
  reviewerDecisionSchema,
  type ReviewerDecision,
} from './schemas.js';
import { sha256 } from './workspace.js';

type ConsistentDocumentReview = {
  status: 'CONSISTENT';
  summary: string;
  issues: DocumentPreflight['issues'];
};

function receiptPayload(receipt: Omit<DocumentPreflightReceipt, 'receiptId'>) {
  return {
    receiptVersion: receipt.receiptVersion,
    projectProfile: receipt.projectProfile,
    taskSha256: receipt.taskSha256,
    bundleSha256: receipt.bundleSha256,
    deterministic: receipt.deterministic,
    independentReview: receipt.independentReview,
  } as const;
}

export function sealDocumentPreflightReceipt(options: {
  projectProfile: string;
  task: string;
  deterministic: DocumentPreflight;
  independentReview: ConsistentDocumentReview;
}): DocumentPreflightReceipt {
  if (options.deterministic.status !== 'READY' || !options.deterministic.bundleSha256) {
    throw new Error('Cannot seal DocumentPreflightReceipt without a READY deterministic preflight and Bundle SHA.');
  }
  if (options.deterministic.issues.length || options.independentReview.issues.length) {
    throw new Error('Cannot seal DocumentPreflightReceipt with unresolved issues.');
  }
  const payload = receiptPayload({
    receiptVersion: '1',
    projectProfile: options.projectProfile,
    taskSha256: sha256(options.task),
    bundleSha256: options.deterministic.bundleSha256,
    deterministic: {
      status: 'READY',
      summary: options.deterministic.summary,
      issues: [],
    },
    independentReview: options.independentReview,
  });
  return documentPreflightReceiptSchema.parse({
    ...payload,
    receiptId: `DPF-${sha256(JSON.stringify(payload)).slice(0, 20)}`,
  });
}

export function assertDocumentPreflightReceipt(options: {
  receipt: DocumentPreflightReceipt;
  projectProfile: string;
  task: string;
  bundleSha256: string;
}): DocumentPreflightReceipt {
  const receipt = documentPreflightReceiptSchema.parse(options.receipt);
  const payload = receiptPayload(receipt);
  const expectedId = `DPF-${sha256(JSON.stringify(payload)).slice(0, 20)}`;
  if (receipt.receiptId !== expectedId) throw new Error('DocumentPreflightReceipt content hash is invalid.');
  if (receipt.projectProfile !== options.projectProfile) {
    throw new Error('DocumentPreflightReceipt projectProfile does not match the Developer request.');
  }
  if (receipt.taskSha256 !== sha256(options.task)) {
    throw new Error('DocumentPreflightReceipt task binding does not match the Developer request.');
  }
  if (receipt.bundleSha256 !== options.bundleSha256) {
    throw new Error('DocumentPreflightReceipt Bundle SHA does not match frozen authority.');
  }
  return receipt;
}

export function developerBatchDisposition(
  changedPaths: string[],
  remediationRequested: boolean,
): { cycleIncrement: 0 | 1; stop: boolean; summary?: string } {
  if (changedPaths.length) return { cycleIncrement: 1, stop: false };
  if (remediationRequested) {
    return {
      cycleIncrement: 0,
      stop: true,
      summary: 'EXECUTION_VIOLATION: Developer returned no changed paths for a required remediation batch; the no-op did not consume a Developer cycle.',
    };
  }
  return {
    cycleIncrement: 0,
    stop: false,
    summary: 'Developer returned no changed paths; verification will determine whether the frozen task was already satisfied, and the no-op did not consume a Developer cycle.',
  };
}

export function classifyVerificationFailure(
  verification: VerificationResult,
  changedPaths: string[],
): VerificationFailureDiagnosis {
  if (verification.passed) throw new Error('Cannot classify a passing verification result as a failure.');
  const classifications = new Set<VerificationFailureDiagnosis['classifications'][number]>();
  const evidence: string[] = [];

  if (!changedPaths.length) {
    classifications.add('EXECUTION_VIOLATION');
    evidence.push('Developer reported and produced changedPaths=[].');
  }

  for (const command of verification.commands) {
    const output = `${command.stdout}\n${command.stderr}`;
    if (command.timedOut) {
      classifications.add('PLATFORM_LIMITATION');
      evidence.push(`${command.id}: command timed out.`);
      continue;
    }
    if (command.exitCode === null || /\b(?:ENOENT|spawn .* failed|command not found)\b/i.test(output)) {
      classifications.add('PLATFORM_LIMITATION');
      evidence.push(`${command.id}: command could not execute.`);
      continue;
    }
    if (
      /No module named ['"]test_[^'"]+['"]/i.test(output)
      || /ERROR:\s+file or directory not found/i.test(output)
    ) {
      classifications.add('PROFILE_DEFECT');
      evidence.push(`${command.id}: test collection/import/filter configuration failed before feature assertions ran.`);
    }
  }

  if (!classifications.has('PLATFORM_LIMITATION') && !classifications.has('PROFILE_DEFECT')) {
    if (changedPaths.length) {
      classifications.add('CODE_DEFECT');
      evidence.push('Verification failed after a non-empty Developer diff and no external failure signature was detected.');
    } else {
      classifications.add('BASELINE_FAILURE');
      evidence.push('Verification failed against an unchanged candidate, so the failure is present in the baseline snapshot.');
    }
  }

  const values = [...classifications];
  const developerActionable = values.length === 1 && values[0] === 'CODE_DEFECT';
  return {
    classifications: values,
    developerActionable,
    summary: developerActionable
      ? 'Verification evidence is bound to the current code diff and may return to Developer.'
      : `Verification stopped outside Developer after classification: ${values.join(' + ')}.`,
    evidence,
  };
}

export type ReviewerRoute = 'HUMAN_CONFIRMATION' | 'DEVELOP' | 'STOP_DOCUMENT' | 'STOP_EXTERNAL' | 'ESCALATE';

export function routeReviewerDecision(input: ReviewerDecision): ReviewerRoute {
  const decision = reviewerDecisionSchema.parse(input);
  const blocking = decision.findings.filter(
    finding => finding.accepted && (finding.severity === 'P0' || finding.severity === 'P1'),
  );
  const roots = new Set(blocking.map(finding => finding.rootCause));

  if (decision.disposition === 'ESCALATE') {
    if (!decision.escalationReasons.length) {
      throw new Error('Reviewer ESCALATE requires at least one escalation reason.');
    }
    return 'ESCALATE';
  }
  if (decision.findings.some(finding => !finding.accepted)) {
    throw new Error('Direct Reviewer dispositions may contain only accepted authoritative findings.');
  }
  if (decision.escalationReasons.length) {
    throw new Error('Reviewer escalation reasons are only valid for ESCALATE.');
  }
  if (decision.disposition === 'NO_P0_P1') {
    if (blocking.length) throw new Error('NO_P0_P1 cannot contain accepted P0/P1 findings.');
    return 'HUMAN_CONFIRMATION';
  }
  if (!blocking.length) {
    throw new Error(`${decision.disposition} requires at least one accepted P0/P1 finding.`);
  }
  if (decision.disposition === 'DIRECT_CODE_REMEDIATION') {
    if (roots.size !== 1 || !roots.has('CODE_DEFECT')) {
      throw new Error('DIRECT_CODE_REMEDIATION requires all accepted P0/P1 findings to be CODE_DEFECT.');
    }
    return 'DEVELOP';
  }
  if (decision.disposition === 'DIRECT_DOCUMENT_REVIEW') {
    if (roots.size !== 1 || !roots.has('FROZEN_DOCUMENT_DEFECT')) {
      throw new Error('DIRECT_DOCUMENT_REVIEW requires all accepted P0/P1 findings to be FROZEN_DOCUMENT_DEFECT.');
    }
    return 'STOP_DOCUMENT';
  }
  if (roots.has('CODE_DEFECT') || roots.has('FROZEN_DOCUMENT_DEFECT') || roots.has('INSUFFICIENT_EVIDENCE')) {
    throw new Error('DIRECT_EXTERNAL_STOP cannot contain code, frozen-document, or insufficient-evidence P0/P1 findings.');
  }
  return 'STOP_EXTERNAL';
}
