import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const ACCESS_TTL = 3600;
export const REFRESH_TTL = 30 * 24 * 3600;
const CODE_TTL = 300;
const PENDING_TTL = 600;

const sha = (value) => createHash('sha256').update(value).digest('hex');
const rand = () => randomBytes(32).toString('base64url');

// Authorization codes, access and refresh tokens are stored only as SHA-256.
export function openStore(path = ':memory:', now = () => Math.floor(Date.now() / 1000)) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS client (client_id TEXT PRIMARY KEY, info TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pending (id TEXT PRIMARY KEY, client_id TEXT, params TEXT, expires INTEGER);
    CREATE TABLE IF NOT EXISTS login (state TEXT PRIMARY KEY, request_id TEXT, verifier TEXT, nonce TEXT, expires INTEGER);
    CREATE TABLE IF NOT EXISTS code (hash TEXT PRIMARY KEY, data TEXT, expires INTEGER);
    CREATE TABLE IF NOT EXISTS token (hash TEXT PRIMARY KEY, kind TEXT, client_id TEXT, subject TEXT, expires INTEGER);
  `);

  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const get = (sql, ...args) => db.prepare(sql).get(...args);

  function purge() {
    const t = now();
    for (const table of ['pending', 'login', 'code', 'token']) run(`DELETE FROM ${table} WHERE expires < ?`, t);
  }

  function issue(clientId, subject) {
    const access = `smo_${rand()}`;
    const refresh = `smr_${rand()}`;
    const insert = 'INSERT INTO token (hash, kind, client_id, subject, expires) VALUES (?, ?, ?, ?, ?)';
    run(insert, sha(access), 'access', clientId, subject, now() + ACCESS_TTL);
    run(insert, sha(refresh), 'refresh', clientId, subject, now() + REFRESH_TTL);
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL,
      refresh_token: refresh,
    };
  }

  return {
    registerClient(info) {
      const clientId = `smc_${rand()}`;
      run('INSERT INTO client VALUES (?, ?)', clientId, JSON.stringify({ ...info, client_id: clientId }));
      return { ...info, client_id: clientId };
    },

    getClient(clientId) {
      const row = get('SELECT info FROM client WHERE client_id = ?', clientId);
      return row ? JSON.parse(row.info) : null;
    },

    // Park an /authorize request while the person signs in.
    park(clientId, params) {
      purge();
      const id = rand();
      run('INSERT INTO pending VALUES (?, ?, ?, ?)', id, clientId, JSON.stringify(params), now() + PENDING_TTL);
      return id;
    },

    pending(requestId) {
      const row = get('SELECT client_id, params FROM pending WHERE id = ? AND expires >= ?', requestId, now());
      if (!row) return null;
      return { clientId: row.client_id, params: JSON.parse(row.params) };
    },

    // Login state is tied to the browser that pressed the button (nonce cookie) and used once.
    startLogin(requestId, nonce, verifier) {
      if (!this.pending(requestId)) return null;
      const state = rand();
      run('INSERT INTO login VALUES (?, ?, ?, ?, ?)', state, requestId, verifier, sha(nonce), now() + PENDING_TTL);
      return state;
    },

    takeLogin(state, nonce) {
      const row = get('SELECT request_id, verifier, nonce FROM login WHERE state = ? AND expires >= ?', state, now());
      run('DELETE FROM login WHERE state = ?', state);
      if (!row || !nonce || row.nonce !== sha(nonce)) return null;
      return { requestId: row.request_id, verifier: row.verifier };
    },

    // Returns the redirect URL carrying our code, or null if the request expired.
    mintCode(requestId, subject) {
      const pending = this.pending(requestId);
      run('DELETE FROM pending WHERE id = ?', requestId);
      if (!pending) return null;
      const { params } = pending;
      const code = rand();
      run(
        'INSERT INTO code VALUES (?, ?, ?)',
        sha(code),
        JSON.stringify({
          client_id: pending.clientId,
          redirect_uri: params.redirect_uri,
          challenge: params.code_challenge,
          subject,
        }),
        now() + CODE_TTL,
      );
      const target = new URL(params.redirect_uri);
      target.searchParams.set('code', code);
      if (params.state) target.searchParams.set('state', params.state);
      return target.toString();
    },

    // Single-use code + PKCE (S256) check. Returns tokens or { error }.
    exchangeCode({ clientId, code, redirectUri, verifier }) {
      const row = get('SELECT data, expires FROM code WHERE hash = ?', sha(code ?? ''));
      run('DELETE FROM code WHERE hash = ?', sha(code ?? ''));
      if (!row || row.expires < now()) return { error: 'invalid_grant' };
      const data = JSON.parse(row.data);
      if (data.client_id !== clientId || data.redirect_uri !== redirectUri) return { error: 'invalid_grant' };
      const challenge = createHash('sha256').update(verifier ?? '').digest('base64url');
      if (!verifier || challenge !== data.challenge) return { error: 'invalid_grant' };
      return issue(clientId, data.subject);
    },

    // Refresh tokens rotate: the presented one stops working.
    async exchangeRefresh({ clientId, refreshToken, stillAllowed }) {
      const hash = sha(refreshToken ?? '');
      const row = get(
        "SELECT client_id, subject, expires FROM token WHERE hash = ? AND kind = 'refresh'",
        hash,
      );
      run('DELETE FROM token WHERE hash = ?', hash);
      if (!row || row.expires < now() || row.client_id !== clientId) return { error: 'invalid_grant' };
      if (!(await stillAllowed(row.subject))) return { error: 'invalid_grant' };
      return issue(clientId, row.subject);
    },

    verifyAccess(token) {
      const row = get(
        "SELECT client_id, subject FROM token WHERE hash = ? AND kind = 'access' AND expires >= ?",
        sha(token ?? ''),
        now(),
      );
      return row ? { clientId: row.client_id, subject: row.subject } : null;
    },

    revoke(token) {
      run('DELETE FROM token WHERE hash = ?', sha(token ?? ''));
    },

    close() {
      db.close();
    },
  };
}
