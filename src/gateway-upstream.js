import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

// Presents the macmini gateway (one MCP server, tools prefixed `meta__`, `google__`, `tiktok__`)
// as the per-platform upstreams that proxy.js expects: unprefixed names, listTools/callTool/close.
// proxy.js still applies the read-only allowlist, so write tools stay unreachable.
// localTools ({ platform: [{ tool, call(args) }] }) adds read-only tools served by this
// process itself, listed and called alongside that platform's gateway tools.
export function createGatewayUpstreams({
  url,
  token,
  platforms = ['meta', 'google', 'tiktok'],
  localTools = {},
  connect = async () => {
    const client = new Client({ name: 'social-media-mcp-front', version: '0.1.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), { authProvider: { token: async () => token } }),
    );
    return client;
  },
}) {
  let current;

  async function gateway() {
    current ??= connect().catch((error) => {
      current = undefined;
      throw error;
    });
    return current;
  }

  // Read-only calls are safe to repeat, so one reconnect-and-retry covers a gateway restart.
  async function withGateway(fn) {
    try {
      return await fn(await gateway());
    } catch {
      const stale = current;
      current = undefined;
      stale?.then((client) => client.close()).catch(() => {});
      return fn(await gateway());
    }
  }

  const view = (platform) => {
    const prefix = `${platform}__`;
    const local = new Map((localTools[platform] ?? []).map((entry) => [entry.tool.name, entry]));
    return {
      listTools: async () => {
        const { tools } = await withGateway((client) => client.listTools());
        return {
          tools: tools
            .filter((tool) => tool.name.startsWith(prefix))
            .map((tool) => ({ ...tool, name: tool.name.slice(prefix.length) }))
            .concat([...local.values()].map((entry) => entry.tool)),
        };
      },
      callTool: (request, ...rest) => {
        const entry = local.get(request.name);
        if (entry) return entry.call(request.arguments ?? {});
        return withGateway((client) => client.callTool({ ...request, name: prefix + request.name }, ...rest));
      },
      close: async () => {},
    };
  };

  const connectors = Object.fromEntries(platforms.map((p) => [p, async () => view(p)]));
  const close = async () => {
    const client = await current?.catch(() => undefined);
    current = undefined;
    await client?.close().catch(() => {});
  };
  return { connectors, close };
}
