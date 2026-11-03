import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState,operate,validateState,sample,totals } from '../lib/core.js';
import { normalizeRules,prepareDraw,selectPrepared,inspectDraw } from '../lib/rules.js';
let id = 0;
const context = { uuid:() => `r-${++id}`,random:() => .5,now:() => '2026-10-18T12:00:00Z' };
const apply = (s,operation,rest={}) => operate(s,{ operation,...rest },context).state;
const roster = () => ({ ...initialState(), students:[
  ['a','甲部','部长','一班'],['b','甲部','干事','二班'],['c','乙部','部长','二班'],['d','乙部','干事','一班'],['e','乙部','干事','二班'],['f','','','']
].map(([id,department,position,group],i) => ({ id,name:id,number:id,department,position,group,initialCount:i%3,enabled:true,archived:false })) });
const event = (id,ids,undone=false,createdAt='2026-10-18T00:00:00Z') => ({ id,name:id,participants:ids.map(id => ({ id,name:id,number:id })),undone,createdAt,strength:1 });

test('specified and excluded people are disjoint, occupy seats, and survive confirmation and backup',() => {
  const s = roster(), rules = { required:['a'],excluded:['b'] };
  const drawn = apply(s,'draw',{ count:2,strength:1,rules });
  assert.ok(drawn.pending.ids.includes('a')); assert.ok(!drawn.pending.ids.includes('b'));
  assert.deepEqual(totals(s),totals(drawn));
  const confirmed = apply(drawn,'confirm',{ id:drawn.pending.id });
  assert.deepEqual(confirmed.events[0].rules,normalizeRules(rules));
  assert.deepEqual(validateState(confirmed),confirmed);
  assert.throws(() => inspectDraw(s,2,1,{ required:['a'],excluded:['a'] }),/同时被指定和排除/);
  assert.throws(() => inspectDraw(s,1,1,{ required:['a','b'] }),/超过本次/);
  s.students[0].enabled = false;
  assert.throws(() => inspectDraw(s,2,1,{ required:['a'] }),/暂停/);
  assert.throws(() => inspectDraw(s,2,1,{ required:['unknown'] }),/不存在/);
});
test('recent avoidance uses only newest confirmed non-undone activities; required does not override it',() => {
  const s = roster();
  s.events = [event('older',['a'],false,'2026-10-16T00:00:00Z'),event('undone',['c'],true),event('newer',['b'],false,'2026-10-17T00:00:00Z')];
  assert.ok(selectPrepared(inspectDraw(s,4,1,{ recent:1 })).every(s => s.id !== 'b'));
  assert.ok(selectPrepared(inspectDraw(s,4,1,{ recent:2 })).every(s => !['a','b'].includes(s.id)));
  assert.throws(() => inspectDraw(s,2,1,{ required:['b'],recent:1 }),/近期避让范围/);
  assert.throws(() => inspectDraw(s,6,1,{ recent:1 }),/只有 5/);
  s.events[2].undone = true;
  assert.ok(inspectDraw(s,2,1,{ recent:1,required:['b'] }).required.some(s => s.id === 'b'));
});
test('absence adds a bounded recency multiplier; no invented dates from initial counts',() => {
  const s = roster(); s.students.forEach(s => s.initialCount=0);
  s.events = [event('new',['a'],false,'2026-10-18T00:00:00Z'),event('old',['b'],false,'2026-10-16T00:00:00Z')];
  const p = inspectDraw(s,2,0,{ absent:true });
  assert.equal(p.weights.get('a'),1); assert.equal(p.weights.get('b'),2.5); assert.equal(p.weights.get('c'),4);
  assert.ok([...inspectDraw({ ...s,events:[] },2,0,{ absent:true }).weights.values()].every(w => w===1));
});
test('crossing department and role quotas use a feasible combination rather than a greedy dead end',() => {
  const s = roster();
  for (let i=0;i<100;i++) {
    const p = inspectDraw(s,3,2,{ required:['a'],quotaField:'department',quotas:[{ value:'甲部',count:2 },{ value:'乙部',count:1 }],positions:[{ value:'部长',count:1 },{ value:'干事',count:2 }] });
    const chosen = selectPrepared(p,() => (i%99+.5)/100);
    assert.deepEqual(new Set(chosen.map(s => s.id)),new Set(['a','b','d']));
  }
  const crossing = { quotas:[{ value:'甲部',count:2 }],positions:[{ value:'部长',count:2 }] };
  assert.throws(() => inspectDraw(s,2,1,crossing),/无法同时满足/);
  assert.throws(() => inspectDraw(s,2,1,{ quotas:[{ value:'甲部',count:3 }] }),/名额合计/);
  assert.throws(() => inspectDraw(s,2,1,{ required:['a'],quotas:[{ value:'甲部',count:0 }] }),/指定对象超出/);
});
test('class quotas, zero quotas, unspecified categories, and missing metadata have exact semantics',() => {
  const s = roster();
  assert.throws(() => inspectDraw(s,3,0,{ quotaField:'group',quotas:[{ value:'一班',count:2 }],positions:[{ value:'部长',count:0 }] }),/无法同时满足/);
  const chosen = selectPrepared(inspectDraw(s,3,0,{ quotaField:'group',quotas:[{ value:'一班',count:1 }],positions:[{ value:'部长',count:0 }] }));
  assert.equal(chosen.filter(s => s.group === '一班').length,1);
  assert.equal(chosen.filter(s => s.position === '部长').length,0);
  assert.ok(selectPrepared(inspectDraw(s,6,0,{})).some(s => !s.department));
  assert.throws(() => inspectDraw(s,2,0,{ quotas:[{ value:'不存在',count:1 }] }),/仅有 0/);
});
test('legacy settings load with rules off and removal cleans saved explicit IDs',() => {
  const s = roster(); delete s.settings.rules;
  assert.deepEqual(validateState(s).settings.rules,normalizeRules());
  const saved = apply(s,'settings',{ count:2,strength:0,rules:{ required:['a'],excluded:['b'] } });
  const removed = apply(saved,'remove',{ id:'a' });
  assert.deepEqual(removed.settings.rules.required,[]);
  assert.deepEqual(removed.settings.rules.excluded,['b']);
  assert.deepEqual(apply(removed,'restore',{ data:s }).settings.rules,normalizeRules());
});
test('malformed rules and infeasible draws leave the original state and randomness untouched',() => {
  for (const rules of [{ recent:-1 },{ recent:1.2 },{ absent:'true' },{ quotaField:'notes' },{ required:['a','a'] },{ quotas:[{ value:'甲',count:1 },{ value:'甲',count:2 }] }]) assert.throws(() => normalizeRules(rules));
  const s = roster(), copy = structuredClone(s);
  assert.throws(() => operate(s,{ operation:'draw',count:2,strength:0,rules:{ quotas:[{ value:'甲部',count:2 }],positions:[{ value:'部长',count:2 }] } },{ ...context,random:() => assert.fail('must validate first') }),/无法同时满足/);
  assert.deepEqual(s,copy);
});
test('unconstrained random costs select the same set as existing weighted sampling',() => {
  let seed = 91;
  const random = () => { seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32; };
  for (let mode=0;mode<3;mode++) for (let count=1;count<=6;count++) {
    const s = roster(), values=s.students.map(random); let i=0;
    const actual=selectPrepared(inspectDraw(s,count,mode,{}),() => values[i++]); i=0;
    const expected=sample(s.students,count,totals(s),mode,() => values[i++]);
    assert.deepEqual(new Set(actual.map(s => s.id)),new Set(expected.map(s => s.id)));
  }
});
test('crossing constraints match an exhaustive subset oracle, including reverse-edge reassignments',() => {
  let seed=7182;
  const random=() => { seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32; };
  for (let trial=0;trial<200;trial++) {
    const s=roster(),count=1+Math.floor(random()*5),a=Math.floor(random()*(count+1)),b=Math.floor(random()*(count+1));
    const rules={ quotas:[{ value:'甲部',count:a }],positions:[{ value:'部长',count:b }] };
    const options=[];
    for (let mask=1;mask<64;mask++) {
      const subset=s.students.filter((_,i) => mask&(1<<i));
      if (subset.length===count && subset.filter(s => s.department==='甲部').length===a && subset.filter(s => s.position==='部长').length===b) options.push(subset);
    }
    if (!options.length) { assert.throws(() => inspectDraw(s,count,1,rules));continue; }
    const values=s.students.map(random),p=inspectDraw(s,count,1,rules); let i=0;
    const score = chosen => chosen.reduce((sum,s) => sum-Math.log1p(-values[s.name.charCodeAt(0)-97])/p.weights.get(s.id),0);
    const actual=selectPrepared(p,() => values[i++]);
    assert.ok(Math.abs(score(actual)-Math.min(...options.map(score)))<1e-8,`trial ${trial}`);
  }
});
