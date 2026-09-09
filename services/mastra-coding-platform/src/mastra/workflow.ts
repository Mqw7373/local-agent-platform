import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { audit } from './audit.js';
import { PROMPT_AUTHORITY } from './agents.js';
import { runDeveloperCodexRole, runReadOnlyCodexRole } from './codex-cli.js';
import { getProjectConfig } from './config.js';
import { runDeepSeekChallengerRole } from './deepseek-challenger.js';
import { deterministicPreflight } from './preflight.js';
import {
  adjudicatedFindingSchema,
  adjudicationDecisionSchema,
  cycleOutputSchema,
  developerResultSchema,
  documentConsistencySchema,
  documentPreflightReceiptSchema,
  documentPreflightSchema,
  frozenBundleSchema,
  humanResumeSchema,
  humanSuspendSchema,
  reviewOutputSchema,
  reviewerDecisionSchema,
  verificationResultSchema,
  verificationFailureDiagnosisSchema,
  workflowInputSchema,
  type AdjudicationDecision,
  type CycleOutput,
  type FrozenBundle,
  type ReviewOutput,
  type ReviewerDecision,
  type VerificationFailureDiagnosis,
} from './schemas.js';
import { runAllVerification } from './tools.js';
import {
  assertDocumentPreflightReceipt,
  classifyVerificationFailure,
  developerBatchDisposition,
  routeReviewerDecision,
  sealDocumentPreflightReceipt,
} from './workflow-policy.js';
import { candidateSnapshot, sha256 } from './workspace.js';

const routeSchema = z.enum([
  'DOCUMENT_PREFLIGHT', 'DEVELOP', 'VERIFY', 'VERIFICATION_REPAIR',
  'REVIEW', 'HUMAN_CONFIRMATION', 'STOP_DOCUMENT', 'STOP_CODE', 'STOP_EXTERNAL',
]);

const cycleStateSchema = z.object({
  projectProfile: z.string(),
  task: z.string(),
  route: routeSchema,
  promptAuthority: z.object({ revision: z.string(), sha256: z.string() }).optional(),
  objective: z.string().optional(),
  bundle: frozenBundleSchema.optional(),
  bundleSha256: z.string().optional(),
  deterministicPreflight: documentPreflightSchema.optional(),
  documentPreflightReceipt: documentPreflightReceiptSchema.optional(),
  snapshotSha256: z.string().optional(),
  cycleCount: z.number().int().nonnegative(),
  summary: z.string(),
  developerResult: developerResultSchema.optional(),
  verification: verificationResultSchema.optional(),
  verificationDiagnosis: verificationFailureDiagnosisSchema.optional(),
  decision: adjudicationDecisionSchema.optional(),
  acceptedP2Ledger: z.array(adjudicatedFindingSchema),
  openFindings: z.array(adjudicatedFindingSchema),
});

type CycleState = z.infer<typeof cycleStateSchema>;

const reviewEnvelopeSchema = z.object({
  state: cycleStateSchema,
  reviewerDecision: reviewerDecisionSchema.optional(),
  platformLimitation: z.string().optional(),
});

const escalationEnvelopeSchema = z.object({
  state: cycleStateSchema,
  reviewerDecision: reviewerDecisionSchema.optional(),
  challengerReview: reviewOutputSchema.optional(),
  platformLimitation: z.string().optional(),
});

function acceptedBlocking(decision?: AdjudicationDecision) {
  return (decision?.findings ?? []).filter(
    finding => finding.accepted && (finding.severity === 'P0' || finding.severity === 'P1'),
  );
}

function retainAcceptedP2(ledger: AdjudicationDecision['findings'], decision: AdjudicationDecision) {
  const retained = new Map(ledger.map(finding => [finding.findingId, finding]));
  for (const finding of decision.findings) {
    if (finding.accepted && finding.severity === 'P2' && !retained.has(finding.findingId)) {
      retained.set(finding.findingId, finding);
    }
  }
  return [...retained.values()];
}

function sealDecision(decision: AdjudicationDecision, snapshotSha256: string): AdjudicationDecision {
  const unsealed = { ...decision, decisionId: '', snapshotSha256 };
  return { ...unsealed, decisionId: `ADJ-${sha256(JSON.stringify(unsealed)).slice(0, 20)}` };
}

