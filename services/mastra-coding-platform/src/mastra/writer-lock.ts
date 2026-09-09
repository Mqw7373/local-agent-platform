import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { getProjectConfig } from './config.js';

type WriterLockRecord = {
  schemaVersion: 1;
  token: string;
  engine: string;
  runId: string;
  pid: number;
  acquiredAt: string;
};

export type WriterLock = WriterLockRecord & { lockFile: string };

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readRecord(lockFile: string): Promise<WriterLockRecord | undefined> {
  try {
    return JSON.parse(await readFile(lockFile, 'utf8')) as WriterLockRecord;
  } catch {
    return undefined;
  }
}

export async function acquireWriterLock(
  projectProfile: string,
  runId = 'unscoped-run',
): Promise<WriterLock> {
  const config = await getProjectConfig(projectProfile);
  await mkdir(config.runtimeDir, { recursive: true });
  const lockFile = path.join(config.runtimeDir, 'developer-writer.lock.json');
  const record: WriterLockRecord = {
    schemaVersion: 1,
    token: randomUUID(),
    engine: process.env.CODING_ORCHESTRATOR_ENGINE ?? 'mastra',
    runId,
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockFile, 'wx');
      try {
        await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
      } finally {
        await handle.close();
      }
      return { ...record, lockFile };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await readRecord(lockFile);
      if (existing && processIsAlive(existing.pid)) {
        throw new Error(
          `Developer writer lock is held by engine=${existing.engine} runId=${existing.runId} pid=${existing.pid}.`,
        );
      }
      await rm(lockFile, { force: true });
    }
  }
  throw new Error(`Unable to acquire Developer writer lock for ${projectProfile}.`);
}

export async function releaseWriterLock(lock: WriterLock): Promise<void> {
  const existing = await readRecord(lock.lockFile);
  if (!existing) return;
  if (existing.token !== lock.token) {
    throw new Error(`Refusing to release a Developer writer lock owned by another run: ${lock.lockFile}`);
  }
  await rm(lock.lockFile, { force: true });
}
