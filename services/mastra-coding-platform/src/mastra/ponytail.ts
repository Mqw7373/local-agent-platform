import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { sha256 } from './workspace.js';

export const PONYTAIL_BINDING = {
  package: '@dietrichgebert/ponytail',
  version: '4.9.0',
  sourceCommit: '0a4dd63ad4541f4f655c4108a295916f3c1d8fda',
  sourceSha256: '1316a2f3f95741d2300b116fe0c2d81ce4a9568656ed0a62643f54aaf09957f2',
  mode: 'lite',
  role: 'developer',
  rollout: 'ab-test-only',
  subagentInjection: false,
  upstreamHooksExecuted: false,
} as const;

export const developerPromptVariants = ['control', 'ponytail-lite'] as const;
export type DeveloperPromptVariant = typeof developerPromptVariants[number];

const sourceFile = fileURLToPath(
  new URL('../../../../vendor/ponytail/v4.9.0/SKILL.md', import.meta.url),
);

async function verifyPinnedSource(): Promise<void> {
  const actual = sha256(await readFile(sourceFile));
  if (actual !== PONYTAIL_BINDING.sourceSha256) {
    throw new Error(
      `Pinned Ponytail source SHA mismatch: expected ${PONYTAIL_BINDING.sourceSha256}, found ${actual}`,
    );
  }
}

const disabled = `
Ponytail status for this role: DISABLED. Do not apply, emulate, or forward Ponytail instructions. No Ponytail lifecycle or SubagentStart hook is installed by this platform adapter.`;

const developerControl = `
Ponytail experiment arm: CONTROL/OFF. Follow the frozen Bundle, Core Prompt, Developer role contract, and configured verification without Ponytail guidance.`;

const developerTreatment = `
Ponytail experiment arm: TREATMENT, pinned @dietrichgebert/ponytail v${PONYTAIL_BINDING.version} commit ${PONYTAIL_BINDING.sourceCommit}, mode LITE.

This is a Developer-only adapter derived from the pinned upstream skill. Upstream lifecycle hooks are not executed, and Ponytail instructions must not be forwarded to subagents or other roles.

Authority order is absolute:
1. Frozen Bundle, including every explicit acceptance criterion, API/data/migration contract, scope boundary, and human-approved requirement.
2. Core Prompt and the Developer-only product-write contract.
3. Configured automated verification and required regression evidence.
4. This optional Ponytail Lite optimization guidance.

Ponytail Lite guidance:
- Build everything explicitly required by higher authority. Never skip or renegotiate an accepted requirement.
- Read and trace the affected flow before editing. Prefer an existing repository pattern, the standard library, a native platform feature, or an already-installed dependency when it fully satisfies the frozen contract.
- Avoid unrequested abstractions, speculative scaffolding, duplicate helpers, and new dependencies that do not earn their cost.
- Name a materially lazier alternative in at most one short line, but do not wait for another user choice when the frozen Bundle already decides the requirement.

Mandatory non-reduction rule: Ponytail cannot reduce, replace, defer, or reinterpret acceptance tests, regression tests, migration checks, trace evidence, security controls, accessibility requirements, trust-boundary validation, data-loss prevention, or error handling. The upstream suggestion that one runnable check may be enough is explicitly superseded by the frozen Bundle and configured verification.
`;

export async function ponytailInstructionsForRole(
  role: string,
  variant: DeveloperPromptVariant = 'control',
): Promise<string> {
  if (role !== PONYTAIL_BINDING.role) return disabled;
  if (variant === 'control') return developerControl;
  await verifyPinnedSource();
  return developerTreatment;
}

export async function verifyPonytailBinding(): Promise<typeof PONYTAIL_BINDING> {
  await verifyPinnedSource();
  return PONYTAIL_BINDING;
}