function requireAuthority(state: CycleState): {
  objective: string;
  bundle: FrozenBundle;
  bundleSha256: string;
} {
  if (!state.objective || !state.bundle || !state.bundleSha256) {
    throw new Error('Frozen authority is unavailable after Document Preflight.');
  }
  return { objective: state.objective, bundle: state.bundle, bundleSha256: state.bundleSha256 };
}

function assertCurrentPromptAuthority(state: CycleState): void {
  if (
    state.promptAuthority?.revision !== PROMPT_AUTHORITY.revision
    || state.promptAuthority?.sha256 !== PROMPT_AUTHORITY.sha256
  ) {
    throw new Error(
      `PROMPT_AUTHORITY_DRIFT: run is bound to ${state.promptAuthority?.revision ?? 'unknown'} `
      + `${state.promptAuthority?.sha256 ?? 'unknown'}, but this runtime serves `
      + `${PROMPT_AUTHORITY.revision} ${PROMPT_AUTHORITY.sha256}. Start a new run or use the original runtime.`,
    );
  }
}

async function reviewPrompt(state: CycleState) {
  const authority = requireAuthority(state);
  const closureFindings = acceptedBlocking(state.decision);
  return {
    role: 'reviewer',
    task: state.task,
    objective: authority.objective,
    bundleSha256: authority.bundleSha256,
    candidateSnapshotSha256: state.snapshotSha256,
    verification: state.verification,
    changedPaths: state.developerResult?.changedPaths ?? [],
    closureFindings,
    reviewCycle: state.cycleCount,
    instruction: closureFindings.length
      ? 'Check closure of every supplied accepted finding and inspect changed and adjacent reachable paths. Return one Reviewer Decision using the direct-route contract; ESCALATE only for high risk, insufficient evidence, or conflicting root cause.'
      : 'Perform independent discovery against the frozen authority. Return one Reviewer Decision. Route clear code, document, external, or no-P0/P1 outcomes directly; ESCALATE only for high risk, insufficient evidence, or conflicting conclusions.',
  };
}

async function adjudicate(state: CycleState, reviewerDecision: ReviewerDecision, challengerReview: ReviewOutput, runId?: string) {
  if (!state.snapshotSha256 || !state.verification) {
    throw new Error('Adjudication requires a verified candidate snapshot.');
  }
  const decision = await runReadOnlyCodexRole({
    projectProfile: state.projectProfile,
    role: 'adjudicator',
    phase: 'candidate-adjudication',
    runId,
    outputSchema: adjudicationDecisionSchema,
    input: {
      phase: 'candidate-adjudication',
      task: state.task,
      reviewCycle: state.cycleCount,
      candidateSnapshotSha256: state.snapshotSha256,
      verification: state.verification,
      reviewerDecision,
      challengerProposalSet: challengerReview,
      rule: 'Resolve only the escalated high-risk, evidence-insufficient, or conflicting matter. Accept or reject each material finding/proposal, assign final severity and root cause, preserve P2, and produce one complete decision batch.',
    },
  });
  const sealed = sealDecision(decision, state.snapshotSha256);
  await audit(state.projectProfile, {
    runId, actor: 'adjudicator', action: 'sealed-decision',
    phase: 'candidate-adjudication', data: sealed,
  });
  return sealed;
}

function sealReviewerRouteDecision(decision: ReviewerDecision, snapshotSha256: string): AdjudicationDecision {
  const unsealed = {
    decisionId: '',
    snapshotSha256,
    summary: decision.summary,
    findings: decision.findings,
  };
  return {
    ...unsealed,
    decisionId: `REV-${sha256(JSON.stringify(unsealed)).slice(0, 20)}`,
  };
}

