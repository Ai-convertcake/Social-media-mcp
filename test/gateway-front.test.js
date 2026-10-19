import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { generateToken, parseTokenHashes } from '../src/auth.js';
import { createGatewayUpstreams } from '../src/gateway-upstream.js';
import { createProxy } from '../src/proxy.js';
import { createHttpApp } from '../src/server.js';

const schema = { type: 'object', properties: {} };
const tools = [
  { name: 'meta__ads_get_ad_accounts', inputSchema: schema, annotations: { readOnlyHint: true } },
  { name: 'meta__ads_activate_entity', inputSchema: schema, annotations: { readOnlyHint: false } },
  { name: 'google__search_search', inputSchema: schema, annotations: { readOnlyHint: true } },
  { name: 'tiktok__campaign_create', inputSchema: schema },
  { name: 'tiktok__auth_advertiser_get', inputSchema: schema, annotations: { readOnlyHint: true } },
];

function fakeGateway(calls, { failFirst = false } = {}) {
  let connects = 0;
  const connect = async () => {
    connects += 1;
    const broken = failFirst && connects === 1;
    return {
      listTools: async () => {
        if (broken) throw new Error('gateway restarted');
        return { tools };
      },
      callTool: async (request) => {
        if (broken) throw new Error('gateway restarted');
        calls.push(request);
        return { content: [{ type: 'text', text: `ran ${request.name}` }] };
      },
      close: async () => {},
    };
  };
  return { connect, get connects() { return connects; } };
}

async function start(gatewayOptions, localTools) {
  const calls = [];
  const fake = fakeGateway(calls, gatewayOptions);
  const gateway = createGatewayUpstreams({ connect: fake.connect, localTools });
  const { token, hash } = generateToken();
  const app = createHttpApp({
    proxy: createProxy(gateway.connectors, {
      allowlist: {
        meta: ['ads_get_ad_accounts', 'ads_activate_entity', 'get_utm_links'],
        google: ['search_search'],
        tiktok: ['auth_advertiser_get'],
      },
      log: () => {},
    }),
    tokens: parseTokenHashes(`t:${hash}`),
    log: () => {},
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${app.address().port}/mcp`), {
      authProvider: { token: async () => token },
    }),
  );
  return { app, client, calls, fake };
}

test('gateway tools are exposed per platform, unprefixed upstream, read-only only', async () => {
  const { app, client, calls } = await start();
  try {
    const listed = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(listed, [
      'google_search_search',
      'meta_ads_get_ad_accounts',
      'tiktok_auth_advertiser_get',
    ]);

    const ok = await client.callTool({ name: 'meta_ads_get_ad_accounts', arguments: {} });
    assert.equal(ok.isError, undefined);
    assert.equal(calls[0].name, 'meta__ads_get_ad_accounts');

    // Flagged write upstream (even if allowlisted by name) or not on the allowlist: never reachable.
    for (const name of ['meta_ads_activate_entity', 'tiktok_campaign_create']) {
      const blocked = await client.callTool({ name, arguments: {} });
      assert.equal(blocked.isError, true, name);
    }
    assert.equal(calls.length, 1);
  } finally {
    await client.close();
    app.close();
  }
});

test('a restarted gateway is reconnected once instead of failing the call', async () => {
  const { app, client, calls, fake } = await start({ failFirst: true });
  try {
    const ok = await client.callTool({ name: 'google_search_search', arguments: {} });
    assert.equal(ok.isError, undefined);
    assert.equal(calls[0].name, 'google__search_search');
    assert.equal(fake.connects, 2);
  } finally {
    await client.close();
    app.close();
  }
});

test('local tools are listed and served next to the gateway tools without reaching it', async () => {
  const localCalls = [];
  const { app, client, calls } = await start(undefined, {
    meta: [
      {
        tool: { name: 'get_utm_links', inputSchema: schema, annotations: { readOnlyHint: true } },
        call: async (args) => {
          localCalls.push(args);
          return { content: [{ type: 'text', text: 'utm report' }] };
        },
      },
    ],
  });
  try {
    const listed = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(listed.includes('meta_get_utm_links'));
    assert.ok(listed.includes('meta_ads_get_ad_accounts'));

    const result = await client.callTool({ name: 'meta_get_utm_links', arguments: { ad_account_id: '123' } });
    assert.equal(result.content[0].text, 'utm report');
    assert.deepEqual(localCalls, [{ ad_account_id: '123' }]);
    assert.equal(calls.length, 0);
  } finally {
    await client.close();
    app.close();
  }
});
