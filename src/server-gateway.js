import { parseTokenHashes } from './auth.js';
import { clerkIssuer, createClerkVerifier, createUserCheck } from './clerk-auth.js';
import { createGatewayUpstreams } from './gateway-upstream.js';
import { getUtmLinks, utmLinksTool } from './meta-utm.js';
import { createOAuth } from './oauth.js';
import { openStore } from './oauth-store.js';
import { createProxy } from './proxy.js';
import { createHttpApp } from './server.js';

// Same front as src/server.js (static smm_ tokens, own OAuth + Clerk sign-in, read-only
// allowlist), but the platform tools come from the macmini gateway instead of three connectors.
const gatewayUrl = process.env.GATEWAY_URL ?? 'http://social-media-mcp-gateway:3000/mcp';
const gatewayToken = process.env.GATEWAY_TOKEN?.trim();
if (!gatewayToken) {
  console.error('Set GATEWAY_TOKEN (the gateway MCP_SERVER_TOKEN).');
  process.exit(1);
}

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

const metaToken = process.env.META_ACCESS_TOKEN?.trim();
const gateway = createGatewayUpstreams({
  url: gatewayUrl,
  token: gatewayToken,
  localTools: {
    meta: [
      {
        tool: utmLinksTool,
        call: async ({ ad_account_id }) => {
          try {
            const result = await getUtmLinks({ adAccountId: ad_account_id, token: metaToken });
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
          } catch (error) {
            const message = metaToken ? error.message.replaceAll(metaToken, '[REDACTED]') : error.message;
            return { isError: true, content: [{ type: 'text', text: message }] };
          }
        },
      },
    ],
  },
});
const app = createHttpApp({
  proxy: createProxy(gateway.connectors),
  tokens,
  clerkVerify,
  oauth,
  oauthStore,
  userCheck,
  issuer: useClerk ? clerkIssuer(publishableKey) : undefined,
  publicBaseUrl,
});
app.on('close', () => {
  gateway.close().catch(() => {});
});
app.listen(port, host, () => {
  const mode = ownOAuth ? 'own OAuth + Clerk login' : useClerk ? 'Clerk OAuth (legacy)' : 'bearer only';
  console.error(`social-media-mcp front (read-only, ${mode}, backend ${new URL(gatewayUrl).host}) on http://${host}:${port}/mcp`);
});
