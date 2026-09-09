import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { audit } from './audit.js';
import { getProjectConfig } from './config.js';
import {
  documentKinds,
  frozenBundleSchema,
  type DocumentPreflight,
  type FrozenBundle,
} from './schemas.js';
import { sha256 } from './workspace.js';

const configuredRole = {
  prd: 'prd',
  adr: 'adr',
  systemDesign: 'system_design',
  apiContract: 'api_contract',
  acceptanceCriteria: 'acceptance_criteria',
} as const;

function normalizedScope(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
}

function isAbsoluteOrRepositoryRoot(value: string): boolean {
  const normalized = normalizedScope(value);
  return normalized === '' || normalized === '.' || normalized === '/' || normalized === '**'
    || normalized === '**/*' || /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('/');
}

function globMatches(pattern: string, candidate: string): boolean {
  const escaped = normalizedScope(pattern)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('**', '\u0000')
    .replaceAll('*', '[^/]*')
    .replaceAll('\u0000', '.*')
    .replaceAll('?', '[^/]');
  return new RegExp(`^${escaped}$`).test(normalizedScope(candidate));
}

function scopesOverlap(left: string, right: string): boolean {
  const a = normalizedScope(left);
  const b = normalizedScope(right);
  if (a === b) return true;
  const aIsLiteral = !/[?*]/.test(a);
  const bIsLiteral = !/[?*]/.test(b);
  if (aIsLiteral && globMatches(b, a)) return true;
  if (bIsLiteral && globMatches(a, b)) return true;
  return false;
}

export function bundleIndexIssues(bundle: FrozenBundle): DocumentPreflight['issues'] {
  const issues: DocumentPreflight['issues'] = [];
  const roles = new Set(bundle.documents.flatMap(document => document.document_roles));
  for (const role of ['prd', 'acceptance_criteria', 'adr', 'system_design', 'api_contract'] as const) {
    if (!roles.has(role)) issues.push({ code: 'MISSING', detail: `Bundle document role is missing: ${role}` });
  }
  if (bundle.changes_existing_persisted_data && !roles.has('migration_contract')) {
    issues.push({ code: 'MISSING', detail: 'changes_existing_persisted_data=true requires a migration_contract document role.' });
  }
  for (const allowed of bundle.allowed_scope) {
    if (isAbsoluteOrRepositoryRoot(allowed)) {
      issues.push({ code: 'UNAPPROVED', detail: `allowed_scope must be a bounded repository-relative path: ${allowed}` });
    }
    for (const forbidden of bundle.forbidden_scope) {
      if (scopesOverlap(allowed, forbidden)) {
        issues.push({ code: 'CONFLICT', detail: `allowed_scope overlaps forbidden_scope: ${allowed} <> ${forbidden}` });
      }
    }
  }
  return issues;
}

export async function deterministicPreflight(projectProfile: string): Promise<{
  result: DocumentPreflight;
  objective?: string;
  documents?: Record<string, string>;
  bundle?: FrozenBundle;
}> {
  const config = await getProjectConfig(projectProfile);
  const issues: DocumentPreflight['issues'] = [];
  let rawBundle: string;
  try {
    rawBundle = await readFile(config.bundleFile, 'utf8');
  } catch {
    const result: DocumentPreflight = {
      status: 'NEEDS_DOCUMENT_REVIEW',
      summary: 'Frozen Bundle is missing or unreadable.',
      issues: [{ code: 'UNAPPROVED', detail: `Cannot read ${config.bundleFile}` }],
    };
    await audit(projectProfile, { actor: 'document-preflight', action: 'blocked', data: result });
    return { result };
  }

  const parsed = frozenBundleSchema.safeParse(JSON.parse(rawBundle));
  if (!parsed.success) {
    const result: DocumentPreflight = {
      status: 'NEEDS_DOCUMENT_REVIEW',
      summary: 'Frozen Bundle is invalid.',
      issues: [{ code: 'UNAPPROVED', detail: parsed.error.message }],
    };
    await audit(projectProfile, { actor: 'document-preflight', action: 'blocked', data: result });
    return { result };
  }

  issues.push(...bundleIndexIssues(parsed.data));
  const documents: Record<string, string> = {};
  for (const kind of documentKinds) {
    const configured = config.documents[kind].replaceAll('\\', '/');
    const role = configuredRole[kind];
    const frozen = parsed.data.documents.find(document => document.document_roles.includes(role));
    if (!frozen) continue;
    if (frozen.path_or_embedded_id.replaceAll('\\', '/') !== configured) {
      issues.push({ document: kind, code: 'PATH_MISMATCH', detail: `Configured ${configured}; bundle has ${frozen.path_or_embedded_id}` });
      continue;
    }
    const full = path.resolve(config.projectRoot, configured);
    try {
      const content = await readFile(full, 'utf8');
      documents[kind] = content;
      const actual = sha256(content);
      if (actual !== frozen.sha256) {
        issues.push({ document: kind, code: 'HASH_MISMATCH', detail: `Expected ${frozen.sha256}; found ${actual}` });
      }
      if (/^<<<<<<< |^=======|^>>>>>>> /m.test(content) || /\bTBD\b/i.test(content)) {
        issues.push({ document: kind, code: 'AMBIGUOUS', detail: `${configured} contains an unresolved TBD or merge-conflict marker.` });
      }
    } catch {
      issues.push({ document: kind, code: 'MISSING', detail: `Cannot read ${configured}` });
    }
  }

  const result: DocumentPreflight = {
    status: issues.length ? 'NEEDS_DOCUMENT_REVIEW' : 'READY',
    bundleSha256: sha256(rawBundle),
    summary: issues.length ? 'Frozen documents did not pass deterministic preflight.' : 'Frozen document bytes match the approved Bundle.',
    issues,
  };
  await audit(projectProfile, { actor: 'document-preflight', action: result.status.toLowerCase(), data: result });
  return { result, objective: parsed.data.objective, documents, bundle: parsed.data };
}
