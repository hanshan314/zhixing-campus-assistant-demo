import { MAX_IMPORT_ROWS, parseStudents, normalizeImportedRows, metadataFrom } from './roster.js';
import { normalizeRules, prepareDraw, selectPrepared } from './rules.js';
export { parseStudents } from './roster.js';
export const MAX_STUDENTS = MAX_IMPORT_ROWS;
export const MAX_EVENTS = 10000;
export const SCENARIOS = {
  teacher: { label:'老师抽班级', role:'老师', subject:'班级', unit:'个班级', numberLabel:'班级编号', defaultName:'我的任教班级', description:'从任教班级中抽取参与班级，按班级累计活动次数。', icon:'▦' },
  class: { label:'班级内抽签', role:'班级负责人', subject:'同学', unit:'人', numberLabel:'学号', defaultName:'我的班级', description:'班级活动、值日安排、课堂抽签，让每位同学都有机会。', icon:'⇄' },
  club: { label:'社团抽签', role:'社团负责人', subject:'成员', unit:'人', numberLabel:'成员编号', defaultName:'我的社团', description:'面向社团成员抽签，分别记录不同社团的参与情况。', icon:'✧' },
  union: { label:'学生会选人', role:'学生会', subject:'候选人', unit:'人', numberLabel:'人员编号', defaultName:'学生会', description:'为学生会活动抽取候选人员，兼顾每位成员的参与机会。', icon:'⚑' }
};
const text = (s, max, label) => {
  if (typeof s !== 'string' || !s.trim() || s.trim().length > max) throw new Error(`${label}应为 1–${max} 个字符`);
  return s.trim();
};
const integer = (n, min, max, label) => {
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label}应为 ${min}–${max} 的整数`);
  return n;
};
export function initialState(scenario = 'class', name) {
  if (!Object.hasOwn(SCENARIOS,scenario)) throw new Error('不支持的抽签场景');
  return { schemaVersion: 1, scenario, revision: 0, className: name || SCENARIOS[scenario].defaultName, students: [], events: [], pending: null, settings: { count: scenario === 'teacher' ? 1 : 3, strength: 1, rules:normalizeRules() } };
}
export function totals(state) {
  const result = new Map(state.students.map(s => [s.id, s.initialCount]));
  for (const event of state.events) if (!event.undone) {
    for (const s of event.participants) if (result.has(s.id)) result.set(s.id, result.get(s.id) + 1);
  }
  return result;
}
export function weight(count, strength) { return 1 / Math.pow(count + 1, strength); }
// Independent exponential races give a weighted sample without replacement.
export function sample(students, count, counts, strength, random) {
  integer(count, 1, students.length, '抽选人数');
  integer(strength, 0, 2, '均衡强度');
  return students.map((student, i) => {
    const u = random();
    if (!(u >= 0 && u < 1)) throw new Error('随机数超出范围');
    return { student, i, key: -Math.log1p(-u) / weight(counts.get(student.id) || 0, strength) };
  }).sort((a, b) => a.key - b.key || a.i - b.i).slice(0, count).map(x => x.student);
}
export function validateState(value) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.students) || !Array.isArray(value.events)) throw new Error('不是有效的班级选人备份（版本 1）');
  if (value.students.length > MAX_STUDENTS || value.events.length > MAX_EVENTS) throw new Error('数据条目超过上限');
  const ids = new Set();
  const students = value.students.map(s => {
    const id = text(s.id, 80, '学生标识');
    if (ids.has(id)) throw new Error('存在重复学生标识'); ids.add(id);
    return { id, name: text(s.name, 40, '姓名'), number: typeof s.number === 'string' ? s.number.slice(0, 40) : '', initialCount: integer(s.initialCount, 0, 1000000, '历史次数'), enabled: s.enabled !== false, archived: s.archived === true, ...metadataFrom(s) };
  });
  const eventIds = new Set();
  const events = value.events.map(e => {
    const id = text(e.id, 80, '活动标识');
    if (eventIds.has(id)) throw new Error('存在重复活动标识'); eventIds.add(id);
    if (!Array.isArray(e.participants) || !e.participants.length || e.participants.length > MAX_STUDENTS) throw new Error('活动参与人无效');
    if (!Number.isFinite(Date.parse(e.createdAt))) throw new Error('活动时间无效');
    const seen = new Set();
    const participants = e.participants.map(s => {
      if (!ids.has(s.id) || seen.has(s.id)) throw new Error('活动中有未知或重复学生'); seen.add(s.id);
      return { id: s.id, name: text(s.name, 40, '参与人姓名'), number: typeof s.number === 'string' ? s.number.slice(0, 40) : '', ...metadataFrom(s) };
    });
    return { id, name: text(e.name, 80, '活动名称'), createdAt: e.createdAt, strength: integer(e.strength, 0, 2, '均衡强度'), undone: e.undone === true, participants, ...(e.rules ? { rules:normalizeRules(e.rules) } : {}) };
  });
  let pending = null;
  if (value.pending) {
    const p = value.pending;
    if (!Array.isArray(p.ids) || !p.ids.length || p.ids.length > MAX_STUDENTS || new Set(p.ids).size !== p.ids.length || p.ids.some(id => !students.some(s => s.id === id && !s.archived && s.enabled))) throw new Error('待确认名单无效');
    pending = { id: text(p.id, 80, '抽选标识'), ids: [...p.ids], name: text(p.name, 80, '活动名称'), strength: integer(p.strength, 0, 2, '均衡强度'), ...(p.rules ? { rules:normalizeRules(p.rules) } : {}) };
  }
  const scenario = value.scenario || 'class';
  if (!Object.hasOwn(SCENARIOS,scenario)) throw new Error('抽签场景无效');
  const rules = normalizeRules(value.settings?.rules);
  if ([...rules.required,...rules.excluded].some(id => !ids.has(id))) throw new Error('规则中存在未知档案，请检查备份');
  return { schemaVersion: 1, scenario, revision: integer(value.revision, 0, Number.MAX_SAFE_INTEGER, '数据版本'), className: text(value.className, 40, '场景名称'), students, events, pending, settings: { count: integer(value.settings?.count, 1, MAX_STUDENTS, '抽选数量'), strength: integer(value.settings?.strength, 0, 2, '均衡强度'), rules } };
}
export function operate(state, input, { uuid, random, now }) {
  const s = structuredClone(state);
  const active = () => s.students.filter(x => !x.archived);
  const find = id => { const student = active().find(x => x.id === id); if (!student) throw new Error('同学不存在，请刷新'); return student; };
  let message = '已保存';
  switch (input.operation) {
    case 'rename': s.className = text(input.name, 40, '班级名称'); break;
    case 'import': {
      const imported = input.students !== undefined ? normalizeImportedRows(input.students) : parseStudents(input.source,{ scenario:s.scenario }); let added = 0, skipped = 0;
      for (const item of imported) {
        const duplicate = active().some(x => item.number && x.number ? x.number === item.number : x.name === item.name);
        if (duplicate) { skipped++; continue; }
        if (s.students.length >= MAX_STUDENTS) throw new Error(`最多保存 ${MAX_STUDENTS} 个学生档案（含已移除）`);
        s.students.push({ id: uuid(), ...item, enabled: true, archived: false }); added++;
      }
      message = `已添加 ${added} 人${skipped ? `，跳过 ${skipped} 条重复记录` : ''}`; break;
    }
    case 'edit': {
      const student = find(input.id);
      student.name = text(input.name, 40, '姓名');
      const number = typeof input.number === 'string' ? input.number.trim() : '';
      if (number.length > 40) throw new Error('学号不能超过 40 个字符');
      if (number && active().some(x => x.id !== input.id && x.number === number)) throw new Error('这个学号已存在');
      student.number = number;
      student.initialCount = integer(input.initialCount, 0, 1000000, '导入前参与次数');
      const metadata = metadataFrom(input);
      for (const field of ['department','position','group','notes']) if (Object.hasOwn(input,field)) { delete student[field]; if (metadata[field]) student[field] = metadata[field]; }
      break;
    }
    case 'toggle': { const student = find(input.id); student.enabled = !student.enabled; break; }
    case 'remove':
      find(input.id).archived = true;
      if (s.settings.rules) for (const field of ['required','excluded']) s.settings.rules[field] = s.settings.rules[field].filter(id => id !== input.id);
      message = '已移除，过往活动记录仍保留'; break;
    case 'settings':
      s.settings = { count: integer(input.count, 1, MAX_STUDENTS, '抽选人数'), strength: integer(input.strength, 0, 2, '均衡强度'), rules:normalizeRules(input.rules ?? s.settings.rules) }; break;
    case 'draw': {
      const count = integer(input.count, 1, MAX_STUDENTS, '抽选人数');
      const strength = integer(input.strength, 0, 2, '均衡强度');
      const eligible = active().filter(x => x.enabled);
      if (count > eligible.length) throw new Error(`当前只有 ${eligible.length} 人可参与抽选`);
      const plan = prepareDraw(s,count,strength,input.rules ?? s.settings.rules);
      // Check feasibility before consuming randomness or creating a pending result.
      selectPrepared(plan);
      const selected = selectPrepared(plan,random), rules = plan.rules;
      s.settings = { count, strength, rules };
      s.pending = { id: uuid(), ids: selected.map(x => x.id), name: text(input.name || '活动抽签', 80, '活动名称'), strength, rules };
      message = '抽选完成，确认参与后才会计入次数'; break;
    }
    case 'confirm': {
      if (!s.pending || s.pending.id !== input.id) throw new Error('这次抽选已变更或已记录，请刷新');
      if (s.events.length >= MAX_EVENTS) throw new Error('活动记录已达上限，请备份后新建数据');
      const p = s.pending;
      s.events.unshift({ id: uuid(), name: p.name, createdAt: now(), strength: p.strength, undone: false, ...(p.rules ? { rules:p.rules } : {}), participants: p.ids.map(id => { const x = find(id); if (!x.enabled) throw new Error('参与状态已改变，请重新抽选'); return { id: x.id, name: x.name, number: x.number, ...metadataFrom(x) }; }) });
      s.pending = null; message = '已记录活动，参与次数与权重已更新'; break;
    }
    case 'cancel': s.pending = null; break;
    case 'undo': {
      const event = s.events.find(x => x.id === input.id);
      if (!event || event.undone) throw new Error('活动不存在或已撤销');
      event.undone = true; message = '已撤销活动，对应参与次数已回退'; break;
    }
    case 'restore': {
      const restored = validateState(input.data); restored.revision = s.revision; restored.pending = null;
      if (restored.scenario !== s.scenario) throw new Error('备份场景类型不同，请先创建同类型场景再恢复');
      return { state: { ...restored, revision: s.revision + 1 }, message: '备份已恢复' };
    }
    case 'demo': {
      if (s.students.length || s.events.length) throw new Error('示例只能在空白名单中创建');
      const names = s.scenario === 'teacher' ? ['高一（1）班','高一（2）班','高一（3）班','高一（4）班','高二（1）班','高二（2）班'] : ['陈一诺','林沐阳','王子涵','李欣然','周予安','张思远','刘雨桐','赵星辰','吴语晴','徐知夏','孙嘉言','何书宁','许清和','郑以宁','程明轩','宋亦可'];
      s.className = SCENARIOS[s.scenario].defaultName + ' · 示例';
      names.forEach((name, i) => s.students.push({ id: uuid(), name, number: String(i + 1).padStart(2, '0'), initialCount: i % 4, enabled: true, archived: false }));
      message = '已创建示例数据，可在数据管理中清空'; break;
    }
    case 'reset': return { state: { ...initialState(s.scenario,s.className), revision: s.revision + 1 }, message: '已清空当前场景名单与记录' };
    default: throw new Error('不支持的操作');
  }
  if (!['draw','confirm','cancel'].includes(input.operation)) s.pending = null;
  s.revision++;
  return { state: validateState(s), message };
}
