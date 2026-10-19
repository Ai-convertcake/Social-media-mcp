import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { connectGoogleAds } from '../src/google.js';

test('starts the official Google MCP and discovers its read tools', {
  skip: !existsSync(new URL('../.venv-google/bin/google-ads-mcp', import.meta.url)),
  timeout: 20000,
}, async (t) => {
  // Unrelated credentials must not change the child server's local stdio mode.
  for (const name of ['META_ACCESS_TOKEN', 'GOOGLE_ADS_MCP_OAUTH_CLIENT_ID', 'GOOGLE_ADS_MCP_OAUTH_CLIENT_SECRET']) {
    const previous = process.env[name];
    process.env[name] = 'unrelated-test-credential';
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
  const client = await connectGoogleAds();
  try {
    const { tools } = await client.listTools();
    const names = tools.map(tool => tool.name);
    for (const expected of ['customers_list_accessible_customers', 'metadata_get_resource_metadata', 'search_search']) {
      assert(names.includes(expected), `Missing tool: ${expected}`);
    }
  } finally {
    await client.close();
  }
});
