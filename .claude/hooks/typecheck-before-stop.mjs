// Stop hook: if TypeScript files have uncommitted changes, run the typecheck before the
// agent may finish. Exit 2 makes the agent keep going and fix the errors.
import { execSync, spawnSync } from 'node:child_process';

const input = JSON.parse(await new Promise((resolve) => {
  let s = '';
  process.stdin.on('data', (d) => (s += d)).on('end', () => resolve(s || '{}'));
}));
// Already continuing because of this hook: don't loop forever.
if (input.stop_hook_active) process.exit(0);

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
let changed = '';
try { changed = execSync('git status --porcelain', { cwd: root, encoding: 'utf8' }); } catch { process.exit(0); }
if (!/\.(ts|tsx)$/m.test(changed)) process.exit(0);

const r = spawnSync('npm run typecheck', { cwd: root, encoding: 'utf8', shell: true });
if (r.status === 0) process.exit(0);
const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.split('\n').filter((l) => /error TS/.test(l)).slice(0, 40).join('\n');
process.stderr.write(`npm run typecheck failed. Fix these before finishing:\n${out || r.stdout}`);
process.exit(2);
