// Shared by the host and browser: every preview uses the same constraint checks.
const MAX = 2000;
const number = (n, max, label) => {
  if (!Number.isInteger(n) || n < 0 || n > max) throw new Error(`${label}应为 0–${max} 的整数`);
  return n;
};
export function normalizeRules(value) {
  if (value == null) value = {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('抽选规则格式无效');
  const ids = (items, label) => {
    if (items === undefined) return [];
    if (!Array.isArray(items) || items.length > MAX || items.some(x => typeof x !== 'string' || !x || x.length > 80) || new Set(items).size !== items.length) throw new Error(`${label}名单无效`);
    return [...items];
  };
  const entries = (items, label) => {
    if (items === undefined) return [];
    if (!Array.isArray(items) || items.length > 100) throw new Error(`${label}最多设置 100 项`);
    const seen = new Set();
    return items.map(x => {
      if (!x || typeof x.value !== 'string' || !x.value.trim() || x.value.trim().length > 80 || seen.has(x.value.trim())) throw new Error(`${label}名称为空或重复`);
      const value = x.value.trim(); seen.add(value);
      return { value, count:number(x.count,MAX,`${value}名额`) };
    });
  };
  const quotaField = value.quotaField ?? 'department';
  if (!['department','group'].includes(quotaField)) throw new Error('配额仅支持部门或班级 / 分组');
  if (value.absent !== undefined && typeof value.absent !== 'boolean') throw new Error('久未参与规则无效');
  return { required:ids(value.required,'指定'), excluded:ids(value.excluded,'排除'), recent:number(value.recent ?? 0,100,'近期避让场数'), absent:value.absent === true, quotaField, quotas:entries(value.quotas,'部门 / 班级配额'), positions:entries(value.positions,'职位搭配') };
}
export function ruleSummary(value) {
  const r = normalizeRules(value), parts = [];
  if (r.required.length) parts.push(`指定 ${r.required.length} 个`);
  if (r.excluded.length) parts.push(`排除 ${r.excluded.length} 个`);
  if (r.recent) parts.push(`避让近 ${r.recent} 场`);
  if (r.absent) parts.push('久未参与优先');
  if (r.quotas.length) parts.push(`${r.quotaField === 'department' ? '部门' : '班级 / 分组'}：` + r.quotas.map(x => `${x.value} ${x.count}`).join('、'));
  if (r.positions.length) parts.push('职位：' + r.positions.map(x => `${x.value} ${x.count}`).join('、'));
  return parts;
}
export function prepareDraw(state, count, strength, value) {
  if (!Number.isInteger(count) || count < 1 || count > MAX) throw new Error('抽选数量应为 1–2000 的整数');
  if (!Number.isInteger(strength) || strength < 0 || strength > 2) throw new Error('均衡强度无效');
  const rules = normalizeRules(value), byId = new Map(state.students.map(s => [s.id,s]));
  for (const id of [...rules.required,...rules.excluded]) if (!byId.has(id)) throw new Error('指定或排除名单包含不存在的档案，请重新设置');
  const events = state.events.filter(e => !e.undone).sort((a,b) => Date.parse(b.createdAt)-Date.parse(a.createdAt));
  const recent = new Set(events.slice(0,rules.recent).flatMap(e => e.participants.map(s => s.id)));
  const excluded = new Set(rules.excluded), requiredSet = new Set(rules.required);
  const required = rules.required.map(id => {
    const s = byId.get(id);
    if (excluded.has(id)) throw new Error(`“${s.name}”同时被指定和排除，请保留一种设置`);
    if (s.archived || !s.enabled) throw new Error(`指定对象“${s.name}”已移除或暂停，请调整名单`);
    if (recent.has(id)) throw new Error(`指定对象“${s.name}”在近期避让范围内，请调整指定名单或避让场数`);
    return s;
  });
  if (required.length > count) throw new Error(`已指定 ${required.length} 个对象，超过本次抽选数量 ${count}`);
  const eligible = state.students.filter(s => !s.archived && s.enabled && !excluded.has(s.id) && !recent.has(s.id));
  if (count > eligible.length) throw new Error(`按当前规则只有 ${eligible.length} 个对象可抽选，需要 ${count} 个；请减少数量或调整排除、近期避让`);
  const candidates = eligible.filter(s => !requiredSet.has(s.id)), remaining = count-required.length;
  const dimension = (entries,field,label) => {
    const sum = entries.reduce((n,x) => n+x.count,0);
    if (sum > count) throw new Error(`${label}名额合计 ${sum}，超过本次抽选数量 ${count}`);
    const lookup = new Map(entries.map((x,i) => [x.value,i]));
    const index = s => lookup.get(s[field]) ?? entries.length;
    const capacities = [...entries.map(x => x.count),count-sum];
    for (const s of required) if (--capacities[index(s)] < 0) throw new Error(`指定对象超出${label}名额，请调整指定名单或配额`);
    capacities.forEach((n,i) => {
      const available = candidates.filter(s => index(s) === i).length;
      if (available < n) throw new Error(`${label}“${entries[i]?.value ?? '其他 / 未填写'}”还需 ${n} 个对象，当前仅有 ${available} 个可抽选`);
    });
    return { index, capacities };
  };
  const groups = dimension(rules.quotas,rules.quotaField,rules.quotaField === 'department' ? '部门' : '班级 / 分组');
  const positions = dimension(rules.positions,'position','职位');
  const counts = new Map(state.students.map(s => [s.id,s.initialCount]));
  const gap = new Map();
  events.forEach((e,i) => e.participants.forEach(s => { counts.set(s.id,(counts.get(s.id)||0)+1); if (!gap.has(s.id)) gap.set(s.id,i); }));
  const weights = new Map(eligible.map(s => [s.id,1/Math.pow((counts.get(s.id)||0)+1,strength) * (rules.absent ? 1+3*(gap.get(s.id) ?? events.length)/Math.max(1,events.length) : 1)]));
  return { rules,required,candidates,eligible,remaining,groups,positions,weights,recentCount:state.students.filter(s => !s.archived && s.enabled && recent.has(s.id)).length };
}

// Min-cost flow solves the two crossing quota dimensions together. Each person
// is a capacity-one edge; exponential random costs preserve ordinary weighted
// sampling when no quotas are set, without a greedy dead-end for mixed rules.
export function selectPrepared(plan, random = null) {
  const { groups,positions,remaining,candidates,required,weights } = plan;
  if (!remaining) return [...required];
  const left = 1, right = left+groups.capacities.length, sink = right+positions.capacities.length;
  const graph = Array.from({ length:sink+1 },() => []), people = [];
  const add = (from,to,capacity,cost) => {
    const edge = { to,capacity,cost,reverse:graph[to].length };
    graph[from].push(edge); graph[to].push({ to:from,capacity:0,cost:-cost,reverse:graph[from].length-1 });
    return edge;
  };
  groups.capacities.forEach((n,i) => add(0,left+i,n,0));
  positions.capacities.forEach((n,i) => add(right+i,sink,n,0));
  const keys = candidates.map(student => {
    const u = random ? random() : 0;
    if (!(u >= 0 && u < 1)) throw new Error('随机数超出范围');
    return { student,key:-Math.log1p(-u)/weights.get(student.id) };
  });
  // A common positive scale keeps floating-point shortest-path distances stable.
  const scale = Math.max(1,...keys.map(x => x.key));
  keys.forEach(({ student,key }) => people.push({ student,edge:add(left+groups.index(student),right+positions.index(student),1,key/scale) }));
  const potential = Array(graph.length).fill(0);
  for (let flow=0;flow<remaining;flow++) {
    const distance = Array(graph.length).fill(Infinity), used = Array(graph.length).fill(false), parent = [];
    distance[0] = 0;
    for (let step=0;step<graph.length;step++) {
      let node = -1;
      for (let i=0;i<graph.length;i++) if (!used[i] && (node === -1 || distance[i] < distance[node])) node = i;
      if (node === -1 || !Number.isFinite(distance[node])) break;
      used[node] = true;
      graph[node].forEach((edge,i) => {
        if (!edge.capacity || used[edge.to]) return;
        const next = distance[node]+Math.max(0,edge.cost+potential[node]-potential[edge.to]);
        if (next < distance[edge.to]) { distance[edge.to] = next; parent[edge.to] = [node,i]; }
      });
    }
    if (!parent[sink]) throw new Error('部门 / 班级配额与职位搭配无法同时满足；请检查各部门内的职位人数或放宽名额');
    for (let i=0;i<graph.length;i++) if (Number.isFinite(distance[i])) potential[i] += distance[i];
    for (let v=sink;v!==0;) { const [from,i] = parent[v], edge = graph[from][i]; edge.capacity--; graph[v][edge.reverse].capacity++; v = from; }
  }
  return [...required,...people.filter(x => x.edge.capacity === 0).map(x => x.student)];
}
export function inspectDraw(state,count,strength,rules) {
  const plan = prepareDraw(state,count,strength,rules);
  selectPrepared(plan);
  return plan;
}
