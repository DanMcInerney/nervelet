import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { setTimeout } from 'node:timers/promises';
export const delay=setTimeout;
export async function temp(t:TestContext):Promise<string> {
  const parent=await realpath(tmpdir());
  const directory=await mkdtemp(join(parent,'nervelet-test-'));
  t.after(async()=>{
    const actual=await realpath(directory);const child=relative(parent,actual);
    assert.ok(!isAbsolute(child)&&!child.startsWith('..')&&child.startsWith('nervelet-test-'));
    await rm(actual,{recursive:true,force:true});
  });return directory;
}
