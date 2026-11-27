// Prepares a fresh git worktree: installs dependencies and copies the gitignored test
// fixtures (game Docs files and saves) from the main checkout, so fixture tests run there too.
// Safe to run in the main checkout: it only installs, and never overwrites existing fixtures.
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const here = resolve(process.cwd());
execSync('npm ci', { stdio: 'inherit' });

// The first entry of `git worktree list` is always the main checkout.
const main = execSync('git worktree list --porcelain', { encoding: 'utf8' })
  .split(/\r?\n/).find((l) => l.startsWith('worktree '))?.slice('worktree '.length);
if (!main || resolve(main) === here) process.exit(0);

const from = join(main, 'fixtures');
const to = join(here, 'fixtures');
if (!existsSync(from)) process.exit(0);
mkdirSync(to, { recursive: true });
let copied = 0;
for (const name of readdirSync(from)) {
  if (name === 'README.md' || existsSync(join(to, name))) continue;
  copyFileSync(join(from, name), join(to, name));
  copied++;
}
console.log(`Copied ${copied} fixture file(s) from ${from}`);
