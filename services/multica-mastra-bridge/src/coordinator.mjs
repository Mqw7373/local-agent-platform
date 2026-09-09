import { createHash, randomUUID } from 'node:crypto';
import { adapterFor } from './adapters/coding-agent-loop.mjs';

function now() {
  return new Date().toISOString();
}

function significantFingerprint(interpretation) {
  return createHash('sha256').update(JSON.stringify({
    state: interpretation.state,
    phase: interpretation.phase,
    resultStatus: interpretation.resultStatus,
    summary: interpretation.summary,
    cycleCount: interpretation.cycleCount,
    openFindingCount: interpretation.openFindingCount,
  })).digest('hex');
}

function milestoneComment(record, interpretation) {
  const lines = [
    `**Mastra Bridge · ${interpretation.state}**`,
    '',
    `- Binding: \`${record.bindingId}\``,
    `- Mastra run: \`${record.mastraRunId}\``,
    `- Phase: \`${interpretation.phase}\``,
    `- Mastra status: \`${interpretation.mastraStatus}\``,
  ];
  if (interpretation.resultStatus) lines.push(`- Workflow result: \`${interpretation.resultStatus}\``);
  if (interpretation.cycleCount) lines.push(`- Code cycle: \`${interpretation.cycleCount}\``);
  if (interpretation.openFindingCount) lines.push(`- Open findings: \`${interpretation.openFindingCount}\``);
  if (interpretation.summary) lines.push('', interpretation.summary);
  if (interpretation.requiresHuman) {
    lines.push('', 'Human final confirmation is required. The Bridge will not infer or auto-submit GO.');
  }
  lines.push('', '_Monitoring evidence only. Multica and the Bridge do not gain product-write, adjudication, or GO authority._');
  return lines.join('\n');
}

export class BridgeCoordinator {
  #polling = false;

  constructor({ config, store, multicaClients, mastraClients, logger = console }) {
    this.config = config;
    this.store = store;
    this.multicaClients = multicaClients;
    this.mastraClients = mastraClients;
    this.logger = logger;
    this.pollState = { running: false, lastStartedAt: '', lastCompletedAt: '', lastError: '' };
  }

  bindings() {
    return Object.values(this.config.bindings).map(binding => {
      const multica = this.config.multicaConnections[binding.multicaConnection];
      const missing = [];
      if (!binding.enabled) missing.push('binding disabled');
      if (!binding.multicaProjectId) missing.push('Multica project id');
      if (!multica.workspaceId) missing.push('Multica workspace id');
      if (!multica.token) missing.push('Multica token');
      return {
        id: binding.id,
        enabled: binding.enabled,
        adapter: binding.adapter,
        workflowId: binding.workflowId,
        projectProfile: binding.adapterConfig.projectProfile ?? '',
        multicaConnection: binding.multicaConnection,
        multicaProjectId: binding.multicaProjectId,
        mastraConnection: binding.mastraConnection,
        ready: missing.length === 0,
        missing,
      };
    });
  }

  listRuns() {
    return this.store.listRuns();
  }

  getRun(id) {
    return this.store.getRun(id);
  }

