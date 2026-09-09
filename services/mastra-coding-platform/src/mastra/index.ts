import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
import { codingAgentLoopWorkflow } from './workflow.js';
import { projectProfileCatalogWorkflow } from './profile-workflow.js';

const stateRoot = path.join(
  process.env.LOCAL_AGENT_PLATFORM_HOME ?? path.join(os.homedir(), '.local-agent-platform'),
  'state',
  'mastra-coding-platform',
);
mkdirSync(stateRoot, { recursive: true });

export const mastra = new Mastra({
  storage: new LibSQLStore({
    id: 'coding-agent-loop-storage',
    url: process.env.MASTRA_DB_URL ?? `file:${path.join(stateRoot, 'mastra.db').replaceAll('\\', '/')}`,
  }),
  workflows: {
    codingAgentLoopWorkflow,
    projectProfileCatalogWorkflow,
  },
});
