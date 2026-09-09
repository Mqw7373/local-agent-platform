import test from 'node:test';
import assert from 'node:assert/strict';
import { codingAgentLoopAdapter } from '../src/adapters/coding-agent-loop.mjs';

const binding = {
  adapterConfig: { projectProfile: 'repo-a' },
  issueStatuses: {
    running: 'in_progress',
    human: 'in_review',
    blocked: 'blocked',
    go: 'done',
    noGo: 'cancelled',
    canceled: 'cancelled',
  },
};

test('builds a coding input from a registered profile and issue content', () => {
  assert.deepEqual(codingAgentLoopAdapter.buildInput({
    binding,
    issue: { title: 'Fallback', description: 'Implement frozen task' },
  }), {
    projectProfile: 'repo-a',
    task: 'Implement frozen task',
  });
});

test('maps a suspended run to a human-only gate', () => {
  const result = codingAgentLoopAdapter.interpret({
    binding,
    run: {
      status: 'suspended',
      steps: {
        'implementation-cycle': {
          status: 'success',
          output: { status: 'READY_FOR_HUMAN_CONFIRMATION', cycleCount: 2, summary: 'Ready, not GO.' },
        },
      },
    },
  });
  assert.equal(result.state, 'AWAITING_HUMAN_FINAL_CONFIRMATION');
  assert.equal(result.requiresHuman, true);
  assert.equal(result.terminal, false);
  assert.equal(result.issueStatus, 'in_review');
});

test('maps document defects and human GO without conflating them', () => {
  const blocked = codingAgentLoopAdapter.interpret({
    binding,
    run: { status: 'success', result: { status: 'NEEDS_DOCUMENT_REVIEW', cycleCount: 0, summary: 'Missing contract.' } },
  });
  assert.equal(blocked.state, 'NEEDS_DOCUMENT_REVIEW');
  assert.equal(blocked.issueStatus, 'blocked');
  assert.equal(blocked.terminal, true);

  const go = codingAgentLoopAdapter.interpret({
    binding,
    run: { status: 'success', result: { status: 'GO', cycleCount: 1, summary: 'Human confirmed.' } },
  });
  assert.equal(go.state, 'GO');
  assert.equal(go.issueStatus, 'done');
});
