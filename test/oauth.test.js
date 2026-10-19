import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import { createOAuth, redirectAllowed, parseRedirects } from '../src/oauth.js';
import { openStore } from '../src/oauth-store.js';
import { createProxy } from '../src/proxy.js';
import { createHttpApp } from '../src/server.js';

const BASE = 'https://mcp.test/social-media';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

async function start({ email = 'dev@convertcake.com' } = {}) {
  const store = openStore(':memory:');
  const allowed = new Set(['user_1']);
  const userCheck = async (subject) => (allowed.has(subject) ? 'dev@convertcake.com' : null);
  const fakeClerk = async (url) => {
    if (String(url).endsWith('/oauth/token')) return Response.json({ access_token: 'clerk-access' });
    return Response.json({ user_id: 'user_1', email, email_verified: true });
  };
  const oauth = createOAuth({
    store,
    baseUrl: BASE,
    clerk: { issuer: 'https://clerk.test', clientId: 'cid', clientSecret: 'sec', fetch: fakeClerk },
    userCheck,
    log: () => {},
  });
  const app = createHttpApp({
    proxy: createProxy({}, { allowlist: {}, log: () => {} }),
    oauth,
    oauthStore: store,
    userCheck,
    publicBaseUrl: BASE,
    log: () => {},
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.address().port}`;
  const call = (path, init = {}) => fetch(origin + path, { redirect: 'manual', ...init });
  return { app, call, allowed };
}

const pathOf = (location) => new URL(location).pathname.replace('/social-media', '') + new URL(location).search;
const formBody = (values) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(values),
});

async function signIn(call, { cookie = true } = {}) {
  const reg = await call('/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: 'Claude' }),
  });
  assert.equal(reg.status, 201);
  const { client_id: clientId } = await reg.json();

  const verifier = randomBytes(40).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorize = await call(
    `/authorize?${new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'xyz',
    })}`,
  );
  assert.equal(authorize.status, 302);
  const signin = await call(pathOf(authorize.headers.get('location')));
  assert.equal(signin.status, 200);
  const nonce = /smm_signin=([^;]+)/.exec(signin.headers.get('set-cookie'))[1];
  const html = await signin.text();
  const request = /name="request" value="([^"]+)"/.exec(html)[1];

  const start = await call('/signin/clerk', {
    ...formBody({ request, csrf: nonce }),
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `smm_signin=${nonce}` },
  });
  assert.equal(start.status, 302);
  const clerkUrl = new URL(start.headers.get('location'));
  assert.equal(clerkUrl.origin, 'https://clerk.test');
  assert.equal(clerkUrl.searchParams.get('client_id'), 'cid');

  const callback = await call(
    `/oauth/clerk/callback?state=${clerkUrl.searchParams.get('state')}&code=clerk-code`,
    { headers: cookie ? { cookie: `smm_signin=${nonce}` } : {} },
  );
  return { callback, clientId, verifier };
}

test('redirect allowlist is parsed, not prefix-matched', () => {
  const allowed = parseRedirects();
  assert.equal(redirectAllowed(REDIRECT, allowed), true);
  assert.equal(redirectAllowed('http://localhost:6274/callback', allowed), true);
  assert.equal(redirectAllowed('https://claude.ai.evil.example/cb', allowed), false);
  assert.equal(redirectAllowed('http://localhost:@evil.example/', allowed), false);
  assert.equal(redirectAllowed('https://claude.ai:8443/cb', allowed), false);
  assert.equal(redirectAllowed('http://claude.ai/cb', allowed), false);
});

test('metadata advertises dynamic registration and S256 only', async () => {
  const { app, call } = await start();
  try {
    const meta = await (await call('/.well-known/oauth-authorization-server')).json();
    assert.equal(meta.issuer, BASE);
    assert.equal(meta.registration_endpoint, `${BASE}/register`);
    assert.deepEqual(meta.code_challenge_methods_supported, ['S256']);
    const prm = await (await call('/.well-known/oauth-protected-resource')).json();
    assert.deepEqual(prm.authorization_servers, [BASE]);
    assert.equal(prm.resource, `${BASE}/mcp`);

    const bad = await call('/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://evil.example/cb'] }),
    });
    assert.equal(bad.status, 400);
  } finally {
    app.close();
  }
});

test('full flow: register, Clerk sign-in, code + PKCE, token, MCP access, refresh rotation', async () => {
  const { app, call, allowed } = await start();
  try {
    const first = await signIn(call);
    assert.equal(first.callback.status, 302);
    const back = new URL(first.callback.headers.get('location'));
    assert.equal(back.origin + back.pathname, REDIRECT);
    assert.equal(back.searchParams.get('state'), 'xyz');
    const code = back.searchParams.get('code');

    const wrong = await call('/token', formBody({
      grant_type: 'authorization_code', client_id: first.clientId, code, redirect_uri: REDIRECT,
      code_verifier: 'not-the-verifier',
    }));
    assert.equal(wrong.status, 400); // PKCE mismatch

    const burned = await call('/token', formBody({
      grant_type: 'authorization_code', client_id: first.clientId, code, redirect_uri: REDIRECT,
      code_verifier: first.verifier,
    }));
    assert.equal(burned.status, 400); // the failed attempt used up the code

    const second = await signIn(call);
    const code2 = new URL(second.callback.headers.get('location')).searchParams.get('code');
    const ok = await call('/token', formBody({
      grant_type: 'authorization_code', client_id: second.clientId, code: code2, redirect_uri: REDIRECT,
      code_verifier: second.verifier,
    }));
    assert.equal(ok.status, 200);
    const tokens = await ok.json();
    assert.match(tokens.access_token, /^smo_/);

    const mcp = await call('/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.notEqual(mcp.status, 401);

    const refreshed = await call('/token', formBody({
      grant_type: 'refresh_token', client_id: second.clientId, refresh_token: tokens.refresh_token,
    }));
    assert.equal(refreshed.status, 200);
    const again = await call('/token', formBody({
      grant_type: 'refresh_token', client_id: second.clientId, refresh_token: tokens.refresh_token,
    }));
    assert.equal(again.status, 400); // rotated

    // Someone removed in Clerk loses access.
    allowed.delete('user_1');
    const gone = await call('/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokens.access_token}` },
      body: '{}',
    });
    assert.equal(gone.status, 401);
  } finally {
    app.close();
  }
});

test('rejects non-company email and callbacks from another browser', async () => {
  const outsider = await start({ email: 'x@gmail.com' });
  try {
    const { callback } = await signIn(outsider.call);
    assert.equal(callback.status, 400);
  } finally {
    outsider.app.close();
  }

  const { app, call } = await start();
  try {
    const { callback } = await signIn(call, { cookie: false });
    assert.equal(callback.status, 400);
  } finally {
    app.close();
  }
});
