import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createCatalogFilterStore } from '../src/desktop/preferences';

test('重新打开时恢复匹配模式和已选标签，连续修改以最后一次为准', async () => {
  const root = await mkdtemp(path.join(tmpdir(),'vfx-filter-'));
  const file = path.join(root,'catalog-filters.json');
  const store = createCatalogFilterStore(file);
  assert.deepEqual(await store.load(),{mode:'any',tags:[]});
  const first = store.save({mode:'any',tags:['烟尘']});
  const latest = store.save({mode:'all',tags:['火焰','高速']});
  assert.equal(store.pendingWrite(),latest);
  await Promise.all([first,latest]);
  assert.equal(store.pendingWrite(),undefined);
  const reopened = createCatalogFilterStore(file);
  assert.deepEqual(await reopened.load(),{mode:'all',tags:['火焰','高速']});
  await reopened.save({mode:'all',tags:[]});
  assert.deepEqual(await createCatalogFilterStore(file).load(),{mode:'all',tags:[]});
  assert.deepEqual(await readdir(root),['catalog-filters.json']);
});
