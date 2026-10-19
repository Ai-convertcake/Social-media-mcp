import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isAllowedEmail } from './clerk-auth.js';

// Same idea as company-brain's mcp_server/oauth.py: this server is the OAuth authorization
// server for MCP clients (dynamic registration + PKCE) and delegates "who is this person"
// to Clerk through one dedicated Clerk OAuth application.

const COOKIE = 'smm_signin';
const DEFAULT_REDIRECTS =
  'https://claude.ai,https://claude.com,https://chatgpt.com,https://chat.openai.com,http://localhost,http://127.0.0.1';

const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
};

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function parseRedirects(spec) {
  return (spec || DEFAULT_REDIRECTS).split(',').map((s) => s.trim()).filter(Boolean);
}

// Exact scheme + host on the list; https only on the default port, http (local apps) any port.
// Parsed, never prefix-matched ("http://localhost:@evil.example/" must not pass).
export function redirectAllowed(uri, allowed) {
  const text = String(uri);
  if (/[\\@]/.test(text) || /[\u0000- \u007f]/.test(text)) return false;
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return false;
  }
  if (!parsed.hostname || parsed.username || parsed.password) return false;
  for (const entry of allowed) {
    const rule = new URL(entry);
    if (parsed.protocol === rule.protocol && parsed.hostname === rule.hostname) {
      return parsed.protocol === 'http:' || parsed.port === '';
    }
  }
  return false;
}

function cookieValue(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return '';
}