function applyReviewerDirectRoute(state: CycleState, reviewerDecision: ReviewerDecision): CycleState {
  if (!state.snapshotSha256) throw new Error('Reviewer routing requires a candidate snapshot SHA.');
  const route = routeReviewerDecision(reviewerDecision);
  if (route === 'ESCALATE') return state;
  const decision = sealReviewerRouteDecision(reviewerDecision, state.snapshotSha256);
  const acceptedP2Ledger = retainAcceptedP2(state.acceptedP2Ledger, decision);
  const blocking = acceptedBlocking(decision);
  if (route === 'DEVELOP') {
    return {
      ...state, route, decision, acceptedP2Ledger,
      openFindings: [...blocking, ...acceptedP2Ledger],
      summary: 'Reviewer found clear code P0/P1 and returned one sealed remediation batch to Developer.',
    };
  }
  if (route === 'STOP_DOCUMENT') {
    return {
      ...state, route, decision, acceptedP2Ledger,
      openFindings: [...blocking, ...acceptedP2Ledger],
      summary: 'Reviewer found clear document P0/P1; Document Owner revision, human approval, and a superseding Bundle are required.',
    };
  }
  if (route === 'STOP_EXTERNAL') {
    return {
      ...state, route, decision, acceptedP2Ledger,
      openFindings: [...blocking, ...acceptedP2Ledger],
      summary: 'Reviewer found a clear blocking issue that requires baseline, platform, product, or external resolution.',
    };
  }
  return {
    ...state, route, decision, acceptedP2Ledger,
    openFindings: acceptedP2Ledger,
    summary: 'Automated verification passed and Reviewer found no P0/P1. Human final confirmation is required.',
  };
}

const runtimePreflightStep = createStep({
  id: 'runtime-and-bundle-preflight',
  description: 'Validates the selected profile, immutable Frozen Bundle, inventory, hashes, approval, and scope before Developer.',
  inputSchema: workflowInputSchema,
  outputSchema: cycleStateSchema,
  execute: async ({ inputData, runId }): Promise<CycleState> => {
    await audit(inputData.projectProfile, {
      runId, actor: 'orchestrator', action: 'cycle-start', phase: 'preflight', data: inputData,
    });
    const preflight = await deterministicPreflight(inputData.projectProfile);
    if (preflight.result.status !== 'READY' || !preflight.result.bundleSha256 || !preflight.objective || !preflight.bundle) {
      return {
        projectProfile: inputData.projectProfile,
        task: inputData.task,
        route: 'STOP_DOCUMENT',
        bundleSha256: preflight.result.bundleSha256,
        cycleCount: 0,
        summary: preflight.result.summary,
        acceptedP2Ledger: [],
        openFindings: [],
      };
    }
    return {
      projectProfile: inputData.projectProfile,
      task: inputData.task,
      route: 'DOCUMENT_PREFLIGHT',
      promptAuthority: PROMPT_AUTHORITY,
      objective: preflight.objective,
      bundle: preflight.bundle,
      bundleSha256: preflight.result.bundleSha256,
      deterministicPreflight: preflight.result,
      cycleCount: 0,
      summary: 'Deterministic Runtime and Frozen Bundle Preflight passed.',
      acceptedP2Ledger: [],
      openFindings: [],
    };
  },
});

const documentPreflightStep = createStep({
  id: 'document-preflight',
  description: 'An isolated read-only gpt-5.6-sol Codex role checks that frozen product documents are consistent and sufficient for the task.',
  inputSchema: cycleStateSchema,
  outputSchema: cycleStateSchema,
  execute: async ({ inputData, runId }): Promise<CycleState> => {
    if (inputData.route !== 'DOCUMENT_PREFLIGHT') return inputData;
    assertCurrentPromptAuthority(inputData);
    const authority = requireAuthority(inputData);
    const config = await getProjectConfig(inputData.projectProfile);
    const consistency = await runReadOnlyCodexRole({
      projectProfile: inputData.projectProfile,
      role: 'document-preflight',
      phase: 'document-preflight',
      runId,
      outputSchema: documentConsistencySchema,
      input: {
        task: inputData.task,
        frozenObjective: authority.objective,
        frozenBundle: authority.bundle,
        configuredDocuments: config.documents,
        instruction: 'Read the configured frozen documents and check only material consistency and sufficiency for this task.',
      },
    });
    await audit(inputData.projectProfile, {
      runId, actor: 'document-preflight', action: 'consistency-check',
      phase: 'document-preflight', data: consistency,
    });
    if (consistency.status !== 'CONSISTENT' || consistency.issues.length) {
      return { ...inputData, route: 'STOP_DOCUMENT', summary: consistency.summary };
    }
    if (!inputData.deterministicPreflight) {
      throw new Error('Deterministic preflight evidence is missing before DocumentPreflightReceipt sealing.');
    }
    const receipt = sealDocumentPreflightReceipt({
      projectProfile: inputData.projectProfile,
      task: inputData.task,
      deterministic: inputData.deterministicPreflight,
      independentReview: { ...consistency, status: 'CONSISTENT' },
    });
    await audit(inputData.projectProfile, {
      runId, actor: 'orchestrator', action: 'document-preflight-receipt-sealed',
      phase: 'document-preflight', data: receipt,
    });
    return {
      ...inputData,
      route: 'DEVELOP',
      summary: consistency.summary,
      documentPreflightReceipt: receipt,
    };
  },
});

