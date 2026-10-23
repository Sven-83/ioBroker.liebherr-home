/*
 * Builds the VIS-2 widget set in src-widgets/ and copies the result to widgets/liebherr-home/.
 * VIS-2 copies widgets/ of every adapter with common.visWidgets on its start (restartAdapters: vis-2).
 *
 * Usage: npm run build:widgets
 */
import { execSync } from 'node:child_process';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src-widgets');
const out = join(root, 'widgets', 'liebherr-home');

const run = cmd => execSync(cmd, { cwd: src, stdio: 'inherit' });

if (!existsSync(join(src, 'node_modules'))) {
    run('npm ci');
}
rmSync(join(src, 'build'), { recursive: true, force: true });
run('npm run build');

rmSync(join(root, 'widgets'), { recursive: true, force: true });
// index.html is only the vite entry
cpSync(join(src, 'build'), out, { recursive: true, filter: file => !file.endsWith('index.html') });
console.log(`Widgets copied to ${out}`);
