import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { getProjectConfig } from './config.js';
import { isInside } from './workspace-boundary.js';

export { isInside } from './workspace-boundary.js';

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function resolveProductPath(profileId: string, relativePath: string): Promise<string> {
  const config = await getProjectConfig(profileId);
  const resolved = path.resolve(config.projectRoot, relativePath);
  if (!isInside(config.projectRoot, resolved)) {
    throw new Error(`Path escapes projectRoot: ${relativePath}`);
  }
  return resolved;
}

async function walk(root: string, current: string, ignore: Set<string>, output: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (ignore.has(entry.name)) continue;
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await walk(root, full, ignore, output);
    } else if (entry.isFile()) {
      output.push(path.relative(root, full).replaceAll('\\', '/'));
    }
  }
}

export async function listProductFiles(profileId: string): Promise<string[]> {
  const config = await getProjectConfig(profileId);
  const files: string[] = [];
  await walk(config.projectRoot, config.projectRoot, new Set(config.ignore), files);
  return files;
}

export async function candidateSnapshot(profileId: string): Promise<{ sha256: string; files: number }> {
  const config = await getProjectConfig(profileId);
  const frozen = new Set(Object.values(config.documents).map(value => value.replaceAll('\\', '/')));
  const files = (await listProductFiles(profileId)).filter(file => !frozen.has(file));
  const hash = createHash('sha256');
  for (const file of files) {
    const full = await resolveProductPath(profileId, file);
    const info = await stat(full);
    if (info.size > 2_000_000) continue;
    hash.update(file).update('\0').update(await readFile(full)).update('\0');
  }
  return { sha256: hash.digest('hex'), files: files.length };
}

export async function readText(profileId: string, relativePath: string, maxBytes = 200_000): Promise<string> {
  const full = await resolveProductPath(profileId, relativePath);
  const info = await stat(full);
  if (info.size > maxBytes) throw new Error(`File exceeds ${maxBytes} bytes: ${relativePath}`);
  return readFile(full, 'utf8');
}