const developerStep = createStep({
  id: 'developer',
  description: 'The sole product-write gpt-6-astra Codex role implements the frozen task or repairs one sealed batch in an isolated mirror.',
  inputSchema: cycleStateSchema,
  outputSchema: cycleStateSchema,
  execute: async ({ inputData, runId }): Promise<CycleState> => {
    if (!['DEVELOP', 'VERIFICATION_REPAIR'].includes(inputData.route)) return inputData;
    assertCurrentPromptAuthority(inputData);
    const authority = requireAuthority(inputData);
    if (!inputData.documentPreflightReceipt) {
      throw new Error('Developer dispatch denied: DocumentPreflightReceipt is missing.');
    }
    const preflightReceipt = assertDocumentPreflightReceipt({
      receipt: inputData.documentPreflightReceipt,
      projectProfile: inputData.projectProfile,
      task: inputData.task,
      bundleSha256: authority.bundleSha256,
    });
    const config = await getProjectConfig(inputData.projectProfile);
    if (inputData.cycleCount >= config.maxCodeCycles) {
      return {
        ...inputData,
        route: 'STOP_CODE',
        summary: `Reached maxCodeCycles=${config.maxCodeCycles} before the next Developer batch.`,
        openFindings: [...acceptedBlocking(inputData.decision), ...inputData.acceptedP2Ledger],
      };
    }
    const phase = inputData.cycleCount === 0
      ? 'initial-development'
      : inputData.route === 'VERIFICATION_REPAIR'
        ? 'verification-remediation'
        : 'code-remediation';
    const verificationFailure = inputData.route === 'VERIFICATION_REPAIR' ? inputData.verification : undefined;
    const result = await runDeveloperCodexRole({
      projectProfile: inputData.projectProfile,
      phase,
      runId,
      outputSchema: developerResultSchema,
      allowedScope: authority.bundle.allowed_scope,
      input: {
        phase,
        task: inputData.task,
        objective: authority.objective,
        frozenBundleSha256: authority.bundleSha256,
        frozenBundle: authority.bundle,
        documentPreflightReceipt: preflightReceipt,
        sealedRemediationDecision: inputData.decision ?? null,
        verificationFailure: verificationFailure ?? null,
        verificationFailureDiagnosis: verificationFailure ? inputData.verificationDiagnosis ?? null : null,
        instruction: verificationFailure
          ? 'Repair configured verification failures within frozen and allowed scope; report environmental, baseline, documentary, or out-of-scope failures instead of changing unrelated bytes.'
          : inputData.decision
            ? 'Repair the complete accepted CODE_DEFECT P0/P1 batch. Do not act on unaccepted proposals.'
            : 'Implement the task against frozen authority. Inspect the repository before editing.',
      },
    });
    await audit(inputData.projectProfile, {
      runId, actor: 'developer', action: 'batch-complete', phase, data: result,
    });
    const remediationRequested = inputData.route === 'VERIFICATION_REPAIR'
      || acceptedBlocking(inputData.decision).some(finding => finding.rootCause === 'CODE_DEFECT');
    const disposition = developerBatchDisposition(result.changedPaths, remediationRequested);
    if (disposition.stop) {
      const diagnosis: VerificationFailureDiagnosis = {
        classifications: ['EXECUTION_VIOLATION'],
        developerActionable: false,
        summary: disposition.summary ?? 'Developer remediation returned a no-op.',
        evidence: ['The validated Developer workspace produced changedPaths=[].'],
      };
      await audit(inputData.projectProfile, {
        runId, actor: 'orchestrator', action: 'developer-no-op-blocked', phase, data: diagnosis,
      });
      return {
        ...inputData,
        route: 'STOP_CODE',
        summary: diagnosis.summary,
        developerResult: result,
        verificationDiagnosis: diagnosis,
        openFindings: [...acceptedBlocking(inputData.decision), ...inputData.acceptedP2Ledger],
      };
    }
    return {
      ...inputData,
      route: 'VERIFY',
      cycleCount: inputData.cycleCount + disposition.cycleIncrement,
      summary: disposition.summary ?? result.summary,
      developerResult: result,
    };
  },
});

