import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createTikTokAuthProvider, TIKTOK_MCP_URL } from './tiktok-auth.js';

export async function connectTikTokAds(authProvider) {
  authProvider ??= await createTikTokAuthProvider();
  if (!authProvider.tokens()?.access_token) {
    throw new Error('Run npm run tiktok:login to authorize TikTok.');
  }
  const client = new Client({ name: 'social-media-mcp', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(TIKTOK_MCP_URL), { authProvider });
  try {
    await client.connect(transport);
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}
