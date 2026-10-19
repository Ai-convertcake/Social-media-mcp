import { createClerkClient } from '@clerk/backend';

const CACHE_MS = 5 * 60 * 1000;

// Clerk's frontend API host is base64-encoded inside the publishable key (pk_test_<b64>$).
export function clerkIssuer(publishableKey) {
  const encoded = publishableKey?.split('_')[2] ?? '';
  const host = Buffer.from(encoded, 'base64').toString('utf8').replace(/\$$/, '');
  if (!host) throw new Error('Invalid NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY.');
  return `https://${host}`;
}

export function isAllowedEmail(email, domain) {
  const at = email.lastIndexOf('@');
  return at > 0 && email.slice(at + 1).toLowerCase() === domain.toLowerCase();
}

// Returns async (clerkUserId) => verified company email | null, asking Clerk (cached 5 minutes)
// so removing or changing someone in Clerk takes effect within the cache window.
export function createUserCheck({
  secretKey,
  publishableKey,
  allowedDomain = 'convertcake.com',
  clerk = createClerkClient({ secretKey, publishableKey }),
  now = Date.now,
}) {
  const cache = new Map();

  return async function emailFor(userId) {
    const hit = cache.get(userId);
    if (hit && hit.expires > now()) return hit.email;
    let email = null;
    try {
      const user = await clerk.users.getUser(userId);
      const primary = user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId);
      const candidate = primary?.verification?.status === 'verified' ? primary.emailAddress : null;
      email = candidate && isAllowedEmail(candidate, allowedDomain) ? candidate : null;
    } catch {
      email = null;
    }
    cache.set(userId, { email, expires: now() + CACHE_MS });
    return email;
  };
}

// Returns async (Request) => email | null. Accepts Clerk OAuth access tokens only.
export function createClerkVerifier({
  clerk,
  allowedDomain = 'convertcake.com',
  now = Date.now,
  ...options
}) {
  const client = clerk ?? createClerkClient({
    secretKey: options.secretKey,
    publishableKey: options.publishableKey,
  });
  const emailFor = createUserCheck({ clerk: client, allowedDomain, now });

  return async function verify(request) {
    const state = await client.authenticateRequest(request, { acceptsToken: 'oauth_token' });
    if (!state.isAuthenticated) return null;
    const userId = state.toAuth().userId;
    return userId ? emailFor(userId) : null;
  };
}