const automatedVerificationStep = createStep({
  id: 'automated-verification',
  description: 'Runs deterministic checks on the exact Developer candidate and routes failures back within the cycle limit.',
  inputSchema: cycleStateSchema,
  outputSchema: cycleStateSchema,
  execute: async ({ inputData, runId }): Promise<CycleState> => {
    if (inputData.route !== 'VERIFY') return inputData;
    const verification = await runAllVerification(inputData.projectProfile);
    const snapshot = await candidateSnapshot(inputData.projectProfile);
    if (verification.passed) {
      await audit(inputData.projectProfile, {
        runId, actor: 'orchestrator', action: 'candidate-ready-for-review',
        phase: 'candidate-review', data: snapshot,
      });
      return {
        ...inputData,
        route: 'REVIEW',
        snapshotSha256: snapshot.sha256,
        verification,
        verificationDiagnosis: undefined,
        summary: 'Configured automated verification passed.',
      };
    }
    const diagnosis = classifyVerificationFailure(
      verification,
      inputData.developerResult?.changedPaths ?? [],
    );
    await audit(inputData.projectProfile, {
      runId, actor: 'orchestrator', action: 'verification-failure-classified',
      phase: 'automated-verification', data: diagnosis,
    });
    if (!diagnosis.developerActionable) {
      return {
        ...inputData,
        route: 'STOP_CODE',
        snapshotSha256: snapshot.sha256,
        verification,
        verificationDiagnosis: diagnosis,
        summary: diagnosis.summary,
        openFindings: [...acceptedBlocking(inputData.decision), ...inputData.acceptedP2Ledger],
      };
    }
    const config = await getProjectConfig(inputData.projectProfile);
    if (inputData.cycleCount >= config.maxCodeCycles) {
      return {
        ...inputData,
        route: 'STOP_CODE',
        snapshotSha256: snapshot.sha256,
        verification,
        verificationDiagnosis: diagnosis,
        summary: `Reached maxCodeCycles=${config.maxCodeCycles} with automated verification still failing.`,
        openFindings: [...acceptedBlocking(inputData.decision), ...inputData.acceptedP2Ledger],
      };
    }
    return {
      ...inputData,
      route: 'VERIFICATION_REPAIR',
      snapshotSha256: snapshot.sha256,
      verification,
      verificationDiagnosis: diagnosis,
      summary: diagnosis.summary,
    };
  },
});

const reviewerStep = createStep({
  id: 'reviewer',
  description: 'Read-only gpt-5.6-sol Codex compliance review of the exact green candidate snapshot, including closure and regressions.',
  inputSchema: cycleStateSchema,
  outputSchema: reviewEnvelopeSchema,
  execute: async ({ inputData, runId }) => {
    if (inputData.route !== 'REVIEW') return { state: inputData };
    assertCurrentPromptAuthority(inputData);
    const reviewerDecision = await runReadOnlyCodexRole({
      projectProfile: inputData.projectProfile,
      role: 'reviewer',
      phase: 'candidate-review',
      runId,
      input: await reviewPrompt(inputData),
      outputSchema: reviewerDecisionSchema,
    });
    const state = reviewerDecision.disposition === 'ESCALATE'
      ? inputData
      : applyReviewerDirectRoute(inputData, reviewerDecision);
    await audit(inputData.projectProfile, {
      runId, actor: 'reviewer', action: 'reviewer-decision', phase: 'candidate-review', data: reviewerDecision,
    });
    return { state, reviewerDecision };
  },
});

