import { readFile, mkdir, writeFile, rename, copyFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID, randomInt } from 'node:crypto';
import { initialState, validateState, operate } from './core.js';

export async function createStore(file) {
  let state;
  try { state = validateState(JSON.parse(await readFile(file, 'utf8'))); }
  catch (e) { if (e.code === 'ENOENT') state = initialState(); else throw new Error(`班级数据读取失败，原文件已保留：${e.message}`); }
  let queue = Promise.resolve();
  return {
    snapshot() { return structuredClone(state); },
    change(input) {
      const run = queue.then(async () => {
        if (input.revision !== state.revision) { const e = new Error('数据已在其他窗口更新，已刷新，请重试'); e.status = 409; throw e; }
        const result = operate(state, input, { uuid: randomUUID, random: () => randomInt(0, 2 ** 48 - 1) / (2 ** 48 - 1), now: () => new Date().toISOString() });
        await mkdir(dirname(file), { recursive: true });
        const temp = `${file}.${randomUUID()}.tmp`;
        await writeFile(temp, JSON.stringify(result.state, null, 2), { mode: 0o600 });
        try { await copyFile(file, `${file}.backup`); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        await rename(temp, file);
        state = result.state;
        return { state: structuredClone(state), message: result.message };
      });
      queue = run.catch(() => {});
      return run;
    }
  };
}
