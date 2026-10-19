import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createGateway } from '../src/gateway.js';

const token = 'test-token-012345678901234567890123456789';
const url = 'http://127.0.0.1:3000/mcp';
const schema = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false };
function webRequest(input, init) {
  const request = new Request(input, init);
  if (!request.headers.has('host')) request.headers.set('host', new URL(request.url).host);
  return request;
}

test('HTTP gateway rejects invalid tokens, Host and Origin before calling tools', async () => {
  const gateway = createGateway([], { token, allowedHosts: ['127.0.0.1'] });
  try {
    for (const auth of [undefined, 'Bearer wrong', `Basic ${token}`]) {
      const response = await gateway.fetch(webRequest(url, { headers: auth ? { authorization: auth } : {} }));
      assert.equal(response.status, 401);
    }
    const authorization = `Bearer ${token}`;
    assert.equal((await gateway.fetch(webRequest(url, { headers: { authorization, host: 'attacker.example' } }))).status, 403);
    assert.equal((await gateway.fetch(webRequest(url, { headers: { authorization, origin: 'https://attacker.example' } }))).status, 403);
    const health = await gateway.fetch(webRequest('http://127.0.0.1:3000/health', { headers: { authorization } }));
    assert.deepEqual(await health.json(), { status: 'ok', platforms: [] });
    assert.equal((await gateway.fetch(webRequest('http://127.0.0.1:3000/missing', { headers: { authorization } }))).status, 404);
  } finally { await gateway.close(); }
  assert.throws(() => createGateway([], { token: '', allowedHosts: ['127.0.0.1'] }), /MCP_SERVER_TOKEN/);
});

test('MCP discovery preserves schemas/annotations and routes calls only to the correct platform', async () => {
  const calls = [];
  const upstreams = ['meta', 'google', 'tiktok'].map(platform => ({
    platform,
    tools: [{ name: 'get_item', description: 'Fetch item', inputSchema: schema, annotations: { readOnlyHint: true } }],
    client: { callTool: async args => { calls.push({ platform, ...args }); return { content: [{ type: 'text', text: platform }] }; } },
  }));
  const gateway = createGateway(upstreams, { token, allowedHosts: ['127.0.0.1'] });
  const client = new Client({ name: 'gateway-test', version: '1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    authProvider: { token: async () => token },
    fetch: (input, init) => gateway.fetch(webRequest(input, init)),
  });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(t => t.name), ['meta__get_item', 'google__get_item', 'tiktok__get_item']);
    assert.deepEqual(tools[0].inputSchema, schema);
    assert.equal(tools[0].annotations.readOnlyHint, true);
    const result = await client.callTool({ name: 'google__get_item', arguments: { id: '123' } });
    assert.equal(result.content[0].text, 'google');
    assert.deepEqual(calls, [{ platform: 'google', name: 'get_item', arguments: { id: '123' } }]);
    const invalid = await client.callTool({ name: 'meta__get_item', arguments: { id: 123 } });
    assert.equal(invalid.isError, true);
    assert.equal(calls.length, 1);
  } finally { await client.close(); await gateway.close(); }
});

test('TikTok calls serialize and a failed call does not block the next call or expose tokens', async () => {
  let active = 0;
  let maximum = 0;
  let attempts = 0;
  const gateway = createGateway([{
    platform: 'tiktok', tools: [{ name: 'get_item', inputSchema: schema }],
    client: { callTool: async () => {
      active++; maximum = Math.max(maximum, active); attempts++;
      await new Promise(resolve => setTimeout(resolve, 10));
      active--;
      if (attempts === 1) throw new Error(`secret: ${token}`);
      return { content: [{ type: 'text', text: 'ok' }] };
    } },
  }], { token, allowedHosts: ['127.0.0.1'] });
  const client = new Client({ name: 'gateway-test', version: '1.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url), {
      authProvider: { token: async () => token },
      fetch: (input, init) => gateway.fetch(webRequest(input, init)),
    }));
    await client.listTools();
    const results = await Promise.all([1, 2].map(id => client.callTool({ name: 'tiktok__get_item', arguments: { id: String(id) } })));
    assert.equal(maximum, 1);
    assert.equal(attempts, 2);
    assert.equal(results[0].isError, true);
    assert(!JSON.stringify(results[0]).includes(token));
    assert.equal(results[1].content[0].text, 'ok');
  } finally { await client.close(); await gateway.close(); }
});
