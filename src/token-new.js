import { generateToken } from './auth.js';

const label = process.argv[2] ?? 'default';
const { token, hash } = generateToken();
console.log(`Token (give to the client, shown once): ${token}`);
console.log(`Add to .env: MCP_TOKEN_HASHES=${label}:${hash}`);
