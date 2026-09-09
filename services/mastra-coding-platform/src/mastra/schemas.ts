import { z } from 'zod';

export const documentKinds = [
  'prd',
  'adr',
  'systemDesign',
  'apiContract',
  'acceptanceCriteria',
] as const;

export const documentKindSchema = z.enum(documentKinds);
export const severitySchema = z.enum(['P0', 'P1', 'P2']);
export const rootCauseSchema = z.enum([
  'CODE_DEFECT',
  'FROZEN_DOCUMENT_DEFECT',
  'BASELINE_FAILURE',
  'PLATFORM_LIMITATION',
  'PROFILE_DEFECT',
  'EXECUTION_VIOLATION',
  'NEEDS_PRODUCT_DECISION',
  'NOT_A_DEFECT',
  'INSUFFICIENT_EVIDENCE',
]);

export const commandSchema = z.object({
  id: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).default({}),
  timeoutMs: z.number().int().positive().max(30 * 60_000).default(10 * 60_000),
});

const codexRoleExecutionSchema = z.object({
  backend: z.literal('codex-cli'),
  model: z.string().min(1),
});

const challengerRoleExecutionSchema = z.object({
  backend: z.literal('openai-compatible'),
  provider: z.literal('openrouter'),
  baseUrl: z.string().url(),
  apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  model: z.literal('deepseek/deepseek-v4-flash'),
  maxToolRounds: z.number().int().min(1).max(20).default(10),
});

const developerOptimizationSchema = z.object({
  ponytail: z.object({
    role: z.literal('developer'),
    mode: z.literal('lite'),
    rollout: z.literal('ab-test-only'),
    version: z.literal('4.9.0'),
    sourceCommit: z.literal('0a4dd63ad4541f4f655c4108a295916f3c1d8fda'),
    sourceSha256: z.literal('1316a2f3f95741d2300b116fe0c2d81ce4a9568656ed0a62643f54aaf09957f2'),
    subagentInjection: z.literal(false),
    upstreamHooksExecuted: z.literal(false),
    authorityPrecedence: z.literal('frozen-bundle-core-prompt-and-verification-first'),
  }),
}).default({
  ponytail: {
    role: 'developer',
    mode: 'lite',
    rollout: 'ab-test-only',
    version: '4.9.0',
    sourceCommit: '0a4dd63ad4541f4f655c4108a295916f3c1d8fda',
    sourceSha256: '1316a2f3f95741d2300b116fe0c2d81ce4a9568656ed0a62643f54aaf09957f2',
    subagentInjection: false,
    upstreamHooksExecuted: false,
    authorityPrecedence: 'frozen-bundle-core-prompt-and-verification-first',
  },
});

