import { UnauthorizedError } from '@modelcontextprotocol/client';
import { connectMetaAds } from './meta.js';

try {
  const client = await connectMetaAds();
  try {
    console.log(JSON.stringify(await client.listTools(), null, 2));
  } finally {
    await client.close();
  }
} catch (error) {
  const message = error instanceof UnauthorizedError
    ? 'Meta rejected the access token. Check its expiry and MCP permissions.'
    : error.message;
  const token = process.env.META_ACCESS_TOKEN?.trim();
  console.error(token ? message.replaceAll(token, '[REDACTED]') : message);
  process.exitCode = 1;
}
