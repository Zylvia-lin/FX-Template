import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import type { CatalogFilters } from '../contracts';

export async function writeJson(file:string,value:unknown) {
  const temporary = file+`.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary,JSON.stringify(value,null,2),{flag:'wx',mode:0o600});
    await rename(temporary,file);
  } catch (error) {
    await rm(temporary,{force:true}).catch(()=>undefined);
    throw error;
  }
}

function validateFilters(value:unknown): CatalogFilters {
  const filters = value as Partial<CatalogFilters>|null|undefined;
  if ((filters?.mode!=='all'&&filters?.mode!=='any') || !Array.isArray(filters.tags) ||
      filters.tags.length>100 || filters.tags.some(tag=>typeof tag!=='string'||!tag.trim()||tag.length>100)) {
    throw new Error('标签筛选配置无效');
  }
  return {mode:filters.mode,tags:[...new Set(filters.tags)]};
}

export function createCatalogFilterStore(file:string) {
  let pending:Promise<void>|undefined;
  return {
    async load() {
      try {
        return validateFilters(JSON.parse(await readFile(file,'utf8')));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code==='ENOENT') return {mode:'any',tags:[]} satisfies CatalogFilters;
        throw error;
      }
    },
    save(input:CatalogFilters) {
      const filters = validateFilters(input);
      const write = (pending?.catch(()=>undefined)??Promise.resolve()).then(()=>writeJson(file,filters));
      const tracked = write.finally(()=>{if(pending===tracked) pending=undefined;});
      pending = tracked;
      return tracked;
    },
    pendingWrite:()=>pending,
  };
}
