import { requestJson } from './json-http.mjs';

export class MastraClient {
  constructor(connection) {
    this.connection = connection;
  }

  #path(value) {
    return `${this.connection.apiPrefix}${value}`;
  }

  #request(path, options = {}) {
    return requestJson(this.connection.baseUrl, this.#path(path), {
      timeoutMs: this.connection.timeoutMs,
      ...options,
    });
  }

  startAsync(workflowId, runId, inputData, resourceId) {
    const query = new URLSearchParams({ runId });
    return this.#request(`/workflows/${encodeURIComponent(workflowId)}/start-async?${query}`, {
      method: 'POST',
      body: {
        inputData,
        ...(resourceId ? { resourceId } : {}),
        tracingOptions: {
          metadata: { bridgeRunId: runId },
          tags: ['multica-mastra-bridge'],
        },
      },
    });
  }

  getRun(workflowId, runId) {
    const query = new URLSearchParams({
      fields: 'result,error,steps,activeStepsPath',
      withNestedWorkflows: 'false',
    });
    return this.#request(`/workflows/${encodeURIComponent(workflowId)}/runs/${encodeURIComponent(runId)}?${query}`);
  }

  resumeHumanDecision(workflowId, runId, decision) {
    const query = new URLSearchParams({ runId });
    return this.#request(`/workflows/${encodeURIComponent(workflowId)}/resume-async?${query}`, {
      method: 'POST',
      body: {
        step: 'human-final-confirmation',
        resumeData: decision,
      },
    });
  }

  cancel(workflowId, runId) {
    return this.#request(`/workflows/${encodeURIComponent(workflowId)}/runs/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST',
      body: {},
    });
  }
}