  async startRun({ bindingId, issueId, task }) {
    const binding = this.#binding(bindingId);
    const existing = this.store.findRun(bindingId, issueId);
    if (existing) return existing;

    const multica = this.#multica(binding);
    const mastra = this.#mastra(binding);
    const issue = await multica.getIssue(issueId);
    const adapter = adapterFor(binding.adapter);
    const inputData = adapter.buildInput({ binding, issue, task });
    const mastraRunId = randomUUID();
    const createdAt = now();
    let record = {
      id: mastraRunId,
      bindingId,
      issueId,
      mastraRunId,
      workflowId: binding.workflowId,
      projectProfile: inputData.projectProfile ?? '',
      task: inputData.task ?? task ?? '',
      state: 'STARTING',
      mastraStatus: 'pending',
      phase: 'DISPATCH',
      resultStatus: '',
      summary: '',
      cycleCount: 0,
      requiresHuman: false,
      terminal: false,
      createdAt,
      updatedAt: createdAt,
      lastIssueStatus: '',
      lastCommentFingerprint: '',
      lastError: '',
    };
    await this.store.putRun(record);

    await multica.setMetadataMany(issueId, {
      [binding.trigger.actionKey]: 'claimed',
      'mastra_bridge.binding': binding.id,
      'mastra_bridge.run_id': mastraRunId,
      'mastra_bridge.state': 'STARTING',
      'mastra_bridge.workflow': binding.workflowId,
      'mastra_bridge.project_profile': inputData.projectProfile ?? '',
    });

    try {
      await mastra.startAsync(
        binding.workflowId,
        mastraRunId,
        inputData,
        `multica:${this.config.multicaConnections[binding.multicaConnection].workspaceId}:${issueId}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.store.patchRun(record.id, {
        state: 'FAILED_TO_START',
        mastraStatus: 'failed',
        terminal: true,
        lastError: message,
      });
      await this.#bestEffortFailure(binding, issueId, mastraRunId, message);
      throw error;
    }

    record = await this.store.patchRun(record.id, { state: 'RUNNING', mastraStatus: 'running' });
    try {
      await this.syncRun(record.id);
    } catch (error) {
      // Mastra may acknowledge start-async before the run snapshot becomes
      // queryable. Keep the caller-owned run id and let the poller reconcile.
      const message = error instanceof Error ? error.message : String(error);
      await this.store.patchRun(record.id, { lastError: message });
    }
    return this.store.getRun(record.id);
  }

  async syncRun(id) {
    const record = this.store.getRun(id);
    if (!record) throw new Error(`Unknown bridge run ${id}`);
    const binding = this.#binding(record.bindingId);
    const run = await this.#mastra(binding).getRun(binding.workflowId, record.mastraRunId);
    const interpretation = adapterFor(binding.adapter).interpret({ binding, run });
    await this.store.patchRun(id, { ...interpretation, lastError: '' });
    await this.#syncMultica(binding, this.store.getRun(id), interpretation);
    return this.store.getRun(id);
  }

  async submitHumanDecision(id, decision) {
    if (!['GO', 'NO_GO'].includes(decision?.decision)) throw new Error('decision must be GO or NO_GO');
    if (typeof decision.confirmedBy !== 'string' || !decision.confirmedBy.trim()) throw new Error('confirmedBy is required');
    const record = await this.syncRun(id);
    if (!record.requiresHuman || record.state !== 'AWAITING_HUMAN_FINAL_CONFIRMATION') {
      throw new Error(`Bridge run ${id} is not awaiting human final confirmation`);
    }
    const binding = this.#binding(record.bindingId);
    await this.#mastra(binding).resumeHumanDecision(binding.workflowId, record.mastraRunId, {
      decision: decision.decision,
      confirmedBy: decision.confirmedBy.trim(),
      note: typeof decision.note === 'string' ? decision.note : '',
    });
    await this.store.patchRun(id, {
      state: 'HUMAN_DECISION_SUBMITTED',
      requiresHuman: false,
      humanDecision: decision.decision,
      humanConfirmedBy: decision.confirmedBy.trim(),
    });
    await this.#multica(binding).addComment(record.issueId, [
      `**Mastra Bridge · Human decision submitted: ${decision.decision}**`,
      '',
      `Confirmed by: ${decision.confirmedBy.trim()}`,
      decision.note ? `Note: ${decision.note}` : '',
      '',
      'The decision was relayed to the suspended Mastra run; the next sync records the authoritative workflow result.',
    ].filter(Boolean).join('\n'));
    return this.store.getRun(id);
  }

  async cancelRun(id) {
    const record = this.store.getRun(id);
    if (!record) throw new Error(`Unknown bridge run ${id}`);
    const binding = this.#binding(record.bindingId);
    await this.#mastra(binding).cancel(binding.workflowId, record.mastraRunId);
    await this.store.patchRun(id, { state: 'CANCEL_REQUESTED' });
    await this.#multica(binding).addComment(record.issueId, `**Mastra Bridge · Cancellation requested**\n\nMastra run: \`${record.mastraRunId}\``);
    return this.store.getRun(id);
  }

  async pollOnce() {
    if (this.#polling) return { skipped: true, reason: 'poll already running' };
    this.#polling = true;
    this.pollState = { ...this.pollState, running: true, lastStartedAt: now(), lastError: '' };
    const errors = [];
    try {
      for (const binding of Object.values(this.config.bindings)) {
        if (!this.#bindingReady(binding)) continue;
        try {
          const issues = await this.#multica(binding).listTriggeredIssues(binding);
          for (const issue of issues) {
            try {
              if (this.store.findRun(binding.id, issue.id)) continue;
              await this.startRun({ bindingId: binding.id, issueId: issue.id });
            } catch (error) {
              errors.push(`${binding.id}/${issue.id}: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        } catch (error) {
          errors.push(`${binding.id}/discovery: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      for (const record of this.store.listRuns()) {
        if (record.terminal || record.state === 'FAILED_TO_START') continue;
        try {
          await this.syncRun(record.id);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          errors.push(`${record.id}/sync: ${message}`);
          await this.store.patchRun(record.id, { lastError: message });
        }
      }
      return { skipped: false, errors };
    } finally {
      this.#polling = false;
      this.pollState = {
        ...this.pollState,
        running: false,
        lastCompletedAt: now(),
        lastError: errors.join('; '),
      };
      if (errors.length) this.logger.warn(`Bridge poll completed with ${errors.length} error(s)`);
    }
  }

  #binding(id) {
    const binding = this.config.bindings[id];
    if (!binding?.enabled) throw new Error(`Unknown or disabled binding ${id}`);
    return binding;
  }

  #bindingReady(binding) {
    const multica = this.config.multicaConnections[binding.multicaConnection];
    return Boolean(binding.enabled && binding.multicaProjectId && multica.workspaceId && multica.token);
  }

  #multica(binding) {
    const client = this.multicaClients[binding.multicaConnection];
    if (!client) throw new Error(`Missing Multica client ${binding.multicaConnection}`);
    return client;
  }

  #mastra(binding) {
    const client = this.mastraClients[binding.mastraConnection];
    if (!client) throw new Error(`Missing Mastra client ${binding.mastraConnection}`);
    return client;
  }

  async #syncMultica(binding, record, interpretation) {
    const multica = this.#multica(binding);
    await multica.setMetadataMany(record.issueId, {
      [binding.trigger.actionKey]: interpretation.terminal ? 'complete' : 'claimed',
      'mastra_bridge.binding': binding.id,
      'mastra_bridge.run_id': record.mastraRunId,
      'mastra_bridge.state': interpretation.state,
      'mastra_bridge.mastra_status': interpretation.mastraStatus,
      'mastra_bridge.result_status': interpretation.resultStatus,
      'mastra_bridge.phase': interpretation.phase,
      'mastra_bridge.cycle_count': interpretation.cycleCount,
      'mastra_bridge.requires_human': interpretation.requiresHuman,
      'mastra_bridge.bundle_sha256': interpretation.bundleSha256,
      'mastra_bridge.snapshot_sha256': interpretation.snapshotSha256,
      'mastra_bridge.updated_at': now(),
    });

    let patch = {};
    if (interpretation.issueStatus && record.lastIssueStatus !== interpretation.issueStatus) {
      await multica.updateStatus(record.issueId, interpretation.issueStatus);
      patch.lastIssueStatus = interpretation.issueStatus;
    }

    const fingerprint = significantFingerprint(interpretation);
    if (record.lastCommentFingerprint !== fingerprint) {
      await multica.addComment(record.issueId, milestoneComment(record, interpretation));
      patch.lastCommentFingerprint = fingerprint;
    }
    if (Object.keys(patch).length) await this.store.patchRun(record.id, patch);
  }

  async #bestEffortFailure(binding, issueId, runId, message) {
    const multica = this.#multica(binding);
    try {
      await multica.setMetadataMany(issueId, {
        [binding.trigger.actionKey]: 'failed',
        'mastra_bridge.run_id': runId,
        'mastra_bridge.state': 'FAILED_TO_START',
      });
      await multica.updateStatus(issueId, binding.issueStatuses.blocked);
      await multica.addComment(issueId, `**Mastra Bridge · FAILED_TO_START**\n\n${message}`);
    } catch (syncError) {
      this.logger.error('Failed to report start failure to Multica', syncError);
    }
  }
}
