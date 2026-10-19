# Social Media MCP

Connect to official advertising MCP servers from code, then expose a single MCP server to internal AI clients.

```text
Claude.ai / Claude Code / Cursor
      |  HTTPS
Tailscale Funnel :8443 (company-brain-mcp-ts)
      |  http://social-media-mcp:8780
Our MCP server (Node, service social-media-mcp)  -- read-only, Bearer or Clerk OAuth
      |
Official Meta / Google / TikTok MCP servers   (X: not built yet)
```

## Wrapper MCP server (read-only)

`src/server.js` serves one Streamable HTTP MCP endpoint at `/mcp` and proxies the official servers' tools as `meta_*`, `google_*` and `tiktok_*`.

**Read-only by construction.** A tool is exposed and callable only if it is listed in `src/readonly-tools.json` and its upstream annotation does not say `readOnlyHint: false`. Everything else answers `Unknown or non-read-only tool`. Regenerate/review the list when upstream tool sets change; excluded on purpose: Meta `ads_log_ui_interaction`, TikTok `*_run`, `review_smart_plus_campaign`, `tiktok_ads_diagnosis_agent`.

**Auth** (either works on `/mcp`):

- Static bearer token: `npm run token:new <label>`, put the printed `MCP_TOKEN_HASHES=` line in `.env`, give the token to the client privately. Only sha256 hashes are stored.
- Own OAuth server + Clerk sign-in (claude.ai, ChatGPT, any MCP client), the same design as company-brain's `mcp_server/oauth.py`: this server serves `/.well-known/oauth-authorization-server`, `/register` (dynamic client registration, redirect URIs limited to `MCP_ALLOWED_REDIRECTS`), `/authorize`, `/token` (PKCE S256, rotating refresh tokens), `/revoke`. People prove who they are by signing in to Clerk through one dedicated *confidential* Clerk OAuth application (`MCP_CLERK_CLIENT_ID` / `MCP_CLERK_CLIENT_SECRET`, redirect URI `${PUBLIC_BASE_URL}/oauth/clerk/callback`, scopes `openid email`). The verified primary email must be on `CLERK_ALLOWED_EMAIL_DOMAIN` (default `convertcake.com`, exact match); the Clerk user is re-checked through the Backend API (cached 5 minutes) on every use and on refresh, so removing someone in Clerk ends their sessions. Codes and tokens are stored only as SHA-256 in SQLite (`MCP_OAUTH_DB`, `/data/oauth.db` in the container, volume `oauth-data`). Without the two `MCP_CLERK_CLIENT_*` variables the server falls back to accepting Clerk-issued OAuth tokens directly (requires Dynamic Client Registration enabled in Clerk).

Run locally:

```sh
npm start        # http://127.0.0.1:8780/mcp  (HOST / PORT override)
claude mcp add --transport http social-media http://127.0.0.1:8780/mcp --header "Authorization: Bearer <token>"
```

### Deploy with Docker + company-brain's Tailscale Funnel

The container `social-media-mcp` joins the `company-brain_default` Docker network and is published by company-brain's existing Funnel node on **port 8443**: `https://company-brain-mcp.<tailnet>.ts.net:8443/mcp`. company-brain's `mcp_server/tailscale-serve.json` must contain a `:8443` entry proxying to `http://social-media-mcp:8780` (and `AllowFunnel` for it); its `mcp-ts` container must be recreated after changing that file. The service name `social-media-mcp` is deliberate: company-brain's own `mcp` service already owns the `mcp` alias on that network.

1. Fill `.env` (see `.env.example`): platform credentials, auth settings, `PUBLIC_BASE_URL=https://company-brain-mcp.<tailnet>.ts.net:8443`.
2. Keep platform credential files in `.credentials/` (mounted into the container; the TikTok login file is refreshed there, so the mount is writable). Run `npm run tiktok:login` on the host first.
3. `docker compose up -d --build` (company-brain must be running: its network is external).

Health check: `GET /healthz`. The image installs the Google MCP server from `requirements-google.txt` into its own venv.

## Meta MCP client

`src/meta.js` connects directly to Meta's official MCP endpoint at `https://mcp.facebook.com/ads` using the official MCP client SDK. It returns the SDK client, so the future wrapper can discover and call Meta tools without implementing individual Ads API endpoints.

The clients run from our code. This project does not configure direct platform connections in Codex or Claude. The wrapper server and X client have not been built yet.

### Setup

Requires Node.js 22 or newer.

