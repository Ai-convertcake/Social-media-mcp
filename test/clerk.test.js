import assert from 'node:assert/strict';
import test from 'node:test';
import { clerkIssuer, createClerkVerifier, isAllowedEmail } from '../src/clerk-auth.js';
import { createProxy } from '../src/proxy.js';
import { createHttpApp } from '../src/server.js';

function fakeClerk({ authenticated = true, userId = 'user_1', emails }) {
  let lookups = 0;
  return {
    get lookups() {
      return lookups;
    },
    authenticateRequest: async () => ({
      isAuthenticated: authenticated,
      toAuth: () => ({ userId }),
    }),
    users: {
      getUser: async () => {
        lookups += 1;
        return { primaryEmailAddressId: 'e1', emailAddresses: emails };
      },
    },
  };
}

const request = new Request('http://localhost/mcp', { headers: { authorization: 'Bearer oat_x' } });
const verified = (emailAddress) => [
  { id: 'e1', emailAddress, verification: { status: 'verified' } },
];

test('issuer is decoded from the publishable key', () => {
  const key = `pk_test_${Buffer.from('lucky-gopher-1.clerk.accounts.dev$').toString('base64')}`;
  assert.equal(clerkIssuer(key), 'https://lucky-gopher-1.clerk.accounts.dev');
  assert.throws(() => clerkIssuer('nope'), /Invalid/);
});

test('email domain must match exactly', () => {
  assert.equal(isAllowedEmail('a@convertcake.com', 'convertcake.com'), true);
  assert.equal(isAllowedEmail('A@ConvertCake.com', 'convertcake.com'), true);
  assert.equal(isAllowedEmail('a@evil-convertcake.com', 'convertcake.com'), false);
  assert.equal(isAllowedEmail('a@convertcake.com.evil.io', 'convertcake.com'), false);
  assert.equal(isAllowedEmail('a@sub.convertcake.com', 'convertcake.com'), false);
});

test('verifier accepts verified company emails and caches the lookup', async () => {
  const clerk = fakeClerk({ emails: verified('dev@convertcake.com') });
  const verify = createClerkVerifier({ clerk });
  assert.equal(await verify(request), 'dev@convertcake.com');
  assert.equal(await verify(request), 'dev@convertcake.com');
  assert.equal(clerk.lookups, 1);
});

test('verifier rejects other domains, unverified emails and bad tokens', async () => {
  const other = createClerkVerifier({ clerk: fakeClerk({ emails: verified('x@gmail.com') }) });
  assert.equal(await other(request), null);

  const unverified = createClerkVerifier({
    clerk: fakeClerk({
      emails: [{ id: 'e1', emailAddress: 'dev@convertcake.com', verification: { status: 'unverified' } }],
    }),
  });
  assert.equal(await unverified(request), null);

  const rejected = createClerkVerifier({
    clerk: fakeClerk({ authenticated: false, emails: verified('dev@convertcake.com') }),
  });
  assert.equal(await rejected(request), null);
});

test('HTTP app advertises Clerk and admits only verified users', async () => {
  const proxy = createProxy({}, { allowlist: {}, log: () => {} });
  const app = createHttpApp({
    proxy,
    clerkVerify: async (req) =>
      req.headers.get('authorization') === 'Bearer oat_good' ? 'dev@convertcake.com' : null,
    issuer: 'https://example.clerk.accounts.dev',
    publicBaseUrl: 'http://127.0.0.1:1',
    log: () => {},
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    const meta = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
    assert.deepEqual(meta.authorization_servers, ['https://example.clerk.accounts.dev']);

    // Mounted under /social-media/ on a shared Funnel host: same routes, prefix tolerated.
    const prefixed = await fetch(`${base}/social-media/.well-known/oauth-protected-resource`);
    assert.equal(prefixed.status, 200);
    assert.equal((await fetch(`${base}/social-media/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/social-media/mcp`, { method: 'POST', body: '{}' })).status, 401);

    const denied = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer oat_bad' },
      body: '{}',
    });
    assert.equal(denied.status, 401);
    assert.match(denied.headers.get('www-authenticate'), /resource_metadata=/);

    const allowed = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer oat_good', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.notEqual(allowed.status, 401);
  } finally {
    app.close();
  }
});
