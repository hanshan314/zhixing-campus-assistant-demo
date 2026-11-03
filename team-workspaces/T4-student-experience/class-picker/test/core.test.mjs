import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, operate, totals, sample, parseStudents, validateState } from '../lib/core.js';
let sequence = 0;
const context = { uuid: () => `id-${++sequence}`, random: () => .5, now: () => '2026-10-18T12:00:00.000Z' };
const apply = (s, operation, rest = {}) => operate(s,{ operation, ...rest },context).state;
const roster = () => apply(initialState(),'import',{ source:'姓名,学号,历史次数\n示例一,01,0\n示例二,02,2\n示例三,03,1\n示例四,04,0' });
test('UTF-8 BOM, CSV quoting and Excel TSV import preserve IDs and counts',() => {
  assert.deepEqual(parseStudents('\ufeff姓名\t学号\t历史次数\r\n示例一\t001\t2'),[{ name:'示例一',number:'001',initialCount:2 }]);
  assert.equal(parseStudents('"Lin, Mei",002,3')[0].name,'Lin, Mei');
  assert.equal(parseStudents('"张""三",1,0')[0].name,'张"三');
  assert.equal(parseStudents('示例一\n示例二').length,2);
  assert.throws(() => parseStudents('示例一,1,-2'),/非负整数/);
  assert.throws(() => parseStudents('示例一,1,2.1'),/非负整数/);
  assert.throws(() => parseStudents('"示例一'),/未闭合/);
});
test('duplicates are skipped, distinct numbered students may share a name',() => {
  const s = apply(roster(),'import',{ source:'示例一,01\n示例一,05\n示例二\n钱七' });
  assert.equal(s.students.length,6);
  assert.equal(s.students.filter(x => x.name === '示例一').length,2);
});
test('a draw is unique and does not increment counts until confirmed',() => {
  const before = roster(), initial = totals(before);
  const draw = apply(before,'draw',{ count:3,strength:1,name:'志愿活动' });
  assert.equal(new Set(draw.pending.ids).size,3);
  assert.deepEqual(totals(draw),initial);
  assert.equal(before.pending,null);
  const confirmed = apply(draw,'confirm',{ id:draw.pending.id });
  for (const id of draw.pending.ids) assert.equal(totals(confirmed).get(id),initial.get(id)+1);
  assert.equal(confirmed.events.length,1);
  assert.equal(confirmed.pending,null);
  assert.throws(() => apply(confirmed,'confirm',{ id:draw.pending.id }),/已变更或已记录/);
});
test('undo reverses exactly one event while preserving imported counts',() => {
  const start = roster();
  let s = apply(start,'draw',{ count:4,strength:2,name:'运动会' });
  s = apply(s,'confirm',{ id:s.pending.id });
  s = apply(s,'draw',{ count:4,strength:2,name:'班会' });
  s = apply(s,'confirm',{ id:s.pending.id });
  const event = s.events[0];
  s = apply(s,'undo',{ id:event.id });
  for (const [id,n] of totals(start)) assert.equal(totals(s).get(id),n+1);
  assert.throws(() => apply(s,'undo',{ id:event.id }),/已撤销/);
});
test('paused and removed students are excluded; roster changes invalidate previews',() => {
  let s = roster(); const id = s.students[0].id;
  s = apply(s,'toggle',{ id });
  s = apply(s,'draw',{ count:3,strength:0 });
  assert.ok(!s.pending.ids.includes(id));
  assert.throws(() => apply(s,'draw',{ count:4,strength:0 }),/只有 3 人/);
  s = apply(s,'confirm',{ id:s.pending.id });
  const removed = s.events[0].participants[0];
  s = apply(s,'remove',{ id:removed.id });
  assert.equal(s.events[0].participants[0].name,removed.name);
  s = apply(s,'draw',{ count:2,strength:1 });
  s = apply(s,'rename',{ name:'新班级' });
  assert.equal(s.pending,null);
});
test('weighted probability agrees with the formula, and uniform mode is fair',() => {
  const students = [{ id:'a' },{ id:'b' }], map = new Map([['a',0],['b',2]]);
  let seed = 74831;
  const rng = () => { seed = (Math.imul(seed,1664525)+1013904223)>>>0; return seed/2**32; };
  for (const [strength,expected] of [[0,.5],[1,.75],[2,.9]]) {
    let a = 0;
    for (let i=0;i<40000;i++) if (sample(students,1,map,strength,rng)[0].id === 'a') a++;
    assert.ok(Math.abs(a/40000-expected)<.012,`${strength}: ${a/40000}`);
  }
  assert.equal(sample(students,2,map,2,()=>0).length,2);
  assert.throws(() => sample(students,1,map,1,()=>1),/随机数/);
});
test('backup validation rejects duplicate IDs, unknown participants, invalid counts and strategies',() => {
  const s = roster();
  assert.deepEqual(validateState(s),s);
  const duplicate = structuredClone(s); duplicate.students[1].id = duplicate.students[0].id;
  assert.throws(() => validateState(duplicate),/重复学生/);
  const bad = structuredClone(s); bad.students[0].initialCount = -1;
  assert.throws(() => validateState(bad),/历史次数/);
  assert.throws(() => apply(s,'draw',{ count:1,strength:3 }),/均衡强度/);
  const restored = apply(s,'restore',{ data:{ ...s,revision:999 } });
  assert.equal(restored.revision,s.revision+1);
});
