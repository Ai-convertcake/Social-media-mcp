import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { connectGoogleAds } from './google.js';
import { connectMetaAds } from './meta.js';
import { connectTikTokAds } from './tiktok.js';
import { createGateway } from './gateway.js';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
process.loadEnvFile('.env');

const upstreams = [];
let gateway;
let http;
try {
  const token = process.env.MCP_SERVER_TOKEN?.trim();
  if (!token || token.length < 32) throw new Error('Set MCP_SERVER_TOKEN to at least 32 characters in .env.');
  const host = process.env.MCP_HOST?.trim() || '127.0.0.1';
  const port = Number(process.env.MCP_PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('MCP_PORT must be between 1 and 65535.');
  const allowedHosts = (process.env.MCP_ALLOWED_HOSTS || 'localhost,127.0.0.1,[::1]').split(',').map(s => s.trim()).filter(Boolean);
  for (const [platform, connect] of [['meta', connectMetaAds], ['google', connectGoogleAds], ['tiktok', connectTikTokAds]]) {
    console.error(`Connecting ${platform}...`);
    const client = await connect();
    const upstream = { platform, client, tools: [] };
    upstreams.push(upstream);
    upstream.tools = (await client.listTools()).tools;
    console.error(`${platform}: ${upstream.tools.length} tools`);
  }
  gateway = createGateway(upstreams, { token, allowedHosts });
  const handle = toNodeHandler(gateway);
  http = createServer((req, res) => {
    void handle(req, res).catch(() => {
      console.error('HTTP request failed.');
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, host, resolve);
  });
  console.error(`Social Media MCP ready at http://${host}:${port}/mcp`);
  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    http.close();
    await gateway.close();
    http.closeAllConnections();
    await Promise.allSettled(upstreams.map(u => u.client.close()));
  }
  process.once('SIGTERM', () => { void stop(); });
  process.once('SIGINT', () => { void stop(); });
} catch (error) {
  // Upstream errors can contain credentials; log their type without token-bearing details.
  console.error(`Startup failed (${error.constructor.name}). Check .env, credentials, and platform discovery commands.`);
  http?.close();
  await gateway?.close();
  await Promise.allSettled(upstreams.map(u => u.client.close()));
  process.exitCode = 1;
}
