import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acquireWriterLock, releaseWriterLock } from '../src/mastra/writer-lock.js';

const temporaryHome = await mkdtemp(path.join(os.tmpdir(), 'coding-writer-lock-test-'));
process.env.LOCAL_AGENT_PLATFORM_HOME = temporaryHome;
process.env.CODING_ORCHESTRATOR_ENGINE = 'writer-lock-test';
process.env.CODING_AGENT_PROFILES = path.resolve(import.meta.dirname, '..', 'coding-agent.profiles.example.json');

try {
  const first = await acquireWriterLock('example', 'run-one');
  await assert.rejects(
    acquireWriterLock('example', 'run-two'),
    /Developer writer lock is held by engine=writer-lock-test runId=run-one/,
  );
  await releaseWriterLock(first);

  const second = await acquireWriterLock('example', 'run-two');
  assert.equal(second.runId, 'run-two');
  await releaseWriterLock(second);
  console.log('Writer lock test passed: cross-engine lock is exclusive and releasable.');
} finally {
  await rm(temporaryHome, { recursive: true, force: true });
}
