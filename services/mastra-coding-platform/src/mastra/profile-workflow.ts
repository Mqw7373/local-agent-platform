import { z } from 'zod';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { listProjectProfiles } from './config.js';
import { profileCatalogSchema } from './schemas.js';

const listProfilesStep = createStep({
  id: 'list-registered-project-profiles',
  description: 'Lists enabled project profiles that the Coding Agent Loop may open.',
  inputSchema: z.object({}),
  outputSchema: profileCatalogSchema,
  execute: async () => ({ profiles: await listProjectProfiles() }),
});

export const projectProfileCatalogWorkflow = createWorkflow({
  id: 'project-profile-catalog',
  description: 'Lists the allowlisted projectProfile values accepted by coding-agent-loop.',
  inputSchema: z.object({}),
  outputSchema: profileCatalogSchema,
})
  .then(listProfilesStep)
  .commit();
