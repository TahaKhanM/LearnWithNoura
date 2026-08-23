import { server, runtimeConfig } from './app.js';

const port = Number(process.env.NOURA_PORT ?? process.env.PORT) || 8787;

server.listen(port, () => {
  console.log(`Noura backend listening on http://localhost:${port} (${runtimeConfig.deploymentMode})`);
});
