// Assembles the static site Vercel serves (output: vercel-out/):
//   /            -> landing/index.html (single file, nothing to build)
//   /dashboard/  -> the Vite build of client/ (base is /dashboard/)
// VITE_API_URL (set in Vercel > Settings > Environment Variables) is read by Vite at build time
// and points the dashboard at the backend (e.g. the Render URL).
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'vercel-out');

if (!process.env.VITE_API_URL) {
  console.warn('[build-vercel] VITE_API_URL is not set: the dashboard will call /api on the Vercel origin, which has no backend. Set it to your Render URL and redeploy.');
}

const build = spawnSync('npm', ['run', 'build', '-w', 'client'], { cwd: root, stdio: 'inherit', env: process.env });
if (build.status !== 0) process.exit(build.status ?? 1);

const dist = path.join(root, 'client', 'dist');
if (!existsSync(path.join(dist, 'index.html'))) {
  console.error('[build-vercel] client/dist/index.html missing after build');
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(path.join(root, 'landing'), out, { recursive: true });
cpSync(dist, path.join(out, 'dashboard'), { recursive: true });
console.log('[build-vercel] wrote', out);
