const terminalMastraStatuses = new Set(['success', 'failed', 'canceled', 'bailed', 'tripwire']);

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function cycleOutput(run) {
  const direct = objectValue(run.result);
  if (direct && typeof direct.status === 'string') return direct;

  const steps = objectValue(run.steps) ?? {};
  const finalOutput = objectValue(steps['human-final-confirmation']?.output);
  if (finalOutput && typeof finalOutput.status === 'string') return finalOutput;
  const implementationOutput = objectValue(steps['implementation-cycle']?.output);
  if (implementationOutput && typeof implementationOutput.status === 'string') return implementationOutput;
  return undefined;
}

function currentPhase(run) {
  if (run.status === 'suspended') return 'HUMAN_FINAL_CONFIRMATION';
  const steps = objectValue(run.steps) ?? {};
  if (steps['human-final-confirmation']?.status === 'running') return 'HUMAN_FINAL_CONFIRMATION';
  if (steps['implementation-cycle']?.status === 'running') return 'IMPLEMENTATION_CYCLE';
  if (run.status === 'success') return 'COMPLETE';
  return String(run.status ?? 'UNKNOWN').toUpperCase();
}

function bridgeState(run, output) {
  if (run.status === 'suspended' || output?.status === 'READY_FOR_HUMAN_CONFIRMATION') {
    return 'AWAITING_HUMAN_FINAL_CONFIRMATION';
  }
  if (['running', 'waiting', 'pending', 'paused'].includes(run.status)) return 'RUNNING';
  if (run.status === 'canceled') return 'CANCELED';
  if (['failed', 'bailed', 'tripwire'].includes(run.status)) return 'FAILED';
  if (output?.status === 'GO') return 'GO';
  if (output?.status === 'NO_GO') return 'NO_GO';
  if (output?.status === 'NEEDS_DOCUMENT_REVIEW') return 'NEEDS_DOCUMENT_REVIEW';
  if (output?.status === 'NEEDS_CODE_REMEDIATION') return 'NEEDS_CODE_REMEDIATION';
  if (run.status === 'success') return 'COMPLETE_WITHOUT_DECISION';
  return 'UNKNOWN';
}

function issueStatusFor(binding, state) {
  if (state === 'RUNNING') return binding.issueStatuses.running;
  if (state === 'AWAITING_HUMAN_FINAL_CONFIRMATION') return binding.issueStatuses.human;
  if (state === 'GO') return binding.issueStatuses.go;
  if (state === 'NO_GO') return binding.issueStatuses.noGo;
  if (state === 'CANCELED') return binding.issueStatuses.canceled;
  if (['NEEDS_DOCUMENT_REVIEW', 'NEEDS_CODE_REMEDIATION', 'FAILED', 'COMPLETE_WITHOUT_DECISION'].includes(state)) {
    return binding.issueStatuses.blocked;
  }
  return undefined;
}

export const codingAgentLoopAdapter = {
  id: 'coding-agent-loop',

  buildInput({ binding, issue, task }) {
    const resolvedTask = task?.trim() || issue?.description?.trim() || issue?.title?.trim();
    if (!resolvedTask) throw new Error('Coding Agent Loop requires a non-empty task or Multica issue description/title');
    return {
      projectProfile: binding.adapterConfig.projectProfile,
      task: resolvedTask,
    };
  },

  interpret({ binding, run }) {
    const output = cycleOutput(run);
    const state = bridgeState(run, output);
    const phase = currentPhase(run);
    const summary = output?.summary
      ?? (run.error ? `Mastra workflow error: ${typeof run.error === 'string' ? run.error : JSON.stringify(run.error)}` : '')
      ?? '';
    return {
      state,
      phase,
      mastraStatus: run.status ?? 'unknown',
      resultStatus: output?.status ?? '',
      summary,
      cycleCount: Number(output?.cycleCount ?? 0),
      bundleSha256: output?.bundleSha256 ?? '',
      snapshotSha256: output?.snapshotSha256 ?? '',
      openFindingCount: Array.isArray(output?.openFindings) ? output.openFindings.length : 0,
      requiresHuman: state === 'AWAITING_HUMAN_FINAL_CONFIRMATION',
      terminal: terminalMastraStatuses.has(run.status) && state !== 'AWAITING_HUMAN_FINAL_CONFIRMATION',
      issueStatus: issueStatusFor(binding, state),
    };
  },
};

export function adapterFor(id) {
  if (id === codingAgentLoopAdapter.id) return codingAgentLoopAdapter;
  throw new Error(`Unsupported workflow adapter: ${id}`);
}
