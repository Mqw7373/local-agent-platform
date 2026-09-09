import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const emptyState = () => ({ version: 1, updatedAt: new Date(0).toISOString(), runs: {} });

export class StateStore {
  #file;
  #state = emptyState();
  #queue = Promise.resolve();

  constructor(file) {
    this.#file = file;
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.#file, 'utf8'));
      if (parsed.version !== 1 || !parsed.runs || typeof parsed.runs !== 'object') throw new Error('invalid state file');
      this.#state = parsed;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      this.#state = emptyState();
    }
    return this.snapshot();
  }

  snapshot() {
    return structuredClone(this.#state);
  }

  getRun(id) {
    const value = this.#state.runs[id];
    return value ? structuredClone(value) : undefined;
  }

  findRun(bindingId, issueId) {
    const value = Object.values(this.#state.runs).find(run => run.bindingId === bindingId && run.issueId === issueId);
    return value ? structuredClone(value) : undefined;
  }

  listRuns() {
    return Object.values(this.#state.runs)
      .map(run => structuredClone(run))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async putRun(run) {
    return this.#mutate(state => {
      state.runs[run.id] = structuredClone(run);
      return run;
    });
  }

  async patchRun(id, patch) {
    return this.#mutate(state => {
      if (!state.runs[id]) throw new Error(`Unknown bridge run ${id}`);
      state.runs[id] = { ...state.runs[id], ...structuredClone(patch), updatedAt: new Date().toISOString() };
      return state.runs[id];
    });
  }

  async #mutate(operation) {
    let result;
    this.#queue = this.#queue.then(async () => {
      result = operation(this.#state);
      this.#state.updatedAt = new Date().toISOString();
      await mkdir(path.dirname(this.#file), { recursive: true });
      const temporary = `${this.#file}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(this.#state, null, 2)}\n`, 'utf8');
      await rename(temporary, this.#file);
    });
    await this.#queue;
    return structuredClone(result);
  }
}
