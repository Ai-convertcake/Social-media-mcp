import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('This service installer requires macOS.');
const root = fileURLToPath(new URL('../', import.meta.url));
const label = 'com.convertcake.social-media-mcp';
const directory = join(homedir(), 'Library', 'LaunchAgents');
const plist = join(directory, `${label}.plist`);
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
await mkdir(directory, { recursive: true });
await mkdir(join(root, 'logs'), { recursive: true });
await writeFile(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(join(root, 'src/server.js'))}</string></array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>30</integer>
<key>StandardOutPath</key><string>${xml(join(root, 'logs/server.out.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(root, 'logs/server.err.log'))}</string>
</dict></plist>
`, { mode: 0o600 });
execFileSync('plutil', ['-lint', plist], { stdio: 'inherit' });
const domain = `gui/${process.getuid()}`;
try { execFileSync('launchctl', ['bootout', `${domain}/${label}`], { stdio: 'ignore' }); } catch {}
execFileSync('launchctl', ['bootstrap', domain, plist], { stdio: 'inherit' });
console.log(`Installed ${label}. Check ${join(root, 'logs/server.err.log')} for startup status.`);