function pkcePair() {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export function createOAuth({
  store,
  baseUrl,
  clerk,
  userCheck,
  allowedDomain = 'convertcake.com',
  allowedRedirects = parseRedirects(process.env.MCP_ALLOWED_REDIRECTS),
  log = console.error,
}) {
  const secure = baseUrl.startsWith('https://');
  const callback = `${baseUrl}/oauth/clerk/callback`;

  const json = (res, status, body, headers = {}) =>
    res
      .writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers })
      .end(JSON.stringify(body));
  const page = (res, status, body, headers = {}) =>
    res.writeHead(status, { ...PAGE_HEADERS, ...headers }).end(
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
        `<title>Social Media MCP</title><style>body{font-family:system-ui,sans-serif;max-width:420px;margin:12vh auto;` +
        `padding:0 16px;color:#1f2937}button{padding:10px 16px;font:inherit}.muted{color:#6b7280;font-size:14px}</style>` +
        `</head><body>${body}</body></html>`,
    );
  const redirect = (res, location) => res.writeHead(302, { location, 'cache-control': 'no-store' }).end();
  const form = async (readBody) => new URLSearchParams((await readBody()).toString());

  const metadata = () => ({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    registration_endpoint: `${baseUrl}/register`,
    revocation_endpoint: `${baseUrl}/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
  });

  async function clerkIdentity(code, verifier) {
    const fetchImpl = clerk.fetch ?? fetch;
    const tokenRes = await fetchImpl(`${clerk.issuer}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: callback,
        client_id: clerk.clientId,
        client_secret: clerk.clientSecret,
      }),
    });
    if (!tokenRes.ok) throw new Error(`clerk token failed: status=${tokenRes.status}`);
    const { access_token: access } = await tokenRes.json();
    const infoRes = await fetchImpl(`${clerk.issuer}/oauth/userinfo`, {
      headers: { authorization: `Bearer ${access}` },
    });
    if (!infoRes.ok) throw new Error(`clerk userinfo failed: status=${infoRes.status}`);
    const info = await infoRes.json();
    const subject = String(info.user_id ?? info.sub ?? '');
    const email = String(info.email ?? '').trim().toLowerCase();
    if (!subject || !email || info.email_verified !== true) throw new Error('clerk account has no verified email');
    if (!isAllowedEmail(email, allowedDomain)) throw new Error('email domain not allowed');
    return { subject, email };
  }

  // Returns true when it handled the request.
  return async function handle(req, res, path, url, readBody) {
    if (
      req.method === 'GET' &&
      (path.startsWith('/.well-known/oauth-authorization-server') ||
        path.startsWith('/.well-known/openid-configuration'))
    ) {
      json(res, 200, metadata());
      return true;
    }

    if (req.method === 'POST' && path === '/register') {
      let body;
      try {
        body = JSON.parse((await readBody()).toString() || '{}');
      } catch {
        json(res, 400, { error: 'invalid_client_metadata' });
        return true;
      }
      const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
      if (uris.length === 0 || uris.some((uri) => !redirectAllowed(uri, allowedRedirects))) {
        json(res, 400, { error: 'invalid_redirect_uri', error_description: 'redirect URI not allowed' });
        return true;
      }
      const client = store.registerClient({
        redirect_uris: uris,
        client_name: String(body.client_name ?? 'MCP client').slice(0, 100),
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      });
      json(res, 201, { ...client, client_id_issued_at: Math.floor(Date.now() / 1000) });
      return true;
    }

    if (req.method === 'GET' && path === '/authorize') {
      const q = url.searchParams;
      const client = store.getClient(q.get('client_id') ?? '');
      const redirectUri = q.get('redirect_uri') ?? client?.redirect_uris?.[0];
      if (!client || !client.redirect_uris.includes(redirectUri)) {
        page(res, 400, '<h2>คำขอไม่ถูกต้อง</h2><p>ไม่รู้จักแอปหรือ redirect URI</p>');
        return true;
      }
      const fail = (error) => {
        const target = new URL(redirectUri);
        target.searchParams.set('error', error);
        if (q.get('state')) target.searchParams.set('state', q.get('state'));
        redirect(res, target.toString());
        return true;
      };
      if (q.get('response_type') !== 'code') return fail('unsupported_response_type');
      if (!q.get('code_challenge') || (q.get('code_challenge_method') ?? 'S256') !== 'S256') {
        return fail('invalid_request');
      }
      const id = store.park(client.client_id, {
        redirect_uri: redirectUri,
        state: q.get('state') ?? undefined,
        code_challenge: q.get('code_challenge'),
        resource: q.get('resource') ?? undefined,
      });
      redirect(res, `${baseUrl}/signin?request=${encodeURIComponent(id)}`);
      return true;
    }

    if (req.method === 'GET' && path === '/signin') {
      const requestId = url.searchParams.get('request') ?? '';
      const pending = store.pending(requestId);
      if (!pending) {
        page(res, 400, '<h2>ลิงก์หมดอายุ</h2><p>กลับไปกดเชื่อมต่อใหม่จากแอปที่ใช้อยู่</p>');
        return true;
      }
      const client = store.getClient(pending.clientId);
      const nonce = randomBytes(24).toString('base64url');
      const cookie = `${COOKIE}=${nonce}; Max-Age=600; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
      page(
        res,
        200,
        `<h2>Social Media MCP</h2><p><b>${escapeHtml(client?.client_name ?? pending.clientId)}</b> ` +
          `ขอเข้าถึงข้อมูลโฆษณา (อ่านอย่างเดียว) ในนามของคุณ</p>` +
          `<p class="muted">หลังอนุญาต จะส่งกลับไปที่ <b>${escapeHtml(pending.params.redirect_uri.split('?')[0])}</b> ` +
          `ถ้าไม่ใช่แอปที่คุณกดเชื่อมต่อเอง ให้ปิดหน้านี้</p>` +
          `<form method="post" action="${escapeHtml(baseUrl)}/signin/clerk">` +
          `<input type="hidden" name="request" value="${escapeHtml(requestId)}">` +
          `<input type="hidden" name="csrf" value="${escapeHtml(nonce)}">` +
          `<button type="submit">เข้าสู่ระบบด้วย Clerk</button></form>` +
          `<p class="muted">ใช้ได้เฉพาะบัญชี @${escapeHtml(allowedDomain)}</p>`,
        { 'set-cookie': cookie },
      );
      return true;
    }

    if (req.method === 'POST' && path === '/signin/clerk') {
      const body = await form(readBody);
      const nonce = cookieValue(req, COOKIE);
      const sent = body.get('csrf') ?? '';
      let state = null;
      const verified =
        nonce && sent.length === nonce.length && timingSafeEqual(Buffer.from(nonce), Buffer.from(sent));
      const { verifier, challenge } = pkcePair();
      if (verified) state = store.startLogin(body.get('request') ?? '', nonce, verifier);
      if (!state) {
        log('signin_failed via=clerk reason=no consent from this browser or expired');
        page(res, 400, '<h2>ลิงก์หมดอายุ</h2><p>กลับไปกดเชื่อมต่อใหม่จากแอปที่ใช้อยู่</p>');
        return true;
      }
      redirect(
        res,
        `${clerk.issuer}/oauth/authorize?` +
          new URLSearchParams({
            client_id: clerk.clientId,
            response_type: 'code',
            scope: clerk.scope ?? 'openid email',
            state,
            redirect_uri: callback,
            code_challenge: challenge,
            code_challenge_method: 'S256',
          }),
      );
      return true;
    }

    if (req.method === 'GET' && path === '/oauth/clerk/callback') {
      const q = url.searchParams;
      let target = null;
      if (q.get('error')) {
        log(`signin_failed via=clerk reason=clerk returned error=${String(q.get('error')).slice(0, 40)}`);
      } else {
        const login = store.takeLogin(q.get('state') ?? '', cookieValue(req, COOKIE));
        if (login) {
          try {
            const { subject, email } = await clerkIdentity(q.get('code') ?? '', login.verifier);
            target = store.mintCode(login.requestId, subject);
            log(`signin via=clerk email=${email}`);
          } catch (error) {
            log(`signin_failed via=clerk reason=${error.message}`);
          }
        } else {
          log('signin_failed via=clerk reason=state unknown, used, expired or another browser');
        }
      }
      if (!target) {
        page(
          res,
          400,
          '<h2>เข้าสู่ระบบไม่สำเร็จ</h2><p>ลิงก์ใช้ได้ครั้งเดียว กลับไปกดเชื่อมต่อใหม่จากแอปที่ใช้อยู่ ' +
            `(ใช้ได้เฉพาะบัญชี @${escapeHtml(allowedDomain)})</p>`,
        );
        return true;
      }
      redirect(res, target);
      return true;
    }

    if (req.method === 'POST' && path === '/token') {
      const body = await form(readBody);
      const clientId = body.get('client_id') ?? '';
      if (!store.getClient(clientId)) {
        json(res, 401, { error: 'invalid_client' });
        return true;
      }
      let result;
      if (body.get('grant_type') === 'authorization_code') {
        result = store.exchangeCode({
          clientId,
          code: body.get('code'),
          redirectUri: body.get('redirect_uri'),
          verifier: body.get('code_verifier'),
        });
      } else if (body.get('grant_type') === 'refresh_token') {
        result = await store.exchangeRefresh({
          clientId,
          refreshToken: body.get('refresh_token'),
          stillAllowed: async (subject) => Boolean(await userCheck(subject)),
        });
      } else {
        result = { error: 'unsupported_grant_type' };
      }
      json(res, result.error ? 400 : 200, result);
      return true;
    }

    if (req.method === 'POST' && path === '/revoke') {
      store.revoke((await form(readBody)).get('token'));
      json(res, 200, {});
      return true;
    }

    return false;
  };
}
