import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') throw new Error('Windows 安装包需要在 Windows 环境编译。');

const root = fileURLToPath(new URL('..',import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(root,'package.json'),'utf8'));
const candidates = [
  process.env.VFX_ISCC,
  ...[process.env['ProgramFiles(x86)'],process.env.ProgramFiles]
    .filter(Boolean).map(directory=>path.join(directory,'Inno Setup 6','ISCC.exe')),
];
const compiler = candidates.find(candidate=>candidate && existsSync(candidate)) ?? 'ISCC.exe';

function run(executable,args) {
  const result = spawnSync(executable,args,{cwd:root,stdio:'inherit',windowsHide:true});
  if (result.error) throw result.error;
  if (result.status!==0) process.exit(result.status??1);
}

run(process.execPath,[path.join(root,'scripts','build.mjs')]);
run(process.execPath,[path.join(root,'node_modules','electron-builder','cli.js'),'--win','--x64','--dir','--publish','never']);
run(compiler,[
  `/DReleaseVersion=${manifest.version}`,
  `/DReleaseAuthor=${manifest.author.name}`,
  `/DReleaseCopyright=${manifest.build.copyright}`,
  path.join(root,'installer','setup.iss'),
]);
