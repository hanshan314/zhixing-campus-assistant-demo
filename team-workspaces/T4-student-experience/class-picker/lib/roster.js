export const MAX_IMPORT_ROWS = 2000;
export const EXTRA_FIELDS = { department:80, position:80, group:80, notes:240 };
const aliases = {
  name:['姓名','名字','名称','学生姓名','成员姓名','人员姓名','候选人','同学','中文姓名','name','fullname','studentname','membername'],
  number:['学号','学生学号','学籍号','工号','编号','成员编号','人员编号','班级编号','成员号','studentid','studentno','id','no','number','studentnumber'],
  department:['部门','所属部门','组织部门','所在部门','社团','所属社团','组织','department','dept'],
  position:['职位','职务','岗位','任职','担任职务','职称','role','position','title'],
  group:['班级','班级名称','所属班级','所在班级','班级/分组','班级分组','分组','小组','组别','class','group'],
  initialCount:['导入前参与次数','导入前次数','历史次数','参与次数','参加次数','累计参与次数','活动次数','次数','initialcount','count'],
  ignore:['序号','序','行号','序列','index','row'],
  notes:['备注','说明','其他','notes','note','remark']
};
const labels = Object.values(aliases).flat().sort((a,b) => b.length-a.length);
const labelPattern = labels.map(s => s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|');
const normalize = s => String(s ?? '').normalize('NFKC').trim();
const compact = s => normalize(s).toLowerCase().replace(/[\s_\-:：()（）\[\]【】]/g,'');
const clean = s => String(s ?? '').replace(/[\u00a0\u3000]/g,' ').replace(/\s+/g,' ').trim();
function headerField(value,scenario) {
  const key = compact(String(value ?? '').replace(/[（(](?:必填|选填|可选|次)[)）]/g,''));
  if (/^(?:学号|工号|编号)(?:[/／或](?:学号|工号|编号))+$/.test(key)) return 'number';
  if (scenario === 'teacher' && /^(班级|班级名称|任教班级)$/.test(key)) return 'name';
  for (const [field,names] of Object.entries(aliases)) if (names.includes(key)) return field;
  return null;
}
function splitDelimited(input,delimiter) {
  const result = []; let cells = [], value = '', quoted = false, line = 1, rowLine = 1;
  for (let i=0;i<input.length;i++) {
    const c = input[i];
    if (c === '"') {
      if (quoted && input[i+1] === '"') { value += '"'; i++; }
      else if (quoted || !value.trim()) quoted = !quoted;
      else value += c;
    } else if (!quoted && (c === delimiter || c === '\r' || c === '\n')) {
      cells.push(clean(value)); value = '';
      if (c !== delimiter) { if (cells.some(Boolean)) result.push({ cells,line:rowLine }); cells = []; if (c === '\r' && input[i+1] === '\n') i++; line++; rowLine = line; }
    } else { value += c; if (c === '\n') line++; }
  }
  if (quoted) throw new Error('名单中存在未闭合的引号，请检查粘贴内容');
  cells.push(clean(value)); if (cells.some(Boolean)) result.push({ cells,line:rowLine });
  return result;
}
const isDepartment = value => /(?:部|处|中心|办公室|委员会|协会|社团|学院|团委|团总支|学生会|理事会|department|dept\.?|office)$/iu.test(value);
const isPosition = value => /^(?:正|副|执行|常务|荣誉)?(?:主席|会长|社长|部长|干事|成员|秘书长|秘书|负责人|理事|委员|班长|团支书|书记|组长|队长|经理|助理|主任|辅导员|老师|教师|导师|联络员|志愿者|骨干|部员|部长助理|会长助理|(?:宣传|组织|学习|生活|文体|纪律|体育|文艺|心理|劳动|安全|卫生)委员|member|president|vice president|secretary|director|manager|leader|assistant|chairperson|chair)$/iu.test(value);
const isGroup = value => /(?:班|小组|年级)$/u.test(value) || /^[\p{Script=Han}]{2,12}\d{3,6}$/u.test(normalize(value));
const isPhone = value => /^1[3-9]\d{9}$/.test(normalize(value));
const isNumber = value => /^(?:\d{1,40}|[a-z]{1,10}[-_]?[\d][a-z\d_-]{0,35}|\d+[a-z][a-z\d_-]*|\d{2,}[-_]\d+)$/i.test(normalize(value).replace(/^['’]/,'')) && !isPhone(value);
function isName(value,scenario) {
  const v = clean(value);
  if (!v || headerField(v,scenario) || isDepartment(v) || isPosition(v)) return false;
  if (scenario === 'teacher' && isGroup(v)) return true;
  if (isGroup(v) || /(?:名单|名册|花名册|通讯录|联系电话|统计表|人员表|备选人员|学生信息|共\d+人|总计)$/u.test(v)) return false;
  if (/^[零一二两三四五六七八九十百\d]+次$/u.test(v)) return false;
  return /^[\p{Script=Han}·•"'’]{2,12}$/u.test(v) || /^[a-z][a-z .,'’\-]{1,39}$/i.test(v);
}
function labelled(raw,scenario) {
  const expression = new RegExp(`(${labelPattern})\\s*[:：=]\\s*([\\s\\S]*?)(?=(?:[，,;；|\\t]\\s*)?(?:${labelPattern})\\s*[:：=]|[，,;；|\\t]|$)`,'giu');
  const fields = {}, pieces = []; let end = 0, match;
  while ((match = expression.exec(raw))) {
    pieces.push(raw.slice(end,match.index)); end = expression.lastIndex;
    const field = headerField(match[1],scenario), value = clean(match[2]);
    if (field && field !== 'ignore' && value) fields[field] = fields[field] ? fields[field]+' / '+value : value;
  }
  pieces.push(raw.slice(end));
  return { fields,rest:pieces.join(' ').replace(/^[,，;；|\s]+|[,，;；|\s]+$/g,'') };
}
function readRows(input,scenario) {
  const lines = input.split(/\r?\n/);
  const first = lines.filter(s => s.trim()).slice(0,10);
  const keyed = new RegExp(`(?:${labelPattern})\\s*[:：=]`,'iu');
  let delimiter = first.some(s => s.includes('\t')) ? '\t' : first.some(s => /^\s*\|.*\|\s*$/.test(s)) ? '|' : first.some(s => s.includes(',') && !keyed.test(s)) ? ',' : first.some(s => s.includes('，') && !keyed.test(s)) ? '，' : null;
  if (!delimiter && first.some(s => s.includes(';') && s.split(';').filter(c => headerField(c,scenario)).length >= 2)) delimiter = ';';
  if (!delimiter && first.some(s => /^\s*"/.test(s))) delimiter = ',';
  const hasHeading = delimiter && first.some(s => s.split(delimiter).some(cell => headerField(cell,scenario) === 'name'));
  let rows = delimiter ? splitDelimited(input,delimiter) : lines.map((raw,i) => ({ cells:[raw],line:i+1 }));
  rows = rows.flatMap(row => {
    const raw = row.cells.join(delimiter || ' ');
    if (!raw.trim() || /^[\s|:—\-]+$/.test(raw)) return [];
    if (delimiter === '|') { if (!row.cells[0]) row.cells.shift(); if (!row.cells.at(-1)) row.cells.pop(); }
    const named = labelled(raw,scenario);
    if (Object.keys(named.fields).length) return [{ ...row,raw,labelled:named }];
    let cells = row.cells;
    if (!delimiter) {
      const bare = raw.replace(/^\s*(?:[-*•●]\s+|\d{1,4}[.)、．]\s*|[（(]\d{1,4}[)）]\s*)/,'').trim().replace(/[（(]([^()（）]+)[)）]/g,(whole,inside) => isPosition(inside) || isDepartment(inside) ? ' '+inside+' ' : whole);
      if (bare.includes('、') || bare.includes('；')) {
        const parts = bare.split(/[、；]/).map(clean).filter(Boolean);
        if (parts.every(s => isName(s,scenario))) return parts.map(value => ({ line:row.line,cells:[value],raw:value }));
      }
      // Multiple spaces/tabs delimit columns; retain spaces inside an English full name.
      cells = bare.split(/\s{2,}|\t|[|]/).map(clean).filter(Boolean);
      if (cells.length === 1) cells = bare.split(/\s+/).map(clean).filter(Boolean);
    }
    if (!hasHeading && cells.length > 1 && cells.every(s => isName(s,scenario)) && (delimiter === ',' || delimiter === '，')) return cells.map(value => ({ line:row.line,cells:[value],raw:value }));
    return [{ line:row.line,cells,raw }];
  });
  return rows;
}
function parseCount(value) {
  const v = normalize(value).replace(/次$/,'').trim();
  if (/^\d+$/.test(v) && Number(v) <= 1000000) return Number(v);
  const digits = { 零:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9 };
  if (Object.hasOwn(digits,v)) return digits[v];
  if (/^[一二三四五六七八九]?十[一二三四五六七八九]?$/.test(v)) { const [a,b] = v.split('十'); return (digits[a] || 1)*10+(digits[b] || 0); }
  return null;
}
export function metadataFrom(value) {
  const result = {};
  for (const [key,max] of Object.entries(EXTRA_FIELDS)) {
    if (value[key] === undefined || value[key] === '') continue;
    if (typeof value[key] !== 'string' || value[key].trim().length > max) throw new Error(`${{ department:'部门',position:'职位',group:'班级或分组',notes:'备注' }[key]}不能超过 ${max} 个字符`);
    if (value[key].trim()) result[key] = value[key].trim();
  }
  return result;
}
export function normalizeImportedRows(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > MAX_IMPORT_ROWS) throw new Error(`请选择 1–${MAX_IMPORT_ROWS} 条有效名单`);
  return rows.map((row,i) => {
    if (typeof row?.name !== 'string' || !row.name.trim() || row.name.trim().length > 40) throw new Error(`第 ${i+1} 条名称应为 1–40 个字符`);
    const number = row.number ?? '';
    if (typeof number !== 'string' || number.trim().length > 40) throw new Error(`第 ${i+1} 条编号不能超过 40 个字符`);
    const count = row.initialCount ?? 0;
    if (!Number.isInteger(count) || count < 0 || count > 1000000) throw new Error(`第 ${i+1} 条历史次数必须为非负整数（不超过 1000000）`);
    return { name:row.name.trim(),number:number.trim(),initialCount:count,...metadataFrom(row) };
  });
}
export function analyzeRoster(source,{ scenario = 'class' } = {}) {
  if (typeof source !== 'string' || source.length > 1024*1024) throw new Error('名单文本不能超过 1 MB');
  const input = source.replace(/^\uFEFF/,'').trim();
  if (!input) throw new Error('请先粘贴或选择一份名单');
  const rawRows = readRows(input,scenario);
  if (rawRows.length > MAX_IMPORT_ROWS+20) throw new Error(`一次最多识别 ${MAX_IMPORT_ROWS} 条名单`);
  const headerAt = rawRows.findIndex((row,i) => i < 10 && !row.labelled && (() => {
    const found = row.cells.map(c => headerField(c,scenario));
    return found.includes('name') && (found.filter(Boolean).length >= 2 || row.cells.length === 1);
  })());
  const header = headerAt >= 0 ? rawRows[headerAt].cells : null;
  const mapping = header?.map(c => headerField(c,scenario));
  const dataRows = header ? rawRows.slice(headerAt+1) : rawRows;
  const serialColumn = !header && dataRows.length > 1 && dataRows.every((r,i) => r.cells.length > 1 && r.cells[0] === String(i+1));
  const warnings = headerAt > 0 ? ['已跳过表头前的标题或说明。'] : [];
  const rows = [];
  for (const row of dataRows) {
    if (header && row.cells.every((c,i) => compact(c) === compact(header[i] || ''))) continue;
    const result = { name:'',number:'',initialCount:0 }, issues = [], leftovers = [];
    let explicitCount = null, assumedCount = false;
    const assign = (field,value) => {
      if (!value || field === 'ignore') return;
      if (field === 'initialCount') { explicitCount = value; return; }
      result[field] = result[field] ? result[field]+' / '+value : value;
    };
    if (row.labelled) {
      for (const [field,value] of Object.entries(row.labelled.fields)) assign(field,value);
    } else if (header) {
      row.cells.forEach((value,i) => { const field = mapping[i]; if (field) assign(field,value); else if (value) leftovers.push(`${header[i] || '其他'}：${value}`); });
      // Prefer a baseline column over a total column when importing exported statistics.
      const baseline = header.findIndex(s => /导入前|历史次数/.test(s));
      if (baseline >= 0 && row.cells[baseline]) explicitCount = row.cells[baseline];
    }
    if (!header || row.labelled) {
      let cells = row.labelled ? row.labelled.rest.split(/[\s,，;；|]+/).map(clean).filter(Boolean) : row.cells.filter(Boolean);
      if (serialColumn && !row.labelled) cells = cells.slice(1);
      const candidates = cells.filter(isNumber);
      let preferredNumber = candidates.find(v => normalize(v).length >= 5) || candidates[0];
      if (isName(cells[0],scenario) && isNumber(cells[1] || '')) preferredNumber = cells[1];
      if (isNumber(cells[0] || '') && isName(cells[1],scenario)) preferredNumber = /^[1-9]\d{0,2}$/.test(cells[0]) && isNumber(cells[2] || '') && normalize(cells[2]).length >= 5 ? cells[2] : cells[0];
      const unused = [];
      for (let i=0;i<cells.length;i++) {
        const v = clean(cells[i]);
        if (!v) continue;
        const combined = v.match(/^(.+部|学生会|团委)(副部长|部长|部长助理|干事|副主席|主席|成员)$/u);
        if (combined) { assign('department',combined[1]); assign('position',combined[2]); continue; }
        if (isPosition(v) && !result.position) { assign('position',v); continue; }
        if (isDepartment(v) && !result.department) { assign('department',v); continue; }
        if (isGroup(v)) { if (scenario === 'teacher' && !result.name) result.name = v; else assign('group',v); continue; }
        if (isNumber(v) && !result.number && v === preferredNumber) { result.number = normalize(v).replace(/^['’]/,''); continue; }
        if (!result.name && isName(v,scenario)) {
          let full = v;
          while (/^[a-z .,'’\-]+$/i.test(full) && /^[a-z .,'’\-]+$/i.test(cells[i+1] || '') && isName(cells[i+1],scenario) && !isDepartment(cells[i+1]) && !isPosition(cells[i+1])) full += ' '+cells[++i];
          result.name = full; continue;
        }
        unused.push(v);
      }
      // Keep the original three-column numeric form compatible, without treating job titles as counts.
      if (!row.labelled && cells.length === 3 && result.name && explicitCount === null && /^[-+]?\d+(?:\.\d+)?(?:次)?$/.test(normalize(cells[2])) && !isPhone(cells[2])) {
        if (result.number === normalize(cells[2]) && /^\d{5,}$/.test(normalize(cells[2]))) { /* a long final number is an ID */ }
        else if (result.number && normalize(cells[2]) !== result.number) { explicitCount = cells[2]; assumedCount = true; }
      }
      for (const value of unused) {
        if (value === explicitCount) continue;
        if (/^\d{1,4}$/.test(value) && cells.length > 2 && value === cells[0] && result.name) continue;
        leftovers.push(value);
      }
    }
    if (explicitCount !== null) {
      const parsed = parseCount(explicitCount);
      if (parsed === null) { result.initialCount = null; issues.push('历史次数必须为非负整数，请修改后选中此行'); } else result.initialCount = parsed;
    }
    if (leftovers.length) assign('notes',leftovers.join('；'));
    result.number = normalize(result.number).replace(/^['’]/,'');
    if (!result.name) issues.push('未能确定姓名或班级名称，请补充后选中此行');
    if (result.name.length > 40) issues.push('名称超过 40 个字符，请缩短');
    for (const [field,max] of Object.entries(EXTRA_FIELDS)) if (result[field]?.length > max) issues.push(`${field === 'notes' ? '备注' : '附加信息'}过长，请缩短后选中此行`);
    rows.push({ ...result,line:row.line,raw:row.raw,issues,selected:issues.length === 0,assumedCount });
  }
  if (!rows.length) throw new Error('没有找到可识别的名单内容');
  if (rows.length > MAX_IMPORT_ROWS) throw new Error(`一次最多识别 ${MAX_IMPORT_ROWS} 条名单`);
  if (rows.some(r => r.assumedCount)) warnings.push('无表头的“姓名、编号、数字”按旧格式识别数字为历史次数，请核对。');
  if (rows.some(r => r.notes)) warnings.push('无法确定用途的信息保留在备注中；没有提供的信息留空。');
  if (rows.some(r => r.issues.length)) warnings.push('部分行需要核对，暂未选中；可直接在预览中修改或跳过。');
  const columns = ['name','number',...Object.keys(EXTRA_FIELDS).filter(key => rows.some(r => r[key])),...(rows.some(r => r.initialCount || r.assumedCount) || mapping?.includes('initialCount') ? ['initialCount'] : [])];
  return { rows,columns,warnings,hasHeader:Boolean(header),total:rows.length };
}
export function parseStudents(source,options) {
  const parsed = analyzeRoster(source,options);
  const invalid = parsed.rows.find(row => row.issues.length);
  if (invalid) throw new Error(`第 ${invalid.line} 行${invalid.issues[0]}`);
  return normalizeImportedRows(parsed.rows);
}
