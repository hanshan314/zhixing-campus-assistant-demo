import { normalizeRules,inspectDraw,ruleSummary } from './rules-engine.js';
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g,c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
const sections = [
  ['people','◎','指定与排除','安排必选对象，临时排除本次不参加的人'],
  ['recent','◷','近期避让','让最近参加过活动的人休息几场'],
  ['absent','↗','久未参与优先','等待越久，随机抽中的权重越高'],
  ['quotas','▦','部门 / 班级配额','为不同部门或班级分配固定名额'],
  ['positions','◇','职位搭配','按职位组合活动人员']
];
export class PickerRules {
  constructor(options) { Object.assign(this,options); }
  check(value = this.getState().settings.rules) {
    try { return { plan:inspectDraw(this.getState(),this.getCount(),this.getStrength(),value) }; }
    catch (error) { return { error:error.message }; }
  }
  render() {
    const state = this.getState(), r = normalizeRules(state.settings.rules);
    const labels = [r.required.length || r.excluded.length ? `指定 ${r.required.length} · 排除 ${r.excluded.length}` : '自由抽选',r.recent ? `避让最近 ${r.recent} 场` : '未开启',r.absent ? '已开启 · 最高 4 倍' : '未开启',r.quotas.length ? `${r.quotaField === 'department' ? '部门' : '班级 / 分组'} · ${r.quotas.reduce((n,x) => n+x.count,0)} 个名额` : '不限部门 / 班级',r.positions.length ? `${r.positions.length} 类职位 · ${r.positions.reduce((n,x) => n+x.count,0)} 个名额` : '不限职位'];
    const flags = [r.required.length || r.excluded.length,r.recent,r.absent,r.quotas.length,r.positions.length];
    $('rule-cards').innerHTML = sections.map(([key,icon,title,description],i) => `<button class="rule-card ${flags[i] ? 'is-on' : ''}" data-rule="${key}"><span class="rule-icon">${icon}</span><span class="rule-title">${title}<span>↗</span></span><small>${description}</small><span class="rule-state">${esc(labels[i])}</span></button>`).join('');
    $('rule-cards').querySelectorAll('[data-rule]').forEach(button => button.addEventListener('click',() => this.show(button.dataset.rule)));
    this.refreshStatus();
  }
  refreshStatus() {
    if (!this.getState()) return;
    const check = this.check(), empty = !this.getState().students.some(s => !s.archived);
    $('rule-status').classList.toggle('has-error',!!check.error && !empty);
    $('rule-status').textContent = empty ? '导入名单后，可组合设置这五类规则。' : check.error ? `请调整规则：${check.error}` : `✓ 规则可执行 · 筛选后 ${check.plan.eligible.length} 个可抽选 · 指定 ${check.plan.required.length} 个，其余按权重抽取`;
    $('rule-summary').textContent = ruleSummary(this.getState().settings.rules).join(' · ') || '当前仅使用基础随机权重';
    if (check.plan) $('eligible-hint').textContent = `规则筛选后可抽选 ${check.plan.eligible.length} 个对象`;
    return check;
  }
  show(tab = 'people') {
    if (this.isBusy()) return;
    let draft = normalizeRules(this.getState().settings.rules), page = 0;
    const students = this.getState().students.filter(s => !s.archived);
    this.modal('组合抽选规则', `<p class="rules-intro">先确定参与范围，再满足配额与职位搭配，最后按随机权重抽选。指定对象计入总名额，规则保存后持续生效，可随时清空。${this.getState().pending ? '保存规则会取消尚未确认的抽选。' : ''}</p>
      <div class="rule-tabs" role="tablist" aria-label="规则类型">${sections.map(([key,icon,title]) => `<button type="button" role="tab" id="rule-tab-${key}" aria-controls="rule-panel-${key}" data-rule-tab="${key}">${icon} ${title}</button>`).join('')}</div>
      <form id="rules-form" novalidate>
      <section id="rule-panel-people" class="rule-panel" role="tabpanel" aria-labelledby="rule-tab-people">
        <h3>谁一定参加，谁暂不参加？</h3><p>指定对象仍须处于可参与状态，且不能命中近期避让。排除仅影响本场景的后续抽选，不修改名单中的参与状态。</p>
        <div class="rule-search"><input id="rule-search" type="search" placeholder="搜索姓名、编号、部门或职位" aria-label="搜索规则名单"><select id="rule-people-filter" aria-label="筛选规则名单"><option value="all">全部对象</option><option value="required">仅看指定</option><option value="excluded">仅看排除</option></select></div>
        <div id="rule-people-count" class="rule-small"></div><div id="rule-people-list" class="rule-people-list"></div><div id="rule-people-pages" class="rule-pages"></div>
      </section>
      <section id="rule-panel-recent" class="rule-panel" role="tabpanel" aria-labelledby="rule-tab-recent" hidden><h3>让刚参加过的人，休息几场。</h3><p>避开最近若干场活动中的全部参与对象。只使用当前场景已确认且未撤销的活动；重新抽选和待确认结果不计入。</p><label class="rule-number-label">避让最近 <input id="rule-recent" type="number" min="0" max="100" value="${draft.recent}"> 场活动</label><p class="rule-help">填 0 关闭，可设 1–100 场。若可选人数不足，请减少避让场数或抽选数量。</p></section>
      <section id="rule-panel-absent" class="rule-panel" role="tabpanel" aria-labelledby="rule-tab-absent" hidden><h3>把更多机会，留给等待更久的人。</h3><label class="rule-switch"><input id="rule-absent" type="checkbox" ${draft.absent ? 'checked' : ''}><span><strong>开启久未参与优先</strong><small>在基础权重上，额外乘以 1–4 倍等待权重</small></span></label><p>按距离最近一次参与隔了多少场有效活动计算。刚参加过为 1 倍，当前场景无参与记录者获得最高等待权重；没有任何有效活动时大家相同。</p><p class="rule-help">导入前次数没有日期，不推算参与时间。此规则提高机会，不保证必选。与“均衡参与”叠加时，同时考虑总次数和等待时长。</p></section>
      <section id="rule-panel-quotas" class="rule-panel" role="tabpanel" aria-labelledby="rule-tab-quotas" hidden><h3>让不同团队，各有名额。</h3><p>为填写的部门或班级设置<strong>恰好入选数量</strong>。未设置的类别和未填写资料的对象补足其余名额；填 0 表示该类别不入选。</p><label class="rule-dimension">按什么分配？<select id="rule-quota-field"><option value="department">部门</option><option value="group">班级 / 分组</option></select></label><div id="rule-quotas-rows" class="quota-rows"></div><button type="button" id="rule-add-quota" class="button secondary small">＋ 添加配额</button><p class="rule-help">名称来自名单中的部门、班级 / 分组。缺少资料时，可先到名单中编辑补充。切换维度会清空原维度配额。</p></section>
      <section id="rule-panel-positions" class="rule-panel" role="tabpanel" aria-labelledby="rule-tab-positions" hidden><h3>把合适的职位，搭配在一起。</h3><p>例如：部长 1 人、干事 2 人。每个填写职位都是<strong>恰好入选数量</strong>，其他职位补足剩余名额。与部门配额同时设置时，每位入选者会同时占用所属部门和职位的名额。</p><div id="rule-positions-rows" class="quota-rows"></div><button type="button" id="rule-add-position" class="button secondary small">＋ 添加职位</button><p class="rule-help">按名单中的职位名称精确匹配，“部长”和“副部长”分别计算。没有职位资料的对象归入其他类别。</p></section>
      <div class="rule-draft-check" id="rule-draft-check" role="status"></div><p class="rule-small rule-save-note">可先保存配置，再调整名单或人数；开始抽选前须满足全部规则。</p><div class="modal-actions rules-actions"><button class="text-button" type="button" id="rule-clear">清空规则</button><button class="button secondary" type="button" id="rule-cancel">取消</button><button class="button primary" type="submit">保存规则</button></div></form>`,() => {
      $('modal').classList.add('rules-modal');
      const activate = key => {
        tab = key;
        for (const [name] of sections) { $(`rule-panel-${name}`).hidden = name !== key; $(`rule-tab-${name}`).setAttribute('aria-selected',String(name === key)); $(`rule-tab-${name}`).tabIndex = name === key ? 0 : -1; }
        $(`rule-tab-${key}`).scrollIntoView({ block:'nearest',inline:'nearest' });
      };
      const sync = () => { draft.recent = Number($('rule-recent').value); draft.absent = $('rule-absent').checked; };
      const check = () => {
        sync(); const { plan,error } = this.check(draft);
        $('rule-draft-check').textContent = error ? `暂时无法抽选：${error}` : `✓ 可以抽选 ${this.getCount()} 个对象 · 筛选后可选 ${plan.eligible.length} 个 · 已指定 ${plan.required.length} 个`;
        $('rule-draft-check').classList.toggle('has-error',!!error);
        $('modal-error').textContent = '';
      };
      const people = () => {
        const query = $('rule-search').value.trim().toLowerCase(), filter = $('rule-people-filter').value;
        const filtered = students.filter(s => [s.name,s.number,s.department,s.group,s.position].filter(Boolean).join(' ').toLowerCase().includes(query) && (filter === 'all' || draft[filter].includes(s.id)));
        page = Math.max(0,Math.min(page,Math.ceil(filtered.length/60)-1));
        $('rule-people-count').textContent = `已指定 ${draft.required.length} 个 · 已排除 ${draft.excluded.length} 个 · 匹配 ${filtered.length} 个`;
        $('rule-people-list').innerHTML = filtered.slice(page*60,page*60+60).map(s => `<label class="rule-person"><span class="rule-person-info"><strong>${esc(s.name)}${!s.enabled ? '<em>已暂停</em>' : ''}</strong><small>${esc([s.number,s.department,s.group,s.position].filter(Boolean).join(' · ')) || '暂无附加信息'}</small></span><select data-person="${esc(s.id)}" aria-label="${esc(s.name)} ${esc(s.number)} 抽选安排"><option value="free">自由抽选</option><option value="required" ${draft.required.includes(s.id) ? 'selected' : ''}>指定必选</option><option value="excluded" ${draft.excluded.includes(s.id) ? 'selected' : ''}>本次排除</option></select></label>`).join('') || '<div class="rule-empty">没有匹配对象，请先导入名单或调整搜索。</div>';
        $('rule-people-pages').innerHTML = filtered.length > 60 ? `<button type="button" id="rule-prev" class="text-button" ${page === 0 ? 'disabled' : ''}>上一页</button><span>${page+1} / ${Math.ceil(filtered.length/60)}</span><button type="button" id="rule-next" class="text-button" ${(page+1)*60 >= filtered.length ? 'disabled' : ''}>下一页</button>` : '';
        $('rule-prev')?.addEventListener('click',() => { page--; people(); }); $('rule-next')?.addEventListener('click',() => { page++; people(); });
      };
      const rows = kind => {
        const field = kind === 'quotas' ? draft.quotaField : 'position', label = field === 'department' ? '部门' : field === 'group' ? '班级 / 分组' : '职位';
        const values = [...new Set(students.map(s => s[field]).filter(Boolean))].sort((a,b) => a.localeCompare(b,'zh-CN'));
        $(`rule-${kind}-rows`).innerHTML = draft[kind].map((entry,i) => {
          const options = [...new Set([entry.value,...values])].filter(Boolean);
          return `<div class="quota-row"><select data-quota-value="${i}" aria-label="第 ${i+1} 项${label}"><option value="">选择${label}</option>${options.map(value => `<option value="${esc(value)}" ${entry.value === value ? 'selected' : ''}>${esc(value)}</option>`).join('')}</select><input data-quota-count="${i}" type="number" min="0" max="2000" value="${entry.count}" aria-label="第 ${i+1} 项${label}名额"><span>个名额</span><button type="button" data-quota-remove="${i}" class="icon-button" aria-label="移除第 ${i+1} 项${label}">×</button></div>`;
        }).join('') || `<div class="rule-empty">未设置${label}要求，所有类别均可按权重抽选。</div>`;
      };
      $('rule-quota-field').value = draft.quotaField;
      document.querySelectorAll('[data-rule-tab]').forEach(button => {
        button.addEventListener('click',() => activate(button.dataset.ruleTab));
        button.addEventListener('keydown',e => {
          if (!['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) return;
          e.preventDefault(); const keys = sections.map(s => s[0]), index = keys.indexOf(tab), next = e.key === 'Home' ? 0 : e.key === 'End' ? keys.length-1 : (index+(e.key === 'ArrowRight' ? 1 : -1)+keys.length)%keys.length;
          activate(keys[next]); $(`rule-tab-${keys[next]}`).focus();
        });
      });
      $('rule-search').addEventListener('input',() => { page=0;people(); }); $('rule-people-filter').addEventListener('change',() => { page=0;people(); });
      $('rule-people-list').addEventListener('change',e => {
        const id = e.target.dataset.person; if (!id) return;
        for (const key of ['required','excluded']) draft[key] = draft[key].filter(x => x !== id);
        if (e.target.value !== 'free') draft[e.target.value].push(id);
        people();check();
      });
      for (const kind of ['quotas','positions']) {
        $(`rule-${kind}-rows`).addEventListener('input',e => {
          if (e.target.dataset.quotaCount !== undefined) draft[kind][Number(e.target.dataset.quotaCount)].count = e.target.value === '' ? NaN : Number(e.target.value);
          if (e.target.dataset.quotaValue !== undefined) draft[kind][Number(e.target.dataset.quotaValue)].value = e.target.value;
          check();
        });
        $(`rule-${kind}-rows`).addEventListener('click',e => {
          const button = e.target.closest('[data-quota-remove]'); if (!button) return;
          draft[kind].splice(Number(button.dataset.quotaRemove),1); rows(kind);check();
        });
        $(kind === 'quotas' ? 'rule-add-quota' : 'rule-add-position').addEventListener('click',() => {
          if (draft[kind].length >= 100) return;
          const field = kind === 'quotas' ? draft.quotaField : 'position', value = students.map(s => s[field]).find(v => v && !draft[kind].some(x => x.value === v)) || '';
          draft[kind].push({ value,count:1 });rows(kind);check();
        });
      }
      $('rule-quota-field').addEventListener('change',() => { draft.quotaField = $('rule-quota-field').value; draft.quotas=[];rows('quotas');check(); });
      $('rule-recent').addEventListener('input',check); $('rule-absent').addEventListener('change',check);
      $('rule-cancel').addEventListener('click',this.closeModal);
      $('rule-clear').addEventListener('click',() => { draft=normalizeRules();$('rule-recent').value=0;$('rule-absent').checked=false;$('rule-quota-field').value='department';people();rows('quotas');rows('positions');check(); });
      $('rules-form').addEventListener('submit',async e => {
        e.preventDefault();sync();
        try {
          const rules = normalizeRules(draft);
          // Infeasible rules may be saved for later editing of the roster/count;
          // the draw itself always requires a fully feasible combination.
          const result = await this.save(rules);
          if (result) this.closeModal();
        } catch (error) { $('modal-error').textContent = error.message; }
      });
      activate(tab);people();rows('quotas');rows('positions');check();
    });
  }
}