export const projectConfigSchema = z.object({
  projectName: z.string().min(1),
  projectRoot: z.string().min(1),
  runtimeDir: z.string().min(1),
  corePrompt: z.object({
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  bundleFile: z.string().min(1),
  documents: z.object({
    prd: z.string().min(1),
    adr: z.string().min(1),
    systemDesign: z.string().min(1),
    apiContract: z.string().min(1),
    acceptanceCriteria: z.string().min(1),
  }),
  execution: z.object({
    backend: z.literal('role-routed'),
    executable: z.string().min(1).default('codex'),
    timeoutMs: z.number().int().positive().max(2 * 60 * 60_000).default(30 * 60_000),
    inactivityTimeoutMs: z.number().int().positive().max(30 * 60_000).default(10 * 60_000),
    networkRetryLimit: z.number().int().min(0).max(5).default(2),
    ignoreUserConfig: z.boolean().default(true),
    roles: z.object({
      'document-preflight': codexRoleExecutionSchema.extend({ model: z.literal('gpt-5.6-sol') }),
      developer: codexRoleExecutionSchema.extend({ model: z.literal('gpt-6-astra') }),
      reviewer: codexRoleExecutionSchema.extend({ model: z.literal('gpt-5.6-sol') }),
      challenger: challengerRoleExecutionSchema,
      adjudicator: codexRoleExecutionSchema.extend({ model: z.literal('gpt-6-astra') }),
    }),
  }),
  developerOptimization: developerOptimizationSchema,
  promptMode: z.enum(['distilled', 'full']).default('distilled'),
  maxCodeCycles: z.number().int().min(1).max(8).default(3),
  protectedPaths: z.array(z.string().min(1)).default([
    '.agent/**',
    'AGENTS.md',
    'CLAUDE.md',
  ]),
  allowedDeletions: z.array(z.string().min(1)).default([]),
  ignore: z.array(z.string()).default([
    '.git',
    'node_modules',
    'dist',
    'build',
    '.next',
    'coverage',
  ]),
  verificationCommands: z.array(commandSchema).min(1),
});

export const profileRegistrySchema = z.object({
  allowedRoots: z.array(z.string().min(1)).min(1),
  profiles: z.record(
    z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
    z.object({
      configFile: z.string().min(1),
      enabled: z.boolean().default(true),
      description: z.string().default(''),
    }),
  ),
});

export type ProjectConfigInput = z.input<typeof projectConfigSchema>;
export type ProjectConfig = z.output<typeof projectConfigSchema> & {
  profileId: string;
  configFile: string;
};

export type ProfileRegistry = z.output<typeof profileRegistrySchema> & {
  registryFile: string;
};

export const frozenDocumentSchema = z.object({
  document_roles: z.array(z.enum([
    'prd',
    'acceptance_criteria',
    'adr',
    'system_design',
    'api_contract',
    'migration_contract',
  ])).min(1),
  path_or_embedded_id: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export const frozenBundleSchema = z.object({
  schema_version: z.literal('1'),
  bundle_id: z.string().min(1),
  bundle_version: z.string().min(1),
  bundle_status: z.literal('FROZEN_FOR_IMPLEMENTATION'),
  predecessor_bundle_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  objective: z.string().min(1),
  documents: z.array(frozenDocumentSchema).min(1),
  allowed_scope: z.array(z.string().min(1)).min(1),
  forbidden_scope: z.array(z.string().min(1)),
  acceptance_checks: z.array(z.string().min(1)).min(1),
  work_packages: z.array(z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    acceptanceChecks: z.array(z.string().min(1)).min(1),
  })).min(1).optional(),
  changes_existing_persisted_data: z.boolean(),
  human_approval: z.object({
    status: z.literal('APPROVED'),
    reference: z.string().min(1),
  }),
});

export type FrozenBundle = z.infer<typeof frozenBundleSchema>;

export const preflightIssueSchema = z.object({
  document: documentKindSchema.optional(),
  code: z.enum(['MISSING', 'HASH_MISMATCH', 'PATH_MISMATCH', 'CONFLICT', 'AMBIGUOUS', 'UNAPPROVED']),
  detail: z.string().min(1),
});

export const documentPreflightSchema = z.object({
  status: z.enum(['READY', 'NEEDS_DOCUMENT_REVIEW']),
  bundleSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  summary: z.string(),
  issues: z.array(preflightIssueSchema),
});

export type DocumentPreflight = z.infer<typeof documentPreflightSchema>;

export const documentConsistencySchema = z.object({
  status: z.enum(['CONSISTENT', 'NEEDS_DOCUMENT_REVIEW']),
  summary: z.string(),
  issues: z.array(preflightIssueSchema),
});

export const documentPreflightReceiptSchema = z.object({
  receiptVersion: z.literal('1'),
  receiptId: z.string().regex(/^DPF-[a-f0-9]{20}$/),
  projectProfile: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  taskSha256: z.string().regex(/^[a-f0-9]{64}$/),
  bundleSha256: z.string().regex(/^[a-f0-9]{64}$/),
  deterministic: z.object({
    status: z.literal('READY'),
    summary: z.string(),
    issues: z.array(preflightIssueSchema).length(0),
  }),
  independentReview: z.object({
    status: z.literal('CONSISTENT'),
    summary: z.string(),
    issues: z.array(preflightIssueSchema).length(0),
  }),
});

export type DocumentPreflightReceipt = z.infer<typeof documentPreflightReceiptSchema>;

export const verificationResultSchema = z.object({
  passed: z.boolean(),
  commands: z.array(z.object({
    id: z.string(),
    exitCode: z.number().int().nullable(),
    stdout: z.string(),
    stderr: z.string(),
    durationMs: z.number().nonnegative(),
    timedOut: z.boolean(),
  })),
});

export type VerificationResult = z.infer<typeof verificationResultSchema>;

export const verificationFailureClassSchema = z.enum([
  'CODE_DEFECT',
  'BASELINE_FAILURE',
  'PLATFORM_LIMITATION',
  'PROFILE_DEFECT',
  'EXECUTION_VIOLATION',
]);

export const verificationFailureDiagnosisSchema = z.object({
  classifications: z.array(verificationFailureClassSchema).min(1),
  developerActionable: z.boolean(),
  summary: z.string().min(1),
  evidence: z.array(z.string().min(1)).min(1),
});

export type VerificationFailureDiagnosis = z.infer<typeof verificationFailureDiagnosisSchema>;

export const findingProposalSchema = z.object({
  proposalId: z.string().min(1),
  title: z.string().min(1),
  proposedSeverity: severitySchema,
  suspectedRootCause: rootCauseSchema,
  requirementBinding: z.string().min(1),
  exactSnapshot: z.string().min(1),
  reachablePath: z.string().min(1),
  reproduction: z.array(z.string()).min(1),
  expected: z.string().min(1),
  actual: z.string().min(1),
  proofLimits: z.string().min(1),
});

export const reviewOutputSchema = z.object({
  summary: z.string(),
  proposals: z.array(findingProposalSchema),
});

export type ReviewOutput = z.infer<typeof reviewOutputSchema>;

export const adjudicatedFindingSchema = z.object({
  findingId: z.string().min(1),
  sourceProposalIds: z.array(z.string()).min(1),
  accepted: z.boolean(),
  severity: severitySchema,
  rootCause: rootCauseSchema,
  rationale: z.string().min(1),
  remediation: z.string().min(1),
});

export const adjudicationDecisionSchema = z.object({
  decisionId: z.string().min(1),
  snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
  summary: z.string(),
  findings: z.array(adjudicatedFindingSchema),
});

export type AdjudicationDecision = z.infer<typeof adjudicationDecisionSchema>;

export const reviewerDispositionSchema = z.enum([
  'NO_P0_P1',
  'DIRECT_CODE_REMEDIATION',
  'DIRECT_DOCUMENT_REVIEW',
  'DIRECT_EXTERNAL_STOP',
  'ESCALATE',
]);

export const reviewerDecisionSchema = z.object({
  disposition: reviewerDispositionSchema,
  summary: z.string().min(1),
  findings: z.array(adjudicatedFindingSchema),
  escalationReasons: z.array(z.string().min(1)),
});

export type ReviewerDecision = z.infer<typeof reviewerDecisionSchema>;

export const developerResultSchema = z.object({
  summary: z.string(),
  changedPaths: z.array(z.string()),
  testsAddedOrChanged: z.array(z.string()),
  unresolved: z.array(z.string()),
});

export const cycleOutputSchema = z.object({
  projectProfile: z.string(),
  status: z.enum([
    'NEEDS_DOCUMENT_REVIEW',
    'NEEDS_CODE_REMEDIATION',
    'NEEDS_EXTERNAL_RESOLUTION',
    'READY_FOR_HUMAN_CONFIRMATION',
    'GO',
    'NO_GO',
  ]),
  bundleSha256: z.string().optional(),
  snapshotSha256: z.string().optional(),
  cycleCount: z.number().int().nonnegative(),
  summary: z.string(),
  openFindings: z.array(adjudicatedFindingSchema),
  verification: verificationResultSchema.optional(),
  verificationDiagnosis: verificationFailureDiagnosisSchema.optional(),
  humanDecision: z.enum(['GO', 'NO_GO']).optional(),
});

export type CycleOutput = z.infer<typeof cycleOutputSchema>;

export const workflowInputSchema = z.object({
  projectProfile: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/).describe('An enabled profile id from coding-agent.profiles.json'),
  task: z.string().min(1),
});

export const profileCatalogSchema = z.object({
  profiles: z.array(z.object({
    id: z.string(),
    description: z.string(),
  })),
});

export const humanResumeSchema = z.object({
  decision: z.enum(['GO', 'NO_GO']),
  confirmedBy: z.string().min(1),
  note: z.string().default(''),
});

export const humanSuspendSchema = z.object({
  status: z.literal('AWAITING_HUMAN_FINAL_CONFIRMATION'),
  snapshotSha256: z.string(),
  summary: z.string(),
});
