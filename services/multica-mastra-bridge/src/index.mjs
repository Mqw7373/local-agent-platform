import { loadConfig } from './config.mjs';
import { StateStore } from './state-store.mjs';
import { MulticaClient } from './clients/multica-client.mjs';
import { MastraClient } from './clients/mastra-client.mjs';
import { BridgeCoordinator } from './coordinator.mjs';
import { createBridgeServer } from './server.mjs';

const config = await loadConfig();
const store = new StateStore(config.stateFile);
await store.load();

const multicaClients = Object.fromEntries(
  Object.entries(config.multicaConnections).map(([id, connection]) => [id, new MulticaClient(connection)]),
);
const mastraClients = Object.fromEntries(
  Object.entries(config.mastraConnections).map(([id, connection]) => [id, new MastraClient(connection)]),
);

const coordinator = new BridgeCoordinator({ config, store, multicaClients, mastraClients });
const server = createBridgeServer({ config, coordinator });

server.listen(config.server.port, config.server.host, () => {
  console.log(`Multica–Mastra Bridge: http://${config.server.host}:${config.server.port}`);
  console.log(`Health: http://${config.server.host}:${config.server.port}/healthz`);
  for (const binding of coordinator.bindings()) {
    console.log(`Binding ${binding.id}: ${binding.ready ? 'ready' : `inactive (${binding.missing.join(', ')})`}`);
  }
});

let interval;
if (config.polling.enabled) {
  interval = setInterval(() => {
    coordinator.pollOnce().catch(error => console.error('Bridge poll failed', error));
  }, config.polling.intervalMs);
  coordinator.pollOnce().catch(error => console.error('Initial bridge poll failed', error));
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (interval) clearInterval(interval);
    server.close(() => process.exit(0));
  });
}
