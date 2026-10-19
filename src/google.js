import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

export async function connectGoogleAds() {
  const env = {};
  for (const name of [
    'GOOGLE_PROJECT_ID',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_ADS_LOGIN_CUSTOMER_ID',
    'GOOGLE_ADS_DEVELOPER_TOKEN',
  ]) {
    if (process.env[name]?.trim()) env[name] = process.env[name].trim();
  }

  const client = new Client({ name: 'social-media-mcp', version: '0.1.0' });
  const transport = new StdioClientTransport({
    command: fileURLToPath(new URL('../.venv-google/bin/google-ads-mcp', import.meta.url)),
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env,
  });

  try {
    await client.connect(transport);
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}