const freshChallengerStep = createStep({
  id: 'fresh-clean-room-challenger',
  description: 'Invokes a fresh DeepSeek v4 Flash challenger only when Reviewer explicitly escalates high risk, weak evidence, or a conclusion conflict.',
  inputSchema: reviewEnvelopeSchema,
  outputSchema: escalationEnvelopeSchema,
  execute: async ({ inputData, runId }) => {
    const state = inputData.state;
    const reviewerDecision = inputData.reviewerDecision;
    if (state.route !== 'REVIEW' || reviewerDecision?.disposition !== 'ESCALATE') {
      return { state, reviewerDecision };
    }
    assertCurrentPromptAuthority(state);
    try {
      const challengerReview = await runDeepSeekChallengerRole({
        projectProfile: state.projectProfile,
        phase: 'escalated-challenge',
        runId,
        input: {
          ...(await reviewPrompt(state)),
          role: 'challenger',
          reviewerDecision,
          instruction: 'Use a fresh context to independently investigate the escalated risk or conflict. The Reviewer report is evidence, not authority. Return proposals only and do not modify product files.',
        },
        outputSchema: reviewOutputSchema,
      });
      return { state, reviewerDecision, challengerReview };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.startsWith('PLATFORM_LIMITATION:')) throw error;
      return { state, reviewerDecision, platformLimitation: message };
    }
  },
});

const adjudicatorStep = createStep({
  id: 'adjudicator',
  description: 'Invokes read-only gpt-6-astra only after an escalation to resolve Reviewer/Challenger evidence or root-cause conflicts.',
  inputSchema: escalationEnvelopeSchema,
  outputSchema: cycleStateSchema,
  execute: async ({ inputData, runId }): Promise<CycleState> => {
    const state = inputData.state;
    if (state.route !== 'REVIEW') return state;
    assertCurrentPromptAuthority(state);
    const platformLimitation = inputData.platformLimitation;
    if (platformLimitation) {
      return {
        ...state,
        route: 'STOP_CODE',
        summary: platformLimitation,
      };
    }
    const reviewerDecision = inputData.reviewerDecision;
    const challenger = inputData.challengerReview;
    if (reviewerDecision?.disposition !== 'ESCALATE' || !challenger) {
      throw new Error('Escalated Reviewer Decision and Challenger report are both required.');
    }
    const decision = await adjudicate(state, reviewerDecision, challenger, runId);
    const acceptedP2Ledger = retainAcceptedP2(state.acceptedP2Ledger, decision);
    const blocking = acceptedBlocking(decision);
    const documentDefects = blocking.filter(finding => finding.rootCause === 'FROZEN_DOCUMENT_DEFECT');
    if (documentDefects.length) {
      return {
        ...state, route: 'STOP_DOCUMENT', decision, acceptedP2Ledger,
        openFindings: [...documentDefects, ...acceptedP2Ledger],
        summary: 'Accepted document P0/P1 requires Document Owner revision, human approval, and a superseding Bundle.',
      };
    }
    const codeDefects = blocking.filter(finding => finding.rootCause === 'CODE_DEFECT');
    const externalBlocking = blocking.filter(
      finding => !['CODE_DEFECT', 'FROZEN_DOCUMENT_DEFECT'].includes(finding.rootCause),
    );
    if (externalBlocking.length) {
      return {
        ...state, route: 'STOP_EXTERNAL', decision, acceptedP2Ledger,
        openFindings: [...externalBlocking, ...acceptedP2Ledger],
        summary: 'Blocking findings require baseline, platform, product, or stronger-evidence resolution outside Developer.',
      };
    }
    if (codeDefects.length) {
      return {
        ...state, route: 'DEVELOP', decision, acceptedP2Ledger,
        openFindings: [...codeDefects, ...acceptedP2Ledger],
        summary: 'Accepted code P0/P1 is returning as one sealed batch to Developer.',
      };
    }
    return {
      ...state, route: 'HUMAN_CONFIRMATION', decision, acceptedP2Ledger,
      openFindings: acceptedP2Ledger,
      summary: 'Automated verification passed and no accepted P0/P1 remains. Human final confirmation is required.',
    };
  },
});

