import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadProjectConfig } from '../src/mastra/config.js';
import { documentKinds, frozenBundleSchema } from '../src/mastra/schemas.js';
import { sha256 } from '../src/mastra/workspace.js';

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing ${name} <value>`);
  return value;
}

function optionalArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function repeatedArguments(name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name && process.argv[index + 1]) values.push(process.argv[index + 1]);
  }
  return values;
}

const approvedBy = argument('--approved-by');
const approvalReference = argument('--approval-reference');
const bundleId = argument('--bundle-id');
const objective = argument('--objective');
const profileId = argument('--profile');
const allowedScope = repeatedArguments('--allowed-scope');
const forbiddenScope = repeatedArguments('--forbidden-scope');
const acceptanceChecks = repeatedArguments('--acceptance-check');
const persistedDataValue = argument('--changes-existing-persisted-data');
if (!['true', 'false'].includes(persistedDataValue)) {
  throw new Error('--changes-existing-persisted-data must be true or false');
}
const config = await loadProjectConfig(profileId);
const documentRoles = {
  prd: 'prd',
  adr: 'adr',
  systemDesign: 'system_design',
  apiContract: 'api_contract',
  acceptanceCriteria: 'acceptance_criteria',
} as const;
const documentsByPath = new Map<string, { document_roles: string[]; path_or_embedded_id: string; sha256: string }>();

for (const kind of documentKinds) {
  const relativePath = config.documents[kind].replaceAll('\\', '/');
  const bytes = await readFile(path.resolve(config.projectRoot, relativePath));
  const existing = documentsByPath.get(relativePath);
  if (existing) existing.document_roles.push(documentRoles[kind]);
  else documentsByPath.set(relativePath, {
    document_roles: [documentRoles[kind]],
    path_or_embedded_id: relativePath,
    sha256: sha256(bytes),
  });
}

const migrationContract = optionalArgument('--migration-contract');
if (migrationContract) {
  const relativePath = migrationContract.replaceAll('\\', '/');
  const bytes = await readFile(path.resolve(config.projectRoot, relativePath));
  documentsByPath.set(relativePath, {
    document_roles: ['migration_contract'],
    path_or_embedded_id: relativePath,
    sha256: sha256(bytes),
  });
}

const predecessor = optionalArgument('--predecessor-bundle-sha256') ?? null;

const bundle = frozenBundleSchema.parse({
  schema_version: '1',
  bundle_id: bundleId,
  bundle_version: optionalArgument('--bundle-version') ?? new Date().toISOString().replaceAll(/[:.]/g, '-'),
  bundle_status: 'FROZEN_FOR_IMPLEMENTATION',
  predecessor_bundle_sha256: predecessor,
  objective,
  documents: [...documentsByPath.values()],
  allowed_scope: allowedScope,
  forbidden_scope: forbiddenScope,
  acceptance_checks: acceptanceChecks,
  changes_existing_persisted_data: persistedDataValue === 'true',
  human_approval: {
    status: 'APPROVED',
    reference: `${approvalReference} (approved by ${approvedBy})`,
  },
});

await mkdir(path.dirname(config.bundleFile), { recursive: true });
await writeFile(config.bundleFile, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
console.log(`Frozen Bundle written: ${config.bundleFile}`);
console.log(`Project profile: ${profileId}`);
console.log(`Bundle SHA-256: ${sha256(await readFile(config.bundleFile))}`);
