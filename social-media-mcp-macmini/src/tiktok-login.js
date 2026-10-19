import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { auth } from '@modelcontextprotocol/client';
import { createTikTokAuthProvider, TIKTOK_MCP_URL, TIKTOK_REDIRECT_URL } from './tiktok-auth.js';

export function readTikTokCallback(url, expectedState) {
  if (url.pathname !== '/callback') throw new Error('Unexpected callback path.');
  if (url.searchParams.get('state') !== expectedState) throw new Error('Invalid OAuth state.');
  if (url.searchParams.has('error')) throw new Error('TikTok authorization was denied.');
  const code = url.searchParams.get('code');
  if (!code) throw new Error('Missing OAuth code.');
  return { authorizationCode: code, iss: url.searchParams.get('iss') ?? undefined };
}

export async function loginTikTok() {
  const provider = await createTikTokAuthProvider((url) => console.log(`Authorize TikTok in your browser:\n${url}`));
  let resolveCallback;
  const callback = new Promise((resolve) => { resolveCallback = resolve; });
  const server = createServer((req, res) => {
    try {
      if (req.method !== 'GET') throw new Error('Expected GET.');
      const result = readTikTokCallback(new URL(req.url, TIKTOK_REDIRECT_URL), provider.state());
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('TikTok authorization received. Check the terminal for completion. You can close this tab.');
      resolveCallback(result);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      res.end('Invalid authorization callback.');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(8765, '127.0.0.1', resolve);
  });
  let timer;
  try {
    const outcome = await auth(provider, { serverUrl: TIKTOK_MCP_URL, scope: 'mcp:tt4b', forceReauthorization: true });
    if (outcome === 'REDIRECT') {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('TikTok login timed out. Run npm run tiktok:login again.')), 10 * 60 * 1000);
      });
      const response = await Promise.race([callback, timeout]);
      if (await auth(provider, { serverUrl: TIKTOK_MCP_URL, ...response }) !== 'AUTHORIZED') {
        throw new Error('TikTok login did not complete.');
      }
    }
    console.log('TikTok authorized. Credentials saved locally. Run npm run tiktok:tools.');
  } finally {
    clearTimeout(timer);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await loginTikTok();
  } catch {
    console.error('TikTok login failed. Check authorization and network access, then run npm run tiktok:login again.');
    process.exitCode = 1;
  }
}
