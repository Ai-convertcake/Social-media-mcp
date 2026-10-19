import { createServer as createHttpServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { parseTokenHashes, verifyBearer } from './auth.js';
import { clerkIssuer, createClerkVerifier, createUserCheck } from './clerk-auth.js';
import { createOAuth } from './oauth.js';
import { openStore } from './oauth-store.js';
import { createProxy } from './proxy.js';
import { connectMetaAds } from './meta.js';
import { connectGoogleAds } from './google.js';
import { connectTikTokAds } from './tiktok.js';

const MAX_BODY_BYTES = 1024 * 1024;

// Auth, in order: static smm_ token, our own OAuth access token (smo_, Clerk login),
// then (legacy mode, no own OAuth server) a Clerk-issued OAuth token.
export function createHttpApp({
  proxy,
  tokens = [],
  clerkVerify,
  oauth,
  oauthStore,
  userCheck,
  issuer,
  publicBaseUrl = 'http://127.0.0.1:8780',
  log = console.error,
}) {
  const handler = createMcpHandler(() => proxy.createServer(), { onerror: (e) => log(e.message) });
  const metadataUrl = `${publicBaseUrl}/.well-known/oauth-protected-resource`;
  const authorizationServer = oauth ? publicBaseUrl : issuer;

  const app = createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      // Funnel may mount us under /social-media/ on a shared host; accept it with or without.
      const path = url.pathname.replace(/^\/social-media(?=\/|$)/, '');

      let bodyPromise;
      const readBody = () => {
        bodyPromise ??= (async () => {
          const chunks = [];
          let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) throw Object.assign(new Error('body too large'), { status: 413 });
            chunks.push(chunk);
          }
          return Buffer.concat(chunks);
        })();
        return bodyPromise;
      };

      if (path === '/healthz') {
        res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
        return;
      }
      if (authorizationServer && path.startsWith('/.well-known/oauth-protected-resource')) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            resource: `${publicBaseUrl}/mcp`,
            authorization_servers: [authorizationServer],
            bearer_methods_supported: ['header'],
            scopes_supported: oauth ? [] : ['openid', 'email', 'profile'],
          }),
        );
        return;
      }
      if (oauth && (await oauth(req, res, path, url, readBody))) return;
      if (path !== '/mcp') {
        res.writeHead(404).end();
        return;
      }

      const authorization = req.headers.authorization;
      let label = verifyBearer(authorization, tokens);
      const bearer = /^Bearer (\S+)$/.exec(authorization ?? '')?.[1];
      if (!label && bearer && oauthStore && bearer.startsWith('smo_')) {
        const session = oauthStore.verifyAccess(bearer);
        if (session) label = await userCheck(session.subject);
      }
      if (!label && bearer && clerkVerify && !oauth) {
        try {
          label = await clerkVerify(
            new Request(url, { method: 'POST', headers: { authorization } }),
          );
        } catch (error) {
          log(`clerk verification failed: ${error.message}`);
        }
      }
      if (!label) {
        const challenge = authorizationServer
          ? `Bearer realm="social-media-mcp", resource_metadata="${metadataUrl}"`
          : 'Bearer realm="social-media-mcp"';
        log(`401 ${req.method} ${url.pathname} ua=${req.headers['user-agent'] ?? '-'}`);
        res.writeHead(401, { 'www-authenticate': challenge }).end('Unauthorized');
        return;
      }

      const body = req.method !== 'GET' && req.method !== 'HEAD' ? await readBody() : undefined;
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers.set(key, value);
      }
      const response = await handler.fetch(
        new Request(url, { method: req.method, headers, body }),
      );

      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) {
        for await (const chunk of response.body) res.write(chunk);
      }
      res.end();
      log(`${label} ${req.method} ${url.pathname} ${response.status}`);
    } catch (error) {
      log(`request failed: ${error.message}`);
      if (!res.headersSent) res.writeHead(error.status ?? 500);
      res.end();
    }
  });

  app.on('close', () => {
    handler.close().catch(() => {});
    proxy.close().catch(() => {});
    oauthStore?.close();
  });
  return app;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tokens = parseTokenHashes(process.env.MCP_TOKEN_HASHES);
  const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  const secretKey = process.env.CLERK_SECRET_KEY;
  const useClerk = Boolean(publishableKey && secretKey);
  if (tokens.length === 0 && !useClerk) {
    console.error('Set Clerk keys or MCP_TOKEN_HASHES (generate one with: npm run token:new).');
    process.exit(1);
  }
  const allowedDomain = process.env.CLERK_ALLOWED_EMAIL_DOMAIN ?? 'convertcake.com';
  const host = process.env.HOST ?? '127.0.0.1';
  const port = Number(process.env.PORT ?? 8780);
  const publicBaseUrl = (process.env.PUBLIC_BASE_URL ?? `http://${host}:${port}`).replace(/\/$/, '');

  // Own OAuth server (like company-brain): needs a dedicated Clerk OAuth application.
  const clerkClientId = process.env.MCP_CLERK_CLIENT_ID;
  const clerkClientSecret = process.env.MCP_CLERK_CLIENT_SECRET;
  const ownOAuth = useClerk && Boolean(clerkClientId && clerkClientSecret);

  const userCheck = useClerk ? createUserCheck({ secretKey, publishableKey, allowedDomain }) : undefined;
  const oauthStore = ownOAuth ? openStore(process.env.MCP_OAUTH_DB ?? '/data/oauth.db') : undefined;
  const oauth = ownOAuth
    ? createOAuth({
        store: oauthStore,
        baseUrl: publicBaseUrl,
        clerk: {
          issuer: clerkIssuer(publishableKey),
          clientId: clerkClientId,
          clientSecret: clerkClientSecret,
          scope: process.env.MCP_CLERK_SCOPE ?? 'openid email',
        },
        userCheck,
        allowedDomain,
      })
    : undefined;
  const clerkVerify =
    useClerk && !ownOAuth ? createClerkVerifier({ secretKey, publishableKey, allowedDomain }) : undefined;

  const proxy = createProxy({
    meta: () => connectMetaAds(),
    google: () => connectGoogleAds(),
    tiktok: () => connectTikTokAds(),
  });
  const app = createHttpApp({
    proxy,
    tokens,
    clerkVerify,
    oauth,
    oauthStore,
    userCheck,
    issuer: useClerk ? clerkIssuer(publishableKey) : undefined,
    publicBaseUrl,
  });
  app.listen(port, host, () => {
    const mode = ownOAuth ? 'own OAuth + Clerk login' : useClerk ? 'Clerk OAuth (legacy)' : 'bearer only';
    console.error(`social-media-mcp (read-only, ${mode}) listening on http://${host}:${port}/mcp`);
  });
}
