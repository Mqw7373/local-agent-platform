import { listProjectProfiles } from '../src/mastra/config.js';

console.table(await listProjectProfiles());
