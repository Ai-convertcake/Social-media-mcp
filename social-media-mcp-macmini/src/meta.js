import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

export async function connectMetaAds(accessToken = process.env.META_ACCESS_TOKEN) {
  if (typeof accessToken !== 'string' || !accessToken.trim()) {
    throw new Error('Set META_ACCESS_TOKEN before connecting to Meta MCP.');
  }

  const client = new Client({ name: 'social-media-mcp', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(
    new URL('https://mcp.facebook.com/ads'),
    { authProvider: { token: async () => accessToken.trim() } },
  );

  try {
    await client.connect(transport);
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}
