import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { generateToken, parseTokenHashes, verifyBearer } from '../src/auth.js';
import { createProxy } from '../src/proxy.js';
import { createHttpApp } from '../src/server.js';

function fakeUpstream(tools, calls) {
  return async () => ({
    listTools: async () => ({ tools }),
    callTool: async (request) => {
      calls.push(request);
      return { content: [{ type: 'text', text: `ran ${request.name}` }] };
    },
    close: async () => {},
  });
}

const schema = { type: 'object', properties: {} };

async function start() {
  const calls = [];
  const { token, hash } = generateToken();
  const proxy = createProxy(
    {
      meta: fakeUpstream(
        [
          { name: 'ads_get_ad_accounts', inputSchema: schema, annotations: { readOnlyHint: true } },
          { name: 'ads_activate_entity', inputSchema: schema, annotations: { readOnlyHint: false } },
          { name: 'ads_get_sneaky', inputSchema: schema, annotations: { readOnlyHint: false } },
          { name: 'not_allowlisted', inputSchema: schema, annotations: { readOnlyHint: true } },
        ],
        calls,
      ),
      google: async () => {
        throw new Error('no credentials');
      },
    },
    {
      allowlist: {
        meta: ['ads_get_ad_accounts', 'ads_get_sneaky'],
        google: ['search_search'],
      },
      log: () => {},
    },
  );
  const app = createHttpApp({
    proxy,
    tokens: parseTokenHashes(`test:${hash}`),
    log: () => {},
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const url = new URL(`http://127.0.0.1:${app.address().port}/mcp`);
  return { app, url, token, calls };
}

test('auth helpers verify only known bearer tokens', () => {
  const { token, hash } = generateToken();
  const entries = parseTokenHashes(`ops:${hash}`);
  assert.equal(verifyBearer(`Bearer ${token}`, entries), 'ops');
  assert.equal(verifyBearer('Bearer smm_wrong', entries), null);
  assert.equal(verifyBearer(undefined, entries), null);
  assert.throws(() => parseTokenHashes('bad'), /label:/);
});

test('rejects requests without a valid bearer token', async () => {
  const { app, url } = await start();
  try {
    const res = await fetch(url, { method: 'POST', body: '{}' });
    assert.equal(res.status, 401);
    const health = await fetch(new URL('/healthz', url));
    assert.equal(health.status, 200);
  } finally {
    app.close();
  }
});

test('exposes only allowlisted read-only tools and never calls others', async () => {
  const { app, url, token, calls } = await start();
  const client = new Client({ name: 'test', version: '0.0.0' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(url, { authProvider: { token: async () => token } }),
    );
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), ['meta_ads_get_ad_accounts']);

    const ok = await client.callTool({ name: 'meta_ads_get_ad_accounts', arguments: {} });
    assert.equal(ok.isError, undefined);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'ads_get_ad_accounts');

    for (const name of ['meta_ads_activate_entity', 'meta_ads_get_sneaky', 'meta_not_allowlisted']) {
      const blocked = await client.callTool({ name, arguments: {} });
      assert.equal(blocked.isError, true, name);
    }
    assert.equal(calls.length, 1);
  } finally {
    await client.close();
    app.close();
  }
});
