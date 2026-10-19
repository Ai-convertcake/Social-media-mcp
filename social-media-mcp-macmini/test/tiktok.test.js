import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { UnauthorizedError } from '@modelcontextprotocol/client';
import { createTikTokAuthProvider, TIKTOK_MCP_URL, TIKTOK_REDIRECT_URL } from '../src/tiktok-auth.js';
import { readTikTokCallback } from '../src/tiktok-login.js';
import { connectTikTokAds } from '../src/tiktok.js';

async function makeProvider(t) {
  const directory = await mkdtemp(join(tmpdir(), 'tiktok-mcp-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'credentials.json');
  return { file, provider: await createTikTokAuthProvider(undefined, file) };
}

test('OAuth credentials persist privately; PKCE and state stay in the login session', async (t) => {
  const { provider, file } = await makeProvider(t);
  assert.equal(provider.tokens(), undefined);
  await assert.rejects(connectTikTokAds(provider), /tiktok:login/);
  await provider.saveClientInformation({ client_id: 'test-client', issuer: 'https://example.com' });
  await provider.saveTokens({ access_token: 'test-token', refresh_token: 'test-refresh', token_type: 'bearer' });
  provider.saveCodeVerifier('private-verifier');
  assert.equal(provider.codeVerifier(), 'private-verifier');
  const reloaded = await createTikTokAuthProvider(undefined, file);
  assert.equal(reloaded.tokens().access_token, 'test-token');
  assert.equal(reloaded.clientInformation().client_id, 'test-client');
  assert.notEqual(reloaded.state(), provider.state());
  assert.throws(() => reloaded.codeVerifier(), /No TikTok login/);
  assert.throws(() => reloaded.redirectToAuthorization(new URL('https://example.com')), /tiktok:login/);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert(!(await readFile(file, 'utf8')).includes('private-verifier'));
  await writeFile(file, 'not json');
  await assert.rejects(createTikTokAuthProvider(undefined, file), SyntaxError);
});

test('OAuth callback requires the expected state, path and authorization code', () => {
  const url = new URL(`${TIKTOK_REDIRECT_URL}?state=expected&code=auth-code&iss=https%3A%2F%2Fexample.com`);
  assert.deepEqual(readTikTokCallback(url, 'expected'), {
    authorizationCode: 'auth-code', iss: 'https://example.com',
  });
  for (const value of [
    '/callback?state=wrong&code=auth-code',
    '/callback?code=auth-code',
    '/callback?state=expected',
    '/callback?state=expected&error=access_denied',
    '/wrong?state=expected&code=auth-code',
  ]) assert.throws(() => readTikTokCallback(new URL(value, TIKTOK_REDIRECT_URL), 'expected'));
});

test('TikTok SDK connection discovers tools and executes a read tool with its bearer token', async (t) => {
  const { provider } = await makeProvider(t);
  await provider.saveTokens({ access_token: 'test-token', token_type: 'bearer' });
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(String(url), TIKTOK_MCP_URL);
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer test-token');
    if (init.method === 'GET') return new Response(null, { status: 405 });
    const request = JSON.parse(init.body);
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
    let result;
    switch (request.method) {
      case 'initialize':
        result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'mock-tiktok', version: '1.0' } };
        break;
      case 'tools/list':
        result = { tools: [{ name: 'list_advertisers_fixture', inputSchema: { type: 'object' } }] };
        break;
      case 'tools/call':
        assert.deepEqual(request.params, { name: 'list_advertisers_fixture', arguments: {} });
        result = { content: [{ type: 'text', text: '{"advertisers":[]}' }] };
        break;
      default: assert.fail(`Unexpected method: ${request.method}`);
    }
    return Response.json({ jsonrpc: '2.0', id: request.id, result });
  });
  const client = await connectTikTokAds(provider);
  try {
    assert.equal((await client.listTools()).tools[0].name, 'list_advertisers_fixture');
    const result = await client.callTool({ name: 'list_advertisers_fixture', arguments: {} });
    assert.deepEqual(JSON.parse(result.content[0].text), { advertisers: [] });
  } finally { await client.close(); }
});

test('bearer-only TikTok credentials surface authentication rejection', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 401 }));
  await assert.rejects(connectTikTokAds({
    tokens: () => ({ access_token: 'expired-token' }),
    token: async () => 'expired-token',
  }), UnauthorizedError);
});
