import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UnauthorizedError } from '@modelcontextprotocol/client';
import { connectMetaAds } from '../src/meta.js';

test('missing credentials fail before any network request', async (t) => {
  const network = t.mock.method(globalThis, 'fetch', () => assert.fail('Unexpected request'));
  for (const token of ['', '   ', null, 123]) {
    await assert.rejects(connectMetaAds(token), /Set META_ACCESS_TOKEN/);
  }
  assert.equal(network.mock.callCount(), 0);
});

test('SDK handles handshake, SSE, tool pagination and tool calls', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(String(url), 'https://mcp.facebook.com/ads');
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer test-token');
    if (init.method === 'GET') return new Response(null, { status: 405 });

    const request = JSON.parse(init.body);
    requests.push(request);
    if (request.method === 'notifications/initialized') {
      return new Response(null, { status: 202 });
    }

    let result;
    switch (request.method) {
      case 'initialize':
        result = {
          protocolVersion: request.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'mock-meta', version: '1.0' },
        };
        break;
      case 'tools/list':
        result = request.params?.cursor === 'page-2'
          ? { tools: [{ name: 'get_ad', inputSchema: { type: 'object' } }] }
          : {
              tools: [{ name: 'list_accounts', inputSchema: { type: 'object' } }],
              nextCursor: 'page-2',
            };
        break;
      case 'tools/call':
        assert.deepEqual(request.params, { name: 'get_ad', arguments: { ad_id: '123' } });
        result = { content: [{ type: 'text', text: 'ad result' }] };
        break;
      default:
        assert.fail(`Unexpected method: ${request.method}`);
    }
    return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n\n`, {
      headers: { 'Content-Type': 'text/event-stream' },
    });
  });

  const client = await connectMetaAds('test-token');
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name), ['list_accounts', 'get_ad']);
    assert.equal(requests.filter(request => request.method === 'tools/list').length, 2);
    const result = await client.callTool({ name: 'get_ad', arguments: { ad_id: '123' } });
    assert.equal(result.content[0].text, 'ad result');
  } finally {
    await client.close();
  }
});

test('rejected credentials surface as an authentication error', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 401 }));
  await assert.rejects(connectMetaAds('expired-token'), UnauthorizedError);
});
