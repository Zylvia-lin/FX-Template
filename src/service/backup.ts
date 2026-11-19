import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { BackupResult, Settings } from '../contracts';

const stamp = (date: Date) => [
  date.getFullYear(), date.getMonth()+1, date.getDate(),
].map(value => String(value).padStart(2,'0')).join('-');

function tool(name: string) {
  const bundled = `C:\\Program Files\\PostgreSQL\\18\\bin\\${name}.exe`;
  if (process.env.VFX_PG_BIN) return path.join(process.env.VFX_PG_BIN, process.platform === 'win32' ? `${name}.exe` : name);
  return existsSync(bundled) ? bundled : name;
}

export async function runPgTool(name: string, args: string[], password?: string) {
  await new Promise<void>((resolve,reject) => {
    const processHandle = spawn(tool(name),args,{
      env:{...process.env,...(password === undefined ? {} : {PGPASSWORD:password}),PGCONNECT_TIMEOUT:'10',PGCLIENTENCODING:'UTF8'},
      windowsHide:true,stdio:['ignore','ignore','pipe'],
    });
    let stderr = '';
    processHandle.stderr?.on('data',chunk => { stderr = (stderr + chunk).slice(-2500); });
    processHandle.on('error',reject);
    processHandle.on('close',code => {
      if (code === 0) resolve();
      else reject(new Error(`${name} 退出（${code}）：${password ? stderr.replaceAll(password,'[已隐藏]') : stderr}`));
    });
  });
}

export class Backups {
  private running?: Promise<BackupResult>;
  private lastCompletedDay?: string;
  private timer?: NodeJS.Timeout;

  constructor(private settings:Settings,private libraryId:string,private log:FastifyBaseLogger) {}

  configure(settings:Settings) {
    this.stop();
    this.settings = settings;
    this.lastCompletedDay = undefined;
    this.start();
  }

  start() {
    if (!this.settings.backupDirectory || !this.settings.backupTime) return;
    const tick = () => void this.tick().catch(error => this.log.error({err:error,module:'backup'},'backup.schedule_failed'));
    this.timer = setInterval(tick,60_000);
    this.timer.unref();
    tick();
  }

  stop() { clearInterval(this.timer); this.timer = undefined; }

  async waitForCurrent() { await this.running?.catch(()=>undefined); }

  private async tick() {
    const timer = this.timer;
    const now = new Date();
    const due = new Date(now);
    const [hour,minute] = this.settings.backupTime.split(':').map(Number);
    due.setHours(hour,minute,0,0);
    if (due > now) due.setDate(due.getDate()-1);
    const day = stamp(due);
    if (this.lastCompletedDay === day || this.running) return;
    await mkdir(this.settings.backupDirectory,{recursive:true});
    if (this.timer !== timer) return;
    const entries = await readdir(this.settings.backupDirectory);
    if (this.timer !== timer || this.lastCompletedDay === day || this.running) return;
    if (!entries.some(file => file.startsWith(`vfx-${this.libraryId}-scheduled-${day}-`) && file.endsWith('.dump'))) {
      await this.create(day);
    }
    if (this.timer === timer) this.lastCompletedDay = day;
  }

  create(scheduledDay?:string) {
    if (!this.running) this.running = this.write(scheduledDay).finally(() => { this.running = undefined; });
    return this.running;
  }

  private async write(scheduledDay?:string) {
    const {backupDirectory,host,port,database,user,password,backupRetention} = this.settings;
    if (!backupDirectory) throw new Error('请先在设置里选择备份目录');
    const taskId = randomUUID();
    const log = this.log.child({module:'backup',taskId,database,trigger:scheduledDay?'scheduled':'manual'});
    const mode = scheduledDay ? `scheduled-${scheduledDay}` : 'manual';
    const prefix = `vfx-${this.libraryId}-`;
    const stem = path.join(backupDirectory,`${prefix}${mode}-${Date.now()}-${taskId}`);
    const file = stem+'.dump';
    const temporary = stem+'.partial';
    const start = performance.now();
    log.info('backup.started');
    try {
      await mkdir(backupDirectory,{recursive:true});
      await runPgTool('pg_dump',['--format=custom','--no-acl','--no-owner','--no-password','--host',host,'--port',String(port),'--username',user,'--dbname',database,'--file',temporary],password);
      await runPgTool('pg_restore',['--list',temporary]);
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(temporary)) hash.update(chunk);
      const sha256 = hash.digest('hex');
      const bytes = (await stat(temporary)).size;
      await writeFile(stem+'.sha256',sha256+'\n',{flag:'wx'});
      await rename(temporary,file);
      log.info({bytes,elapsedMs:Math.round(performance.now()-start)},'backup.completed');
      if (scheduledDay) {
        try {
          const old = (await readdir(backupDirectory)).filter(name => name.startsWith(prefix) &&
            /^scheduled-\d{4}-\d{2}-\d{2}-\d+-[a-f0-9-]+\.dump$/.test(name.slice(prefix.length))).sort().reverse().slice(backupRetention);
          for (const name of old) {
            await rm(path.join(backupDirectory,name));
            await rm(path.join(backupDirectory,name.replace(/\.dump$/,'.sha256')),{force:true});
          }
          if (old.length) log.info({count:old.length},'backup.retention_applied');
        } catch (error) { log.warn({err:error},'backup.retention_failed'); }
      }
      return {file, bytes, sha256};
    } catch (error) {
      await rm(temporary,{force:true}).catch(cleanup => log.warn({err:cleanup},'backup.cleanup_failed'));
      await rm(stem+'.sha256',{force:true}).catch(cleanup => log.warn({err:cleanup},'backup.cleanup_failed'));
      log.error({err:error,elapsedMs:Math.round(performance.now()-start)},'backup.failed');
      throw error;
    }
  }
}
