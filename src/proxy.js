import { Server } from '@modelcontextprotocol/server';
import { readFileSync } from 'node:fs';

const ALLOWLIST = JSON.parse(
  readFileSync(new URL('./readonly-tools.json', import.meta.url), 'utf8'),
);

// Exposed tool name = `${platform}_${upstreamName}`. Only allowlisted tools whose
// upstream annotation (when present) also says readOnlyHint are exposed or callable.
export function createProxy(connectors, { allowlist = ALLOWLIST, log = console.error } = {}) {
  const upstreams = new Map();

  function getUpstream(platform) {
    if (!upstreams.has(platform)) {
      const promise = connectors[platform]().catch((error) => {
        upstreams.delete(platform);
        throw error;
      });
      upstreams.set(platform, promise);
    }
    return upstreams.get(platform);
  }

  async function exposedTools() {
    const exposed = new Map();
    for (const platform of Object.keys(connectors)) {
      const allowed = new Set(allowlist[platform] ?? []);
      let tools;
      try {
        const client = await getUpstream(platform);
        ({ tools } = await client.listTools());
      } catch (error) {
        log(`${platform} unavailable: ${error.message}`);
        continue;
      }
      for (const tool of tools) {
        if (!allowed.has(tool.name)) continue;
        if (tool.annotations?.readOnlyHint === false) continue;
        exposed.set(`${platform}_${tool.name}`, { platform, upstreamName: tool.name, tool });
      }
    }
    return exposed;
  }

  function createServer() {
    const server = new Server(
      { name: 'social-media-mcp', version: '0.1.0' },
      { capabilities: { tools: {} } },
    );

    server.setRequestHandler('tools/list', async () => {
      const exposed = await exposedTools();
      return {
        tools: [...exposed].map(([name, { tool }]) => ({
          name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: { readOnlyHint: true, destructiveHint: false },
        })),
      };
    });

    server.setRequestHandler('tools/call', async (request) => {
      const { name, arguments: args } = request.params;
      const exposed = await exposedTools();
      const entry = exposed.get(name);
      if (!entry) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Unknown or non-read-only tool: ${name}` }],
        };
      }
      const client = await getUpstream(entry.platform);
      return client.callTool({ name: entry.upstreamName, arguments: args ?? {} });
    });

    return server;
  }

  async function close() {
    for (const promise of upstreams.values()) {
      try {
        await (await promise).close();
      } catch {
        // already closed or never connected
      }
    }
    upstreams.clear();
  }

  return { createServer, close };
}
