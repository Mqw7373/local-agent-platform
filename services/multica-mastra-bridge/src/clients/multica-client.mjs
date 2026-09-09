import { requestJson } from './json-http.mjs';

export class MulticaClient {
  constructor(connection) {
    this.connection = connection;
  }

  get configured() {
    return Boolean(this.connection.workspaceId && this.connection.token);
  }

  #headers() {
    return {
      authorization: `Bearer ${this.connection.token}`,
      'x-workspace-id': this.connection.workspaceId,
      'x-client-platform': 'mastra-bridge',
      'x-client-version': '0.1.0',
    };
  }

  async #request(path, options = {}) {
    if (!this.configured) throw new Error(`Multica connection ${this.connection.id} is not configured`);
    return requestJson(this.connection.baseUrl, path, {
      timeoutMs: this.connection.timeoutMs,
      headers: this.#headers(),
      ...options,
    });
  }

  async listTriggeredIssues(binding) {
    const metadata = JSON.stringify({
      [binding.trigger.bindingKey]: binding.id,
      [binding.trigger.actionKey]: binding.trigger.actionValue,
    });
    const query = new URLSearchParams({
      workspace_id: this.connection.workspaceId,
      project_id: binding.multicaProjectId,
      metadata,
      limit: '100',
      sort: 'created_at',
      direction: 'asc',
    });
    const result = await this.#request(`/api/issues?${query}`);
    return Array.isArray(result?.issues) ? result.issues : [];
  }

  getIssue(issueId) {
    return this.#request(`/api/issues/${encodeURIComponent(issueId)}`);
  }

  setMetadata(issueId, key, value) {
    return this.#request(`/api/issues/${encodeURIComponent(issueId)}/metadata/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: { value },
    });
  }

  async setMetadataMany(issueId, values) {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined || value === null) continue;
      if (!['string', 'number', 'boolean'].includes(typeof value)) continue;
      await this.setMetadata(issueId, key, value);
    }
  }

  addComment(issueId, content) {
    return this.#request(`/api/issues/${encodeURIComponent(issueId)}/comments`, {
      method: 'POST',
      body: { content },
    });
  }

  updateStatus(issueId, status) {
    return this.#request(`/api/issues/${encodeURIComponent(issueId)}`, {
      method: 'PUT',
      body: { status, suppress_run: true },
    });
  }
}