```sh
npm ci
cp .env.example .env
```

Set `META_ACCESS_TOKEN` in `.env` locally. Never send it in chat or commit it. `.env` is ignored by Git.

According to [Meta's setup guide](https://developers.facebook.com/documentation/ads-commerce/ads-ai-connectors/ads-mcp-server/ads-mcp-server-get-started):

1. Create or reuse a [Meta developer app](https://developers.facebook.com/apps) and add **Create & manage ads with ads MCP server**.
2. Generate a user access token through [Graph API Explorer](https://developers.facebook.com/tools/explorer/) or your OAuth flow. For the initial read test, grant `ads_mcp_management` and `ads_read`.
3. Alternatively, use an Employee-role system user token with those permissions and access to the intended assets. Meta does not support Admin-role system user tokens for this MCP server.

Check tool discovery from code:

```sh
npm run meta:tools
```

This initializes an authenticated MCP session and prints the available tool schemas. It does not call advertising tools or change campaigns.

### Use from the future wrapper

```js
import { connectMetaAds } from './src/meta.js';

const meta = await connectMetaAds(); // reads META_ACCESS_TOKEN
try {
  const { tools } = await meta.listTools();
  // Use the actual name and arguments from the discovered tool schema:
  // const result = await meta.callTool({ name: toolName, arguments: toolArguments });
} finally {
  await meta.close();
}
```

The SDK handles protocol negotiation, SSE responses, and pagination of `listTools()`.

## Google Ads MCP client

`src/google.js` launches Google's official Python MCP server locally and connects over stdio. It returns the same MCP SDK client interface as the Meta connector. The Google server source revision is pinned in `requirements-google.txt`.

Install the Google server into a separate environment with [uv](https://docs.astral.sh/uv/):

```sh
uv venv .venv-google --python 3.12
uv pip install --python .venv-google/bin/python -r requirements-google.txt
npm run google:tools
```

The server uses Google Application Default Credentials (ADC). It uses the existing default credentials unless you set `GOOGLE_APPLICATION_CREDENTIALS` in `.env` to a credentials JSON file. Store project credentials under `.credentials/`, which is ignored by Git. Set `GOOGLE_PROJECT_ID` per Google's setup guide, and configure the ADC quota project to match your intended API project. `GOOGLE_ADS_LOGIN_CUSTOMER_ID` is optional for manager-account access.

The Google Ads API requires the `https://www.googleapis.com/auth/adwords` OAuth scope and appropriate API access for the Google Cloud project. Having credentials for other Google Cloud services does not establish Google Ads access. Follow [Google's setup guide](https://developers.google.com/google-ads/api/docs/developer-toolkit/mcp-server) and the [official server README](https://github.com/googleads/google-ads-mcp) for ADC authentication with your OAuth client JSON.

The current local configuration uses project `xenon-computer-455403-h2` and a service-account key under `.credentials/`. The Google client reads this path from `.env`; global gcloud login settings are not changed. Google authentication requests the Ads scope automatically for service-account credentials. This mode does not require a human OAuth login. The service account itself must have access to the Google Ads account or manager account. See [Google's service-account guide](https://developers.google.com/google-ads/api/docs/oauth/service-accounts).

Live account listing has succeeded using `google-ads-mcp@xenon-computer-455403-h2.iam.gserviceaccount.com`. The official `customers_list_accessible_customers` tool returns directly accessible accounts, which does not enumerate manager-account descendants. Querying `customer_client` through `search_search` confirmed the directly accessible customer is Convert Cake MCC and enumerated its descendants at all levels. The local inventory is in `output/google-accounts.md`. Google Ads access must be granted to the service account itself; access granted to a different personal email does not carry over.

For user credentials instead, a project-local OAuth setup that preserves existing global ADC credentials is:

1. In the chosen Google Cloud project, enable Google Ads API and configure its API access level.
2. Configure the OAuth consent screen with the Google Ads scope above, add your Google account as a test user if applicable, and create a Desktop app OAuth client.
3. Save its downloaded client JSON as `.credentials/google-oauth-client.json` locally. Do not paste it in chat.
4. Run:

```sh
CLOUDSDK_CONFIG="$PWD/.credentials/gcloud" gcloud auth application-default login \
  --client-id-file="$PWD/.credentials/google-oauth-client.json" \
  --scopes=https://www.googleapis.com/auth/adwords,https://www.googleapis.com/auth/cloud-platform
```

5. Set `GOOGLE_APPLICATION_CREDENTIALS=.credentials/gcloud/application_default_credentials.json` and `GOOGLE_PROJECT_ID` in `.env`. Set the quota project for these local ADC credentials using `gcloud auth application-default set-quota-project YOUR_PROJECT_ID` with the same `CLOUDSDK_CONFIG` value.
6. Run `npm run google:tools`, then call `customers_list_accessible_customers` using the example below. Discovering tools alone does not verify Google Ads account access.

```js
import { connectGoogleAds } from './src/google.js';

const google = await connectGoogleAds();
try {
  const result = await google.callTool({
    name: 'customers_list_accessible_customers',
    arguments: {},
  });
  if (result.isError) throw new Error('Google could not list accessible customers.');
  console.log(result);
} finally {
  await google.close();
}
```

The default tool names from the pinned server are `customers_list_accessible_customers`, `metadata_get_resource_metadata`, and `search_search`. Only Google-specific credential settings are forwarded to its process; Meta tokens and unrelated OAuth settings are not inherited.

## TikTok Ads MCP client

`src/tiktok.js` connects to TikTok's official MCP endpoint at `https://business-api.tiktok.com/open_mcp/tt-ads-mcp-flat` and returns the same SDK client interface as Meta and Google. The flat endpoint exposes the full tool library for discovery from code.

TikTok MCP uses its own OAuth authorization-code flow with PKCE and scope `mcp:tt4b`. A normal TikTok Marketing API token is not the credential used by this connector. No developer app ID or secret needs to be entered: the SDK discovers TikTok's OAuth settings and registers this local client.

```sh
npm run tiktok:login
```

Open the printed TikTok authorization URL, sign in, and review the account access requested by TikTok. The login command receives the callback at `http://127.0.0.1:8765/callback`; keep it running until authorization completes. It times out after ten minutes. Run the command again to change the authorization or reconnect after refresh access expires.

Client registration and access/refresh tokens are saved in `.credentials/tiktok-oauth.json`, which is ignored by Git. The credential file is written with owner-only permissions. Do not share this file or paste its contents into chat. PKCE verifier and OAuth state remain in memory during login. The SDK handles token refresh when TikTok rejects an expired access token; refresh still depends on TikTok's authorization remaining valid. This initial connector assumes one local process manages these credentials at a time.

Then discover tools:

```sh
npm run tiktok:tools
```

This prints tool schemas without changing ads. Use the names and argument schemas actually returned by TikTok when calling tools:

```js
import { connectTikTokAds } from './src/tiktok.js';

const tiktok = await connectTikTokAds();
try {
  const { tools } = await tiktok.listTools();
  // const result = await tiktok.callTool({ name: toolName, arguments: toolArguments });
} finally {
  await tiktok.close();
}
```

Live OAuth login, authenticated discovery of 382 tools, and advertiser-account listing through `auth_advertiser_get` have been verified. The account inventory is saved in `output/tiktok-accounts.md`. TikTok authorization may allow write tools as well as reads; this connector does not restrict the SDK's tool calls to reads. Campaign queries and writes have not been tested.

Sources: [TikTok MCP overview](https://ads.tiktok.com/resources/help/article/about-tiktok-for-business-mcp-server?lang=en-GB), [MCP token exchange](https://business-api.tiktok.com/portal/docs/exchange-an-mcp-authorization-code-for-tokens/v1.3).

## Validation and limits

```sh
npm test
```

Meta tests exercise credentials, the SDK handshake, SSE tool discovery with pagination, tool calls, and authentication rejection against mocked HTTP responses. Meta tool names in tests are fixtures. The Google integration test launches the installed official server and validates tool discovery without calling the Google Ads API; it is skipped if `.venv-google` is not installed.

TikTok tests cover credential persistence and file permissions, OAuth callback validation, the SDK handshake, tool discovery/calls, and authentication rejection. Tool names in TikTok tests are fixtures, not claims about the live server.

Meta authenticated tool discovery and ad-account listing have been verified. This initial Meta client uses a supplied token; automatic OAuth login and token refresh are not implemented. Token permissions determine which tools can execute, including writes if write permissions are granted. Google tool discovery, authenticated account listing, resource metadata, and manager-account descendant discovery through the official MCP server have also succeeded using the configured service account. Google campaign queries have not been tested yet.

Sources: [Meta Ads MCP setup](https://developers.facebook.com/documentation/ads-commerce/ads-ai-connectors/ads-mcp-server/ads-mcp-server-get-started), [official MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk).
