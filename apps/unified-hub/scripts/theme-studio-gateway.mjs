import http from 'node:http';

const gatewayPort = Number(process.env.THEME_STUDIO_GATEWAY_PORT ?? 3001);
const studioPort = Number(process.env.THEME_STUDIO_UI_PORT ?? 3002);
const apiPort = Number(process.env.THEME_RESEARCH_API_PORT ?? 4112);

const server = http.createServer((request, response) => {
  const apiRequest = request.url === '/api' || request.url?.startsWith('/api/');
  const upstreamPort = apiRequest ? apiPort : studioPort;

  const upstream = http.request(
    {
      hostname: '127.0.0.1',
      port: upstreamPort,
      path: request.url,
      method: request.method,
      headers: {
        ...request.headers,
        host: `localhost:${upstreamPort}`,
      },
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );

  upstream.on('error', (error) => {
    if (response.headersSent) {
      response.destroy(error);
      return;
    }

    response.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({
      error: 'theme_studio_upstream_unavailable',
      target: apiRequest ? `http://localhost:${apiPort}` : `http://localhost:${studioPort}`,
    }));
  });

  request.pipe(upstream);
});

server.listen(gatewayPort, '127.0.0.1', () => {
  console.log(`Theme Studio gateway: http://localhost:${gatewayPort}`);
  console.log(`Studio UI upstream:    http://localhost:${studioPort}`);
  console.log(`Theme API upstream:    http://localhost:${apiPort}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
