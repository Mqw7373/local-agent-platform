import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { getProjectConfig } from './config.js';

export type AuditEvent = {
  runId?: string;
  actor: string;
  action: string;
  phase?: string;
  data?: unknown;
};

export async function audit(projectProfile: string, event: AuditEvent): Promise<void> {
  const config = await getProjectConfig(projectProfile);
  await mkdir(config.runtimeDir, { recursive: true });
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    projectProfile,
    ...event,
  });
  await appendFile(path.join(config.runtimeDir, 'trace.jsonl'), `${line}\n`, 'utf8');
}
