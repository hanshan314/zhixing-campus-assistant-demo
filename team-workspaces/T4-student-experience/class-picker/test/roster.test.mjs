import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRoster, parseStudents, normalizeImportedRows } from '../lib/roster.js';
import { initialState, operate, validateState, totals } from '../lib/core.js';
const screenshot = '示例甲    组织部    干事\n示例乙    组织部    成员\n示例丙    外联部    部长\n示例丁    外联部    副部长\n示例戊    外联部    干事\n示例己    秘书处    秘书长\n示例庚    秘书处    干事';
test('screenshot-style names, departments and positions need no numeric third column',() => {
  const records = parseStudents(screenshot);
  assert.equal(records.length,7);
  assert.deepEqual(records[0],{ name:'示例甲',number:'',initialCount:0,department:'组织部',position:'干事' });
  assert.equal(records[3].position,'副部长'); assert.equal(records[5].department,'秘书处');
  assert.ok(records.every(r => r.initialCount === 0));
});
test('IDs before names, mixed alphanumeric IDs, leading serial numbers and absent optional fields',() => {
  assert.deepEqual(parseStudents('S-001 示例辛\nS-002 示例壬').map(r => [r.name,r.number]),[['示例辛','S-001'],['示例壬','S-002']]);
  assert.equal(parseStudents('1 示例一 S-001')[0].number,'S-001');
  assert.equal(parseStudents('1 示例一 001\n2 示例二 002')[1].number,'002');
  assert.equal(parseStudents('示例一')[0].number,'');
  assert.equal(parseStudents('001 示例一 组织部 干事')[0].position,'干事');
});
test('arbitrary column order, headers and extra columns are preserved',() => {
  const source = '学生会名单\n职位\t学号\t姓名\t部门\t班级\t性别\t参与次数\n部长\t0001\t示例一\t外联部\t示例班级\t男\t2';
  const [row] = parseStudents(source);
  assert.deepEqual(row,{ name:'示例一',number:'0001',initialCount:2,department:'外联部',position:'部长',group:'示例班级',notes:'性别：男' });
  assert.equal(analyzeRoster(source).hasHeader,true);
  const [annotated] = parseStudents('学生姓名（必填）\t学号/工号\t职务（选填）\n示例二\tS-001\t干事');
  assert.equal(annotated.number,'S-001'); assert.equal(annotated.position,'干事');
});
test('Markdown tables, Chinese commas, list separators, UTF-8 BOM and labelled text',() => {
  assert.equal(parseStudents('| 学号 | 姓名 | 职务 |\n| --- | --- | --- |\n| 001 | 示例一 | 部长 |')[0].position,'部长');
  assert.equal(parseStudents('姓名，部门，职位\n示例二，组织部，干事')[0].department,'组织部');
  assert.equal(parseStudents('示例一、示例二、示例三').length,3);
  assert.equal(parseStudents('示例一,示例二,示例三').length,3);
  const [row] = parseStudents('姓名：示例三，学号：003，部门：外联部，职位：部长');
  assert.deepEqual(row,{ name:'示例三',number:'003',initialCount:0,department:'外联部',position:'部长' });
  assert.equal(parseStudents('姓名：示例一 学号：001 部门：组织部 职位：干事')[0].number,'001');
});
test('English full names, parenthesized posts, and combined department/job titles',() => {
  assert.equal(parseStudents('John Smith  0003  Research Department')[0].name,'John Smith');
  assert.equal(parseStudents('示例一（学习委员）')[0].position,'学习委员');
  assert.equal(parseStudents('示例二 组织部部长')[0].department,'组织部');
  assert.equal(parseStudents('示例三 学生会副主席')[0].position,'副主席');
});
test('phone numbers and unknown text are not guessed to be IDs or participation counts',() => {
  const [row] = parseStudents('示例一 13800138000 组织部');
  assert.equal(row.number,''); assert.match(row.notes,/13800138000/); assert.equal(row.initialCount,0);
  const [header] = parseStudents('姓名,年龄,学号,部门\n示例二,19,0002,宣传部');
  assert.equal(header.initialCount,0); assert.equal(header.number,'0002'); assert.match(header.notes,/年龄：19/);
  const ambiguous = analyzeRoster('没有数字姓名 001 2'); assert.ok(ambiguous.warnings.some(w => w.includes('历史次数')));
});
test('bad/missing fields are offered for correction without inventing names or counts',() => {
  const preview = analyzeRoster('学号,姓名,次数\n001,,2\n002,示例一,-1');
  assert.equal(preview.rows.length,2); assert.ok(preview.rows.every(r => !r.selected));
  assert.ok(preview.rows[0].issues.some(s => s.includes('姓名')));
  assert.ok(preview.rows[1].issues.some(s => s.includes('非负整数')));
  assert.throws(() => normalizeImportedRows([{ name:'示例一',initialCount:-1 }]),/非负整数/);
  assert.equal(parseStudents('姓名,次数\n示例三,两次')[0].initialCount,2);
});
test('metadata survives import, manual edit, activity snapshots and backup validation',() => {
  let id = 0; const context = { uuid:() => 'test-'+ ++id,random:() => .5,now:() => '2026-10-18T12:00:00.000Z' };
  const apply = (s,input) => operate(s,input,context).state;
  let state = apply(initialState('club'),{ operation:'import',source:screenshot });
  state = apply(state,{ operation:'draw',count:7,strength:1 });
  state = apply(state,{ operation:'confirm',id:state.pending.id });
  assert.equal(state.events[0].participants[0].department,'组织部');
  const student = state.students[0];
  state = apply(state,{ operation:'edit',id:student.id,name:student.name,number:'0001',initialCount:0,department:'宣传部',position:'部长',group:'2501',notes:'联络人' });
  assert.equal(state.students[0].position,'部长'); assert.equal(state.events[0].participants[0].position,'干事');
  assert.equal(validateState(state).students[0].group,'2501'); assert.equal(totals(state).get(student.id),1);
  const old = initialState(); assert.deepEqual(validateState(old),old);
});
