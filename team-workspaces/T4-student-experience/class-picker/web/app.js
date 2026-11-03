import { PickerRules } from './rules-ui.js';
import { ruleSummary } from './rules-engine.js';
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
  const strategyNames = ['完全随机', '均衡参与', '优先少参与'];
  let state = null, view = 'draw', busy = false, drawing = false, toastTimer, confirmed = null;
  let accounts, rulesUI, displayedSpace = null;
  const meta = () => accounts?.scenarios?.[state?.scenario] || { label:'班级内抽签',subject:'同学',unit:'人',numberLabel:'学号',icon:'⇄' };
  const token = new URLSearchParams(location.hash.slice(1)).get('access') || '';
  // A fragment is not sent to the server or in HTTP referrers, and survives reload.
  function counts() {
    const map = new Map(state.students.map(s => [s.id, s.initialCount]));
    for (const e of state.events) if (!e.undone) for (const s of e.participants) if (map.has(s.id)) map.set(s.id, map.get(s.id) + 1);
    return map;
  }
  const activeStudents = () => state.students.filter(s => !s.archived);
  const strength = () => Number(document.querySelector('input[name=strength]:checked').value);
  const relativeWeight = (count, mode) => 1 / Math.pow(count + 1, mode);
  const formatWeight = n => n >= .01 ? n.toFixed(2) : n.toExponential(1);
  const date = (value, full = false) => new Intl.DateTimeFormat('zh-CN', { month:'2-digit', day:'2-digit', ...(full ? { year:'numeric' } : {}), hour:'2-digit', minute:'2-digit' }).format(new Date(value));
  function toast(message) {
    clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4000);
  }
  function report(message) { $('error-banner').textContent = message; $('error-banner').hidden = false; }
  async function request(path, payload) {
    const response = await fetch('./api/' + path, { method: payload ? 'POST' : 'GET', headers: { 'x-class-picker-token': token, ...(payload ? { 'content-type':'application/json' } : {}) }, body: payload ? JSON.stringify(payload) : undefined });
    const data = await response.json();
    if (!response.ok) {
      if (data.state) accounts.apply(data);
      if (response.status === 401 && !path.startsWith('auth')) accounts?.signedOut('登录已失效，请重新登录');
      const error = new Error(data.error || '操作失败，请重试'); error.status = response.status; throw error;
    }
    return data;
  }
  function setBusy(value) {
    busy = value;
    document.querySelectorAll('main button, aside button, main input, main select, aside select, #auth-screen button, #auth-screen input, #auth-screen select, #modal button, #modal input, #modal select, #modal textarea').forEach(el => {
      if (value) { el.dataset.wasDisabled = String(el.disabled); el.disabled = true; }
      else { el.disabled = el.dataset.wasDisabled === 'true'; delete el.dataset.wasDisabled; }
    });
  }
  async function change(operation, data = {}, options = {}) {
    if (busy || !state) return null;
    setBusy(true); $('error-banner').hidden = true; $('save-status').textContent = '正在保存…';
    try {
      const result = await request('action', { operation, ...data, spaceId:accounts.spaceId, revision: state.revision });
      setBusy(false);
      accounts.apply(result);
      if (!options.quiet) toast(result.message);
      return result;
    } catch (error) {
      setBusy(false); $('save-status').textContent = '保存未完成';
      if ($('modal').open) $('modal-error').textContent = error.message;
      else if (!accounts.account) $('auth-error').textContent = error.message;
      else report(error.message);
      return null;
    }
  }
  function render(preserveSetup = false) {
    const students = activeStudents(), map = counts(), m = meta();
    $('class-button').title = `${state.className} · 点击修改名称`;
    $('scene-type-label').textContent = m.label; $('scene-icon').textContent = m.icon;
    $('stat-entity-label').textContent = m.subject + (state.scenario === 'teacher' ? '数量' : '人数');
    $('stat-average-label').textContent = state.scenario === 'teacher' ? '班均参与' : '人均参与';
    $('import-top').textContent = '＋ 导入' + m.subject;
    $('count-question').textContent = state.scenario === 'teacher' ? '这次抽取几个班级？' : `这次需要几位${m.subject}？`;
    $('draw-unit').textContent = state.scenario === 'teacher' ? '班' : '人';
    $('roster-heading').textContent = m.subject + '名单'; $('nav-roster-label').textContent = m.subject + '名单';
    document.querySelector('.nav-button[data-view=roster]').setAttribute('aria-label',m.subject + '名单');
    $('roster-name-title').textContent = m.subject; $('roster-number-title').textContent = m.numberLabel;
    $('student-search').placeholder = state.scenario === 'teacher' ? '搜索班级或编号' : '搜索姓名或编号';
    $('nav-count').textContent = students.length;
    $('stat-students').innerHTML = `${students.length}<small>${state.scenario === 'teacher' ? '班' : '人'}</small>`;
    $('stat-events').innerHTML = `${state.events.filter(e => !e.undone).length}<small>次</small>`;
    $('stat-average').innerHTML = `${students.length ? (students.reduce((a,s) => a + map.get(s.id),0) / students.length).toFixed(1) : '0'}<small>次</small>`;
    $('stat-paused').innerHTML = `${students.filter(s => !s.enabled).length}<small>${state.scenario === 'teacher' ? '班' : '人'}</small>`;
    $('eligible-hint').textContent = `当前可抽选 ${students.filter(s => s.enabled).length} ${m.unit}`;
    if (!preserveSetup) {
      $('draw-count').value = state.settings.count;
      document.querySelectorAll('input[name=strength]').forEach(el => { el.checked = Number(el.value) === state.settings.strength; });
    }
    updateStrategy(); renderStage(); renderRecent(); renderRoster(); renderHistory();
    rulesUI.render();
    $('save-status').textContent = '✓ 当前账号 · 当前场景 · 本机保存';
  }
  function orbit() { return '<div class="orbit" aria-hidden="true"><div class="orbit-ring"></div><div class="orbit-ring second"></div><span class="orbit-center">⇄</span><span class="orb-person a">☺</span><span class="orb-person b">☺</span><span class="orb-person c">☺</span><span class="orb-person d">☺</span><span class="orbit-star">✧</span><span class="orbit-plus">＋</span></div>'; }
  function winners(students, map, isConfirmed, required = []) {
    return '<div class="winners">' + students.map(s => `<div class="winner"><span class="winner-avatar">${escape(s.name.slice(0,1))}</span><strong>${escape(s.name)}</strong>${required.includes(s.id) ? '<span class="winner-required">指定参与</span>' : ''}${s.department || s.position || s.group ? `<span class="winner-metadata">${escape([s.department,s.group,s.position].filter(Boolean).join(' · '))}</span>` : ''}<small>${s.number ? `${meta().numberLabel} ${escape(s.number)}<br>` : ''}${isConfirmed ? '累计参与' : '此前参与'} ${map.get(s.id) || 0} 次</small></div>`).join('') + '</div>';
  }
  function renderStage() {
    const students = activeStudents(), eligible = students.filter(s => s.enabled), map = counts();
    const stage = $('draw-stage'), actions = $('draw-actions'), status = $('draw-status');
    stage.classList.toggle('drawing', drawing);
    status.className = 'tag';
    if (drawing) {
      status.textContent = '正在抽选'; stage.innerHTML = orbit() + '<h2>让机会，转起来。</h2><p>正在按当前参与权重抽选…</p>'; actions.innerHTML = '<button class="button primary" disabled>抽选中…</button>'; return;
    }
    if (state.pending) {
      const p = state.pending;
      status.textContent = '待确认参与';
      stage.innerHTML = `<div class="result-caption">${escape(p.name)} · ${strategyNames[p.strength]}</div><h2>这次，轮到你啦！</h2>` + winners(p.ids.map(id => students.find(s => s.id === id)), map, false,p.rules?.required) + `<p class="result-rules">${escape(ruleSummary(p.rules).join(' · '))}</p><p>名单已抽出。确认参与后，每${state.scenario === 'teacher' ? '个班级' : '人'}记为 1 次活动。</p>`;
      actions.innerHTML = '<button class="button secondary" id="redraw">↻ 重新抽选</button><button class="button primary" id="confirm-draw">✓ 确认参与并记录</button><button class="text-button" id="cancel-draw">取消本次</button>';
      $('redraw').addEventListener('click', draw);
      $('confirm-draw').addEventListener('click', async () => {
        const savedId = state.pending.id;
        const result = await change('confirm', { id:savedId });
        if (result) { confirmed = state.events[0]; renderStage(); }
      });
      $('cancel-draw').addEventListener('click', () => change('cancel'));
    } else if (confirmed) {
      status.textContent = '已计入次数'; status.classList.add('confirmed');
      stage.innerHTML = `<div class="result-caption">${escape(confirmed.name)}</div><h2 class="confirmed-heading">参与已记录，期待下次相聚。</h2>` + winners(confirmed.participants, map, true,confirmed.rules?.required) + '<p>参与次数与抽选权重已同步更新。</p>';
      actions.innerHTML = '<button class="button primary" id="next-draw">开始下一次抽选 →</button>';
      $('next-draw').addEventListener('click', () => { confirmed = null; $('activity-name').value = ''; renderStage(); });
    } else if (!students.length) {
      status.textContent = '等待添加名单';
      stage.innerHTML = orbit() + `<h2>${state.scenario === 'teacher' ? '把任教班级，都放进来。' : '让每一位' + meta().subject + '，都有机会。'}</h2><p>先为“${escape(state.className)}”添加名单。<br>支持粘贴名称，也可以导入 TXT / CSV 文件。</p>`;
      actions.innerHTML = '<button class="button primary" id="empty-import">＋ 添加抽签名单</button><button class="text-button" id="try-demo">体验示例 ↗</button>';
      $('empty-import').addEventListener('click', showImport);
      $('try-demo').addEventListener('click', () => change('demo'));
    } else {
      const check = rulesUI.check();
      status.textContent = !eligible.length ? '全部暂停' : check.error ? '请调整规则' : '准备就绪';
      stage.innerHTML = orbit() + `<h2>${state.scenario === 'teacher' ? '这一次，会轮到哪个班级？' : '下一份幸运，会落在谁身上？'}</h2><p>${!eligible.length ? '名单已全部暂停，请先在名单管理中恢复参与。' : check.error ? '当前规则尚未满足，请在下方调整规则或抽选数量。' : `规则筛选后 ${check.plan.eligible.length} ${meta().unit}可抽选，点击开始发现本次结果。`}<br>在合适的组合中，让机会转起来。</p>`;
      actions.innerHTML = `<button class="button primary" id="start-draw" ${!eligible.length ? 'disabled' : ''}>⇄ 开始随机抽选</button>`;
      $('start-draw').addEventListener('click', draw);
    }
  }
  async function draw() {
    if (busy || drawing) return;
    const count = Number($('draw-count').value), mode = strength(), name = $('activity-name').value.trim() || meta().label;
    const eligible = activeStudents().filter(s => s.enabled).length;
    if (!Number.isInteger(count) || count < 1 || count > eligible) { report(`请输入 1–${eligible} 的整数人数`); $('draw-count').focus(); return; }
    const checked = rulesUI.refreshStatus();
    if (checked.error) { report(checked.error); $('rule-status').scrollIntoView({ block:'nearest',behavior:'smooth' }); return; }
    drawing = true; confirmed = null;
    renderStage();
    const result = await change('draw', { count, strength:mode, name }, { quiet:true });
    await new Promise(resolve => setTimeout(resolve, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 650));
    drawing = false; if (state) renderStage();
    if (result) toast('抽选完成，确认参与后才会增加次数');
  }
  function updateStrategy() {
    const mode = strength();
    document.querySelectorAll('.strategy').forEach(el => el.classList.toggle('selected', el.querySelector('input').checked));
    $('weight-explanation').textContent = [ '基础权重 = 1。参与次数不影响基础权重。', '基础权重 = 1 ÷（参与次数 + 1）。参与 0 次与 2 次的对象，权重比为 3∶1。', '基础权重 = 1 ÷（参与次数 + 1）²。参与 0 次与 2 次的对象，权重比为 9∶1。' ][mode] + ' 下方组合规则会进一步筛选和调整抽选。';
    if (state) renderRoster();
    if (state && rulesUI) rulesUI.refreshStatus();
  }
  function renderRecent() {
    const events = state.events.filter(e => !e.undone).slice(0,2);
    $('recent-events').innerHTML = events.length ? events.map(e => `<div class="recent-item"><span class="event-icon">⚑</span><div><strong>${escape(e.name)}</strong><small>${date(e.createdAt)} · ${e.participants.slice(0,3).map(s => escape(s.name)).join('、')}${e.participants.length > 3 ? ' 等' : ''}</small></div><span class="event-count">${e.participants.length} ${meta().unit}参与</span></div>`).join('') : '<div class="recent-empty"><span>◷</span><div>这个场景的第一场活动，等你开启。</div></div>';
  }
  function renderRoster() {
    const map = counts(), mode = strength(), search = $('student-search').value.trim().toLowerCase();
    const all = activeStudents();
    let students = all.filter(s => [s.name,s.number,s.department,s.position,s.group,s.notes].filter(Boolean).join(' ').toLowerCase().includes(search));
    const sort = $('student-sort').value;
    if (sort !== 'default') students.sort((a,b) => (map.get(a.id) - map.get(b.id)) * (sort === 'least' ? 1 : -1));
    const max = Math.max(0, ...all.filter(s => s.enabled).map(s => relativeWeight(map.get(s.id),mode))) || 1;
    $('roster-total').textContent = `${all.length} ${meta().unit}`;
    const extraFields = ['department','position','group','notes'].filter(field => all.some(s => s[field]));
    for (const field of ['department','position','group','notes']) $('roster-'+field+'-title').hidden = !extraFields.includes(field);
    $('roster-body').innerHTML = students.length ? students.map(s => {
      const w = relativeWeight(map.get(s.id),mode);
      return `<tr><td class="student-name"><div class="table-name"><span class="table-avatar">${escape(s.name.slice(0,1))}</span>${escape(s.name)}</div></td><td>${escape(s.number) || '—'}</td>${extraFields.map(field => `<td class="member-detail" title="${escape(s[field] || '')}">${escape(s[field]) || '—'}</td>`).join('')}<td><span class="count-value">${map.get(s.id)}</span> 次</td><td><span class="weight-track"><span class="weight-fill" data-percent="${s.enabled ? Math.max(3,w / max * 100) : 0}"></span></span>${s.enabled ? formatWeight(w) : '—'}</td><td><button class="status-toggle ${s.enabled ? '' : 'paused'}" data-action="toggle" data-id="${escape(s.id)}" title="点击${s.enabled ? '暂停' : '恢复'}抽选">${s.enabled ? '● 参与抽选' : 'Ⅱ 已暂停'}</button></td><td><div class="row-actions"><button data-action="edit" data-id="${escape(s.id)}">编辑</button><button data-action="remove" data-id="${escape(s.id)}">移除</button></div></td></tr>`;
    }).join('') : `<tr><td colspan="${6+extraFields.length}" class="empty-table">${search ? '没有找到匹配结果，换个名称试试。' : '这里还没有名单，点击右上角的导入按钮开始。'}</td></tr>`;
    // Styles are set via DOM properties to comply with the plugin page CSP.
    document.querySelectorAll('.weight-fill').forEach(el => { el.style.width = `${el.dataset.percent}%`; });
  }
  function renderHistory() {
    $('history-total').textContent = `${state.events.filter(e => !e.undone).length} 次有效活动`;
    $('history-list').innerHTML = state.events.length ? state.events.map(e => `<article class="history-item ${e.undone ? 'undone' : ''}"><span class="event-icon">⚑</span><div class="history-info"><h3>${escape(e.name)}</h3><div class="history-meta">${date(e.createdAt,true)} · ${strategyNames[e.strength]} · ${e.participants.length} ${meta().unit}${e.undone ? ' · 已撤销，不计入参与次数' : ''}</div><div class="participant-tags">${e.participants.map(s => `<span>${escape(s.name)}${s.number ? ` <small>${escape(s.number)}</small>` : ''}</span>`).join('')}</div></div>${e.undone ? '' : `<button class="button secondary small" data-undo="${escape(e.id)}">撤销</button>`}</article>`).join('') : '<div class="history-empty">这个场景还没有活动记录。完成抽选并确认参与后，活动就会出现在这里。</div>';
    document.querySelectorAll('.history-info').forEach((el,i) => {
      const summary = ruleSummary(state.events[i].rules);
      if (summary.length) { const p=document.createElement('p');p.className='history-rules';p.textContent=summary.join(' · ');el.querySelector('.history-meta').after(p); }
    });
  }
  function setView(next) {
    if (busy || drawing) return;
    view = next;
    const titles = { draw:[meta().label,'让每一次参与，都更公平。',`${state?.className || ''} · ${meta().label}，名单和次数独立保存。`], roster:[meta().subject+'名单','每一个名字，都值得被看见。',`管理当前场景的${meta().subject}名单、参与次数与抽选状态。`], history:['活动记录','参与过的时刻，都有迹可循。','查看当前场景的活动历史，为下一次公平分配机会。'] };
    for (const v of ['draw','roster','history']) $(v + '-view').hidden = v !== next;
    document.querySelectorAll('.nav-button').forEach(el => { el.classList.toggle('active',el.dataset.view === next); if (el.dataset.view === next) el.setAttribute('aria-current','page'); else el.removeAttribute('aria-current'); });
    $('breadcrumb').textContent = titles[next][0]; $('page-title').textContent = titles[next][1]; $('page-subtitle').textContent = titles[next][2];
    if (state) { renderRoster(); renderHistory(); }
  }
  function modal(title, content, bind) {
    $('modal').classList.remove('import-modal','rules-modal');
    $('modal-title').textContent = title;
    $('modal-body').innerHTML = content + '<div id="modal-error" class="modal-error" role="alert"></div>';
    $('modal').showModal(); if (bind) bind();
  }
  const closeModal = () => { if (!busy) $('modal').close(); };
  function confirmDialog(title, copy, action, onConfirm, danger = false) {
    modal(title, `<p class="modal-copy ${danger ? 'danger-copy' : ''}">${escape(copy)}</p><div class="modal-actions"><button class="button secondary" id="dialog-cancel">取消</button><button class="button ${danger ? 'danger' : 'primary'}" id="dialog-confirm">${escape(action)}</button></div>`, () => {
      $('dialog-cancel').addEventListener('click',closeModal);
      $('dialog-confirm').addEventListener('click',async () => { const result = await onConfirm(); if (result) closeModal(); });
    });
  }
  function showImport() {
    if (!state || busy || drawing) return;
    const m = meta(), placeholder = state.scenario === 'teacher' ? '直接粘贴原始名单，例如：\n101  高一（1）班\n高一（2）班  102' : '直接粘贴原始名单，例如：\n示例甲  组织部  干事\nS-001  示例辛  宣传部  部长\n姓名：示例一，学号：001，职位：成员';
    modal(`智能导入${m.subject}名单`, `<p class="modal-copy">直接粘贴现有名单，无需调整列顺序。自动识别<strong>姓名、学号或编号、部门、职位、班级和次数</strong>，没有的留空。识别后可直接修改预览，再确认保存到当前场景。</p><form class="modal-form" id="import-form"><label>抽签名单<textarea id="import-source" placeholder="${escape(placeholder)}" required></textarea></label><label class="upload-label">选择 TXT / CSV 文件<input id="roster-file" type="file" accept=".txt,.csv,.tsv,text/plain,text/csv"></label><section id="import-preview" class="import-preview" aria-live="polite" hidden></section><div class="modal-actions import-actions"><span id="import-summary" class="import-summary">粘贴后自动识别，原始文本会保留</span><button class="button secondary" type="button" id="import-cancel">取消</button><button class="button primary" type="submit" id="import-submit">识别并预览</button></div></form>`, () => {
      let preview = null, previewSource = '', timer, serial = 0, page = 0;
      const fieldLabels = { name:state.scenario === 'teacher' ? '班级名称' : '姓名',number:m.numberLabel,department:'部门',position:'职位',group:'班级 / 分组',notes:'备注',initialCount:'历史次数' };
      const draftKey = 'picker-import:'+accounts.account.id+':'+accounts.spaceId;
      const saveDraft = () => { try { sessionStorage.setItem(draftKey,$('import-source').value); } catch {} };
      const rowErrors = row => {
        const errors = [];
        if (!row.name?.trim() || row.name.length > 40) errors.push('请补充 1–40 字的名称');
        if (row.number?.length > 40) errors.push('编号最多 40 字');
        if (!Number.isInteger(row.initialCount) || row.initialCount < 0 || row.initialCount > 1000000) errors.push('次数应为非负整数');
        for (const [field,max] of Object.entries({ department:80,position:80,group:80,notes:240 })) if ((row[field] || '').length > max) errors.push(`${fieldLabels[field]}最多 ${max} 字`);
        return errors;
      };
      const updateSummary = () => {
        if (!preview) return;
        const selected = preview.rows.filter(row => row.selected).length;
        $('import-summary').textContent = `识别 ${preview.rows.length} 条 · 已选 ${selected} 条${preview.rows.some(r => r.duplicate) ? ' · 重复项默认跳过' : ''}`;
        $('import-submit').textContent = selected ? `确认导入 ${selected} 条` : '请选择要导入的记录';
        $('import-submit').disabled = !selected;
      };
      const drawPreview = () => {
        const columns = preview.columns, start = page*50, shown = preview.rows.slice(start,start+50), pages = Math.ceil(preview.rows.length/50);
        $('import-preview').hidden = false;
        $('import-preview').innerHTML = `<div class="import-preview-heading"><strong>识别预览 <small>可直接编辑</small></strong><span>${preview.hasHeader ? '已识别表头' : '自动判断字段'}</span></div>${preview.warnings.length ? `<div class="import-warnings">${preview.warnings.map(w => `<p>ⓘ ${escape(w)}</p>`).join('')}</div>` : ''}<div class="import-table-scroll"><table class="import-preview-table"><thead><tr><th><input id="import-select-all" type="checkbox" aria-label="全选有效记录" ${preview.rows.every(r => r.selected) ? 'checked' : ''}></th><th>原行</th>${columns.map(c => `<th>${fieldLabels[c]}</th>`).join('')}<th>识别情况</th></tr></thead><tbody>${shown.map((row,i) => { const index = start+i; return `<tr data-import-row="${index}"><td><input type="checkbox" data-import-select="${index}" aria-label="导入第 ${index+1} 条" ${row.selected ? 'checked' : ''}></td><td title="${escape(row.raw)}">${row.line}</td>${columns.map(field => `<td><input data-import-index="${index}" data-import-field="${field}" aria-label="第 ${index+1} 条${fieldLabels[field]}" type="${field === 'initialCount' ? 'number' : 'text'}" ${field === 'initialCount' ? 'min="0" max="1000000" step="1"' : `maxlength="${field === 'name' || field === 'number' ? 40 : field === 'notes' ? 240 : 80}"`} value="${escape(row[field] ?? '')}"></td>`).join('')}<td class="import-row-status" data-import-status="${index}">${escape(row.duplicate ? '重复记录，默认跳过' : row.issues.join('；') || '可导入')}</td></tr>`; }).join('')}</tbody></table></div>${pages > 1 ? `<div class="import-pagination"><button id="import-prev" class="button secondary small" type="button" ${page ? '' : 'disabled'}>上一页</button><span>${page+1} / ${pages} 页 · 每页 50 条</span><button id="import-next" class="button secondary small" type="button" ${page+1 < pages ? '' : 'disabled'}>下一页</button></div>` : ''}`;
        $('import-select-all').addEventListener('change',e => { preview.rows.forEach(row => { row.selected = e.target.checked && !rowErrors(row).length && !row.duplicate; }); drawPreview(); });
        $('import-prev')?.addEventListener('click',() => { page--; drawPreview(); });
        $('import-next')?.addEventListener('click',() => { page++; drawPreview(); });
        updateSummary();
      };
      const scan = async () => {
        const source = $('import-source').value;
        if (!source.trim()) return;
        const version = ++serial; preview = null;
        $('import-submit').disabled = true; $('import-submit').textContent = '正在识别…'; $('modal-error').textContent = '';
        try {
          const result = await request('import-preview',{ source,spaceId:accounts.spaceId });
          if (serial !== version || !$('modal').open || !$('import-source')) return;
          preview = result; previewSource = source; page = 0; drawPreview();
        } catch (e) { if (version === serial && $('modal').open) { $('modal-error').textContent = e.message; $('import-submit').disabled = false; $('import-submit').textContent = '重新识别'; } }
      };
      $('import-source').addEventListener('input',() => {
        saveDraft(); clearTimeout(timer); serial++; preview = null; $('import-preview').hidden = true;
        $('import-submit').disabled = false; $('import-submit').textContent = '识别并预览'; $('import-summary').textContent = '内容已更新，正在等待识别…';
        if ($('import-source').value.trim()) timer = setTimeout(scan,350);
      });
      $('import-preview').addEventListener('change',e => {
        if (!preview) return;
        if (e.target.matches('[data-import-select]')) { preview.rows[Number(e.target.dataset.importSelect)].selected = e.target.checked; updateSummary(); }
      });
      $('import-preview').addEventListener('input',e => {
        if (!preview || !e.target.matches('[data-import-field]')) return;
        const index = Number(e.target.dataset.importIndex), row = preview.rows[index], hadIssues = row.issues.length;
        row[e.target.dataset.importField] = e.target.dataset.importField === 'initialCount' ? (e.target.value === '' ? 0 : Number(e.target.value)) : e.target.value;
        row.issues = rowErrors(row);
        row.duplicate = activeStudents().some(s => row.number && s.number ? row.number === s.number : row.name.trim() && row.name.trim() === s.name);
        if (row.issues.length || row.duplicate) row.selected = false; else if (hadIssues) row.selected = true;
        const status = document.querySelector(`[data-import-status="${index}"]`); status.textContent = row.duplicate ? '重复记录，默认跳过' : row.issues.join('；') || '可导入';
        document.querySelector(`[data-import-select="${index}"]`).checked = row.selected;
        updateSummary();
      });
      $('import-cancel').addEventListener('click',closeModal);
      $('modal').addEventListener('close',() => { clearTimeout(timer); serial++; },{ once:true });
      $('roster-file').addEventListener('change',async e => {
        const file = e.target.files[0]; if (!file) return;
        if (file.size > 1024*1024) { $('modal-error').textContent = '名单文件不能超过 1 MB'; return; }
        try {
          const bytes = await file.arrayBuffer();
          let source = new TextDecoder('utf-8',{ fatal:true }).decode(bytes);
          $('import-source').value = source;
          saveDraft(); await scan();
        } catch { $('modal-error').textContent = '文件不是 UTF-8 编码。请在 Excel 中另存为“CSV UTF-8”，或直接复制粘贴。'; }
      });
      $('import-form').addEventListener('submit',async e => {
        e.preventDefault(); clearTimeout(timer);
        if (!preview || previewSource !== $('import-source').value) { await scan(); return; }
        const selected = preview.rows.filter(row => row.selected);
        if (!selected.length) { $('modal-error').textContent = '请至少选择一条记录'; return; }
        const invalid = selected.find(row => rowErrors(row).length);
        if (invalid) { $('modal-error').textContent = `请核对原第 ${invalid.line} 行：${rowErrors(invalid).join('；')}`; return; }
        const students = selected.map(({ name,number,initialCount,department,position,group,notes }) => ({ name,number,initialCount,department,position,group,notes }));
        const result = await change('import',{ students });
        if (result) { try { sessionStorage.removeItem(draftKey); } catch {} closeModal(); setView('roster'); }
      });
      try { $('import-source').value = sessionStorage.getItem(draftKey) || ''; } catch {}
      if ($('import-source').value.trim()) scan();
    });
    $('modal').classList.add('import-modal');
  }
  function editStudent(id) {
    const student = state.students.find(s => s.id === id), total = counts().get(id);
    modal(`编辑${meta().subject}`, `<p class="modal-copy">在当前场景累计参与 ${total} 次，其中本插件记录 ${total - student.initialCount} 次。修改历史次数仅调整导入前的参与记录。</p><form class="modal-form" id="edit-form"><label>${state.scenario === 'teacher' ? '班级名称' : '姓名'}<input id="edit-name" type="text" value="${escape(student.name)}" maxlength="40" required></label><label>${meta().numberLabel}（选填）<input id="edit-number" type="text" value="${escape(student.number)}" maxlength="40"></label><div class="member-edit-grid">${[['department','部门'],['position','职位'],['group','班级 / 分组'],['notes','备注']].map(([field,label]) => `<label>${label}（选填）<input id="edit-${field}" type="text" value="${escape(student[field])}" maxlength="${field === 'notes' ? 240 : 80}"></label>`).join('')}</div><label>导入前参与次数<input id="edit-initial" type="number" value="${student.initialCount}" min="0" max="1000000" step="1" required></label><div class="modal-actions"><button class="button secondary" type="button" id="edit-cancel">取消</button><button class="button primary" type="submit">保存修改</button></div></form>`, () => {
      $('edit-cancel').addEventListener('click',closeModal);
      $('edit-form').addEventListener('submit',async e => { e.preventDefault(); const result = await change('edit',{ id, name:$('edit-name').value, number:$('edit-number').value, initialCount:Number($('edit-initial').value),...Object.fromEntries(['department','position','group','notes'].map(field => [field,$('edit-'+field).value])) }); if (result) closeModal(); });
    });
  }
  function showRename() {
    if (!state || busy) return;
    modal('场景名称', `<form class="modal-form" id="rename-form"><label>给当前抽签场景起个名字<input id="rename-name" type="text" value="${escape(state.className)}" maxlength="40" required></label><div class="modal-actions"><button class="button secondary" type="button" id="rename-cancel">取消</button><button class="button primary" type="submit">保存</button></div></form>`, () => {
      $('rename-cancel').addEventListener('click',closeModal);
      $('rename-form').addEventListener('submit',async e => { e.preventDefault(); const result = await change('rename',{ name:$('rename-name').value }); if (result) closeModal(); });
    });
  }
  function download(name, content, mime) {
    const url = URL.createObjectURL(new Blob([content],{ type:mime })); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
  }
  function showData() {
    if (!state || busy) return;
    modal('当前场景数据管理', `<p class="modal-copy">当前账号：${escape(accounts.account.displayName)} · 场景：${escape(state.className)}。备份包含当前场景的名单、历史次数和活动记录，不含账号密码。</p><div class="data-options"><div class="data-option"><div><strong>备份当前场景</strong><small>导出 JSON 文件，可完整恢复</small></div><button class="button secondary small" id="backup-data">导出备份</button></div><div class="data-option"><div><strong>从备份恢复</strong><small>只替换当前场景，不影响其他场景</small></div><button class="button secondary small" id="restore-data">选择备份</button></div><div class="data-option"><div><strong>清空当前场景名单</strong><small>保留场景名称与类型，清空次数和记录</small></div><button class="button danger small" id="reset-data">清空名单</button></div><div class="data-option"><div><strong>删除当前场景</strong><small>需至少保留一个场景</small></div><button class="button danger small" id="delete-space" ${accounts.spaces.length < 2 ? 'disabled' : ''}>删除场景</button></div></div><div class="formula-block">当前权重规则<br><code>完全随机：1<br>均衡参与：1 / (次数 + 1)<br>优先少参与：1 / (次数 + 1)²</code></div>`, () => {
      $('backup-data').addEventListener('click',() => { download(`抽签场景备份-${new Date().toISOString().slice(0,10)}.json`,JSON.stringify(state,null,2),'application/json'); toast('当前场景备份已导出'); });
      $('restore-data').addEventListener('click',() => { $('restore-file').value = ''; $('restore-file').click(); });
      $('reset-data').addEventListener('click',() => {
        closeModal(); confirmDialog('清空当前场景的名单？','只清空当前场景的名单、参与次数和活动记录。其他场景和账号不受影响。请先导出备份；清空后无法在页面撤销。','确认清空',() => change('reset'),true);
      });
      $('delete-space').addEventListener('click',() => { closeModal(); accounts.deleteCurrentSpace(); });
    });
  }
  $('restore-file').addEventListener('change',async e => {
    const file = e.target.files[0]; if (!file) return;
    try {
      if (file.size > 8*1024*1024) throw new Error('备份文件不能超过 8 MB');
      const data = JSON.parse(await file.text());
      if (data.schemaVersion !== 1 || !Array.isArray(data.students) || !Array.isArray(data.events)) throw new Error('不是有效的抽签场景备份文件');
      if ((data.scenario || 'class') !== state.scenario) throw new Error('备份类型与当前场景不同，请先新建同类型场景后恢复');
      closeModal(); confirmDialog('恢复这份场景备份？',`即将用“${data.className || '未命名场景'}”的 ${data.students.length} 个档案和 ${data.events.length} 条活动记录替换当前场景。建议先备份当前数据。`,'确认恢复',() => change('restore',{ data }));
    } catch (err) { if ($('modal-error')) $('modal-error').textContent = err.message; else report(err.message); }
  });
  $('export-roster').addEventListener('click',() => {
    if (!state) return;
    const map = counts();
    // Avoid spreadsheet formula evaluation when user-controlled text is exported.
    const csv = v => '"' + String(/^[=+\-@\t\r]/.test(String(v)) ? "'" + v : v).replaceAll('"','""') + '"';
    const lines = [['名称',meta().numberLabel,'部门','职位','班级 / 分组','备注','累计参与次数','导入前参与次数','参与状态'],...activeStudents().map(s => [s.name,s.number,s.department || '',s.position || '',s.group || '',s.notes || '',map.get(s.id),s.initialCount,s.enabled ? '参与抽选' : '暂停'])];
    download('场景参与统计.csv','\uFEFF' + lines.map(row => row.map(csv).join(',')).join('\r\n'),'text/csv;charset=utf-8');
  });
  document.querySelectorAll('[data-view]').forEach(el => el.addEventListener('click',() => setView(el.dataset.view)));
  document.querySelector('.brand').addEventListener('click',e => { e.preventDefault(); setView('draw'); });
  $('import-top').addEventListener('click',showImport); $('class-button').addEventListener('click',showRename); $('data-button').addEventListener('click',showData);
  $('modal-close').addEventListener('click',closeModal);
  $('modal').addEventListener('cancel',e => { if (busy) e.preventDefault(); });
  $('modal').addEventListener('click',e => { if (e.target === $('modal')) { const rect = e.target.getBoundingClientRect(); if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) closeModal(); } });
  $('student-search').addEventListener('input',() => { if (state) renderRoster(); }); $('student-sort').addEventListener('change',() => { if (state) renderRoster(); });
  $('count-minus').addEventListener('click',() => { $('draw-count').value = Math.max(1, (Number($('draw-count').value) || 1) - 1); rulesUI.refreshStatus(); });
  $('count-plus').addEventListener('click',() => { $('draw-count').value = Math.min(2000, (Number($('draw-count').value) || 1) + 1); rulesUI.refreshStatus(); });
  $('draw-count').addEventListener('input',() => rulesUI.refreshStatus());
  document.querySelectorAll('input[name=strength]').forEach(el => el.addEventListener('change',updateStrategy));
  $('roster-body').addEventListener('click',e => {
    const button = e.target.closest('button[data-action]'); if (!button || busy) return;
    const id = button.dataset.id;
    if (button.dataset.action === 'toggle') change('toggle',{ id });
    if (button.dataset.action === 'edit') editStudent(id);
    if (button.dataset.action === 'remove') {
      const s = state.students.find(x => x.id === id);
      confirmDialog(`移除${meta().subject}？`,`将“${s.name}”从当前场景的名单移除。过往活动会保留对应名称，之后不会再抽中。`,'确认移除',() => change('remove',{ id }),true);
    }
  });
  $('history-list').addEventListener('click',e => {
    const button = e.target.closest('[data-undo]'); if (!button || busy) return;
    confirmDialog('撤销这次活动？','此活动中每个抽签对象的参与次数将减少 1 次，权重随之恢复。仅影响当前场景，活动保留为“已撤销”记录。','确认撤销',() => change('undo',{ id:button.dataset.undo }));
  });
  // Pull external-window changes only when idle, so drafts in an open modal are not overwritten.
  window.addEventListener('focus',async () => {
    if (!state || busy || drawing || $('modal').open) return;
    try { await accounts.refresh(accounts.spaceId); } catch (e) { if (accounts.account) report(e.message); else $('auth-error').textContent = e.message; }
  });
  rulesUI = new PickerRules({ getState:() => state,getCount:() => Number($('draw-count').value),getStrength:strength,isBusy:() => busy || drawing,modal,closeModal,save:rules => change('settings',{ count:Number($('draw-count').value),strength:strength(),rules }) });
  accounts = new window.PickerAccounts({ request,modal,closeModal,notify:toast,setBusy,isBusy:() => busy || drawing,receive(next) {
    const changed = displayedSpace !== accounts.spaceId;
    const preserveSetup = !changed && state?.revision === next?.revision;
    state = next; confirmed = null;
    if (!next) { displayedSpace = null; drawing = false; for (const id of ['roster-body','history-list','recent-events','draw-stage','draw-actions']) $(id).replaceChildren(); return; }
    if (changed) { displayedSpace = accounts.spaceId; $('activity-name').value = ''; $('student-search').value = ''; $('student-sort').value = 'default'; view = 'draw'; $('error-banner').hidden = true; }
    render(preserveSetup); setView(view);
  } });
  async function init() {
    if (!token) { $('auth-error').textContent = '请从 Harness 的“抽签工作台”入口打开，或使用启动脚本打印的完整预览地址。'; $('auth-submit').disabled = true; return; }
    try { await accounts.refresh(); }
    catch (e) { $('auth-error').textContent = e.message; }
  }
  init();
})();
