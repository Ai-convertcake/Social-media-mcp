#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
command -v node >/dev/null || { echo 'Install Node.js 22+ first.' >&2; exit 1; }
command -v uv >/dev/null || { echo 'Install uv first: brew install uv' >&2; exit 1; }
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 14)) { console.error("Node.js 22.14+ is required."); process.exit(1); }'
npm ci
if [ ! -x .venv-google/bin/python ]; then uv venv .venv-google --python 3.12; fi
uv pip install --python .venv-google/bin/python -r requirements-google.txt
if [ ! -f .env ]; then cp .env.example .env; fi
mkdir -p .credentials
chmod 700 .credentials
chmod 600 .env
node --input-type=module <<'JS'
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
let env = await readFile('.env', 'utf8');
if (!/^MCP_SERVER_TOKEN=.+$/m.test(env)) {
  const entry = `MCP_SERVER_TOKEN=${randomBytes(32).toString('hex')}`;
  env = /^MCP_SERVER_TOKEN=.*$/m.test(env) ? env.replace(/^MCP_SERVER_TOKEN=.*$/m, entry) : `${env}\n${entry}\n`;
  await writeFile('.env', env, { mode: 0o600 });
}
JS
echo 'Dependencies ready. Set credentials and HTTP settings in .env, then run npm start.'
