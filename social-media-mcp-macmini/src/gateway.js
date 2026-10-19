import { timingSafeEqual } from 'node:crypto';
import { createMcpHandler, fromJsonSchema, hostHeaderValidationResponse, McpServer, originValidationResponse } from '@modelcontextprotocol/server';

export function createGateway(upstreams, { token, allowedHosts }) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('Set MCP_SERVER_TOKEN to at least 32 characters.');
  if (!allowedHosts?.length) throw new Error('Set MCP_ALLOWED_HOSTS to the hostnames clients will use.');
  const expected = Buffer.from(`Bearer ${token}`);
  const tools = [];
  for (const { platform, client, tools: upstreamTools } of upstreams) {
    let pending = Promise.resolve();
    for (const tool of upstreamTools) {
      const name = `${platform}__${tool.name}`;
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) throw new Error(`Unsupported tool name: ${name}`);
      tools.push({
        name,
        config: {
          title: tool.title,
          description: `[${platform}] ${tool.description ?? tool.name}`,
          inputSchema: fromJsonSchema(tool.inputSchema),
          ...(tool.outputSchema ? { outputSchema: fromJsonSchema(tool.outputSchema) } : {}),
          annotations: tool.annotations,
          icons: tool.icons,
          _meta: tool._meta,
        },
        call: async (args, ctx) => {
          const invoke = () => client.callTool({ name: tool.name, arguments: args }, { signal: ctx.signal, timeout: 120000 });
          try {
            // TikTok can rotate its shared refresh token; do not refresh concurrently.
            if (platform !== 'tiktok') return await invoke();
            const result = pending.then(invoke);
            pending = result.catch(() => {});
            return await result;
          } catch (error) {
            console.error(`${platform} tool call failed (${error.constructor.name}).`);
            return { isError: true, content: [{ type: 'text', text: `${platform} tool call failed. Check platform authentication and network access. The call was not retried.` }] };
          }
        },
      });
    }
  }
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'social-media-mcp', version: '0.1.0' }, {
      instructions: 'Tools are prefixed meta__, google__, or tiktok__. When an upstream description refers to an unprefixed tool, use the same platform prefix. The caller AI interprets questions and chooses tools; this server forwards tool calls. All callers share the configured platform credentials. Preserve upstream confirmation requirements before making changes.',
    });
    for (const tool of tools) server.registerTool(tool.name, tool.config, tool.call);
    return server;
  }, { maxRequestBodySize: 1024 * 1024 });
  return {
    close: () => handler.close(),
    async fetch(request) {
      const hostError = hostHeaderValidationResponse(request, allowedHosts);
      if (hostError) return hostError;
      const originError = originValidationResponse(request, allowedHosts);
      if (originError) return originError;
      const provided = Buffer.from(request.headers.get('authorization') ?? '');
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
        return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="social-media-mcp"', 'Cache-Control': 'no-store' } });
      }
      const path = new URL(request.url).pathname;
      if (path === '/health' && request.method === 'GET') {
        return Response.json({ status: 'ok', platforms: upstreams.map(u => ({ name: u.platform, tools: u.tools.length })) });
      }
      if (path !== '/mcp') return new Response('Not found', { status: 404 });
      return handler.fetch(request);
    },
  };
}