const developerVerificationWorkflow = createWorkflow({
  id: 'developer-verification-cycle',
  description: 'Visible Developer-only mutation followed by product-read-only deterministic verification.',
  inputSchema: cycleStateSchema,
  outputSchema: cycleStateSchema,
})
  .then(developerStep)
  .then(automatedVerificationStep)
  .commit();

const candidateReviewCycleWorkflow = createWorkflow({
  id: 'candidate-review-cycle',
  description: 'Runs Developer/Verification until green, then Reviewer direct routing with Challenger and Adjudicator only on explicit escalation.',
  inputSchema: cycleStateSchema,
  outputSchema: cycleStateSchema,
})
  .dountil(developerVerificationWorkflow, {
    predicate: { op: 'ne', left: { path: 'inputData.route' }, right: { literal: 'VERIFICATION_REPAIR' } },
  })
  .then(reviewerStep)
  .then(freshChallengerStep)
  .then(adjudicatorStep)
  .commit();

const humanFinalConfirmationStep = createStep({
  id: 'human-final-confirmation',
  description: 'Suspends only after a green independently reviewed snapshot has no accepted P0/P1.',
  inputSchema: cycleStateSchema,
  outputSchema: cycleOutputSchema,
  resumeSchema: humanResumeSchema,
  suspendSchema: humanSuspendSchema,
  execute: async ({ inputData, resumeData, suspend, runId }) => {
    const base: CycleOutput = {
      projectProfile: inputData.projectProfile,
      status: inputData.route === 'STOP_DOCUMENT'
        ? 'NEEDS_DOCUMENT_REVIEW'
        : inputData.route === 'HUMAN_CONFIRMATION'
          ? 'READY_FOR_HUMAN_CONFIRMATION'
          : inputData.route === 'STOP_EXTERNAL'
            ? 'NEEDS_EXTERNAL_RESOLUTION'
            : 'NEEDS_CODE_REMEDIATION',
      bundleSha256: inputData.bundleSha256,
      snapshotSha256: inputData.snapshotSha256,
      cycleCount: inputData.cycleCount,
      summary: inputData.summary,
      openFindings: inputData.openFindings,
      verification: inputData.verification,
      verificationDiagnosis: inputData.verificationDiagnosis,
    };
    if (inputData.route !== 'HUMAN_CONFIRMATION') return base;
    if (!resumeData) {
      return suspend({
        status: 'AWAITING_HUMAN_FINAL_CONFIRMATION',
        snapshotSha256: inputData.snapshotSha256 ?? 'unknown',
        summary: inputData.summary,
      }, { resumeLabel: 'human-final-confirmation' });
    }
    const final: CycleOutput = {
      ...base,
      status: resumeData.decision,
      humanDecision: resumeData.decision,
      summary: `${resumeData.decision} confirmed by ${resumeData.confirmedBy}. ${resumeData.note}`.trim(),
    };
    await audit(inputData.projectProfile, {
      runId, actor: 'human', action: 'final-confirmation', phase: 'final', data: resumeData,
    });
    return final;
  },
});

export const codingAgentLoopWorkflow = createWorkflow({
  id: 'coding-agent-loop',
  description: 'Observable Prompt v2.9 coding loop with Reviewer direct routing, conditional clean-room escalation, Developer-only writes, durable findings, and human GO.',
  inputSchema: workflowInputSchema,
  outputSchema: cycleOutputSchema,
})
  .then(runtimePreflightStep)
  .then(documentPreflightStep)
  .dountil(candidateReviewCycleWorkflow, {
    predicate: { op: 'ne', left: { path: 'inputData.route' }, right: { literal: 'DEVELOP' } },
  })
  .then(humanFinalConfirmationStep)
  .commit();
