import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { FastifyBaseLogger } from 'fastify';
import { Backups } from '../src/service/backup';

test('手动备份结束后，下一次调度仍会执行到期的定时备份', async t => {
  const directory = await mkdtemp(path.join(tmpdir(),'vfx-backup-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const backups = new Backups({
    root:directory,host:'localhost',port:5432,database:'test',user:'test',password:'',
    backupDirectory:directory,backupTime:'00:00',backupRetention:2,
  },'test',{} as FastifyBaseLogger);
  const triggers: Array<string | undefined> = [];
  let finishManual!: () => void;
  const manualTask = new Promise<void>(resolve=>{finishManual=resolve;});
  Object.assign(backups,{async write(day?:string) {
    triggers.push(day);
    if (!day) await manualTask;
    return {file:'fixture.dump',bytes:1,sha256:'fixture'};
  }});
  const manual = backups.create();
  await backups['tick']();
  assert.deepEqual(triggers,[undefined]);
  finishManual();
  await manual;
  await Promise.all([backups['tick'](),backups['tick']()]);
  assert.equal(triggers.length,2);
  assert.match(triggers[1] ?? '',/^\d{4}-\d{2}-\d{2}$/);
});
