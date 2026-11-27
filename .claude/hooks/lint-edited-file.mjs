// PostToolUse hook (Edit|Write): lint the file the agent just changed.
// Exit 2 sends the problems back to the agent; exit 0 stays silent.
import { ESLint } from 'eslint';
import path from 'node:path';

const input = JSON.parse(await new Promise((resolve) => {
  let s = '';
  process.stdin.on('data', (d) => (s += d)).on('end', () => resolve(s || '{}'));
}));
const file = input.tool_input?.file_path ?? input.tool_response?.filePath;
const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
if (!file || !/\.(ts|tsx|js|mjs)$/.test(file)) process.exit(0);
const rel = path.relative(root, path.resolve(root, file));
if (rel.startsWith('..') || path.isAbsolute(rel)) process.exit(0);

const eslint = new ESLint({ cwd: root });
if (await eslint.isPathIgnored(file)) process.exit(0);
const results = await eslint.lintFiles([file]);
const errors = results.reduce((n, r) => n + r.errorCount, 0);
if (errors === 0) process.exit(0);
const text = (await eslint.loadFormatter('stylish')).format(results);
process.stderr.write(`ESLint found ${errors} error(s) in ${rel}. Fix them:\n${text}`);
process.exit(2);
