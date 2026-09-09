import assert from 'node:assert/strict';
import { mastra } from '../src/mastra/index.js';

const workflow = mastra.getWorkflow('codingAgentLoopWorkflow');
const run = await workflow.createRun();
const result = await run.start({ inputData: { projectProfile: 'example', task: 'Smoke-test the deterministic preflight branch' } });

assert.equal(result.status, 'success');
if (result.status !== 'success') throw new Error('Workflow smoke test failed');
assert.equal(result.result.status, 'NEEDS_DOCUMENT_REVIEW');
assert.equal(result.result.projectProfile, 'example');
assert.equal(result.result.cycleCount, 0);

console.log('Workflow smoke test passed: missing/unfrozen documents stop before any model or Developer call.');
