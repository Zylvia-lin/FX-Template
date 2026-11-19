import { mkdir, readFile } from 'node:fs/promises';
import { build as bundle } from 'esbuild';
import { build as vite } from 'vite';

const {version,author,build} = JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
await mkdir('dist/ui', { recursive: true });
await vite({
  root: 'src/ui',
  base: './',
  define: {__APP_RELEASE__:JSON.stringify({version,author:author.name,copyright:build.copyright})},
  build: { outDir: '../../dist/ui', emptyOutDir: true },
});
await Promise.all([
  bundle({ entryPoints: ['src/desktop/main.ts'], bundle: true, packages: 'external', platform: 'node', format: 'esm', outfile: 'dist/main.js', sourcemap: true }),
  bundle({ entryPoints: ['src/desktop/preload.ts'], bundle: true, external: ['electron'], platform: 'node', format: 'cjs', outfile: 'dist/preload.cjs', sourcemap: true }),
]);
