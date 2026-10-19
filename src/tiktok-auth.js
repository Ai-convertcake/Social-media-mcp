import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TIKTOK_MCP_URL = 'https://business-api.tiktok.com/open_mcp/tt-ads-mcp-flat';
export const TIKTOK_REDIRECT_URL = 'http://127.0.0.1:8765/callback';

export async function createTikTokAuthProvider(
  redirectToAuthorization = () => { throw new Error('Run npm run tiktok:login to authorize TikTok.'); },
  credentialsFile = fileURLToPath(new URL('../.credentials/tiktok-oauth.json', import.meta.url)),
) {
  let saved = {};
  try {
    saved = JSON.parse(await readFile(credentialsFile, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let verifier;
  let discovery;
  const state = randomUUID();
  // shortcut: one local process writes credentials; add locking before sharing them across workers.
  async function persist() {
    await mkdir(dirname(credentialsFile), { recursive: true, mode: 0o700 });
    const temporary = `${credentialsFile}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(saved), { mode: 0o600, flag: 'wx' });
    await rename(temporary, credentialsFile);
  }
  return {
    redirectUrl: TIKTOK_REDIRECT_URL,
    clientMetadata: {
      client_name: 'Social Media MCP',
      redirect_uris: [TIKTOK_REDIRECT_URL],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'mcp:tt4b',
    },
    state: () => state,
    clientInformation: () => saved.client,
    saveClientInformation: async (client) => { saved.client = client; await persist(); },
    tokens: () => saved.tokens,
    saveTokens: async (tokens) => { saved.tokens = tokens; await persist(); },
    saveCodeVerifier: (value) => { verifier = value; },
    codeVerifier: () => {
      if (!verifier) throw new Error('No TikTok login in progress. Run npm run tiktok:login.');
      return verifier;
    },
    saveDiscoveryState: (value) => { discovery = value; },
    discoveryState: () => discovery,
    redirectToAuthorization,
  };
}
