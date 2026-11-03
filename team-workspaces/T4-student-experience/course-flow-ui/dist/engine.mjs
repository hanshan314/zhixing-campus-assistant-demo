export const PRIORITY=['class_meeting','competition_project','field_practice','group_assignment','lab_practice','academic_writing','exam_review','career','presentation','application','administrative'];
export const STATUS={pending:'待办',completed:'已完成',deleted:'删除'};
export function todayShanghai(){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());}
export function addDays(value,amount){const d=new Date(value+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+amount);return d.toISOString().slice(0,10);}
export function daysBetween(a,b){return Math.round((new Date(b+'T00:00:00Z')-new Date(a+'T00:00:00Z'))/86400000);}
export function groupTimelineRows(rows,today=todayShanghai()){
  const weekday=new Date(today+'T00:00:00Z').getUTCDay();
  const weekEnd=addDays(today,(7-weekday)%7),nextWeekEnd=addDays(weekEnd,7),tomorrow=addDays(today,1);
  const groups=[
    {key:'past',title:'此前',description:addDays(today,-1)+' 及之前'},
    {key:'today',title:'今天',description:today},
    {key:'tomorrow',title:'明天',description:tomorrow},
    {key:'this-week',title:'本周',description:'截至 '+weekEnd+'，今天和明天单独列出'},
    {key:'next-week',title:'下周',description:addDays(weekEnd,1)+' 至 '+nextWeekEnd+'，明天单独列出'},
    {key:'later',title:'更晚',description:addDays(nextWeekEnd,1)+' 及以后'},
    {key:'undated',title:'日期待定',description:'尚无有效的建议完成日期'}
  ].map(group=>({...group,rows:[]}));
  const byKey=Object.fromEntries(groups.map(group=>[group.key,group]));
  const dateOf=row=>row.t.planning?.finish_on;
  const validDate=date=>typeof date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(date)&&Number.isFinite(Date.parse(date+'T00:00:00Z'))&&new Date(date+'T00:00:00Z').toISOString().slice(0,10)===date;
  for(const row of rows){
    const date=dateOf(row),valid=validDate(date);
    const key=!valid?'undated':date<today?'past':date===today?'today':date===tomorrow?'tomorrow':date<=weekEnd?'this-week':date<=nextWeekEnd?'next-week':'later';
    byKey[key].rows.push(row);
  }
  const dateKey=date=>validDate(date)?date:'9999';
  for(const group of groups)group.rows.sort((a,b)=>dateKey(dateOf(a)).localeCompare(dateKey(dateOf(b)))||dateKey(a.t.planning?.start_on).localeCompare(dateKey(b.t.planning?.start_on))||dateKey(a.p.deadline).localeCompare(dateKey(b.p.deadline)));
  return groups.filter(group=>group.rows.length);
}
export function detect(text,catalog){
  const positive=text.replace(/(?:无需|不需要|不用|不必|不要求|禁止|不得)[^。\n；;，,]{0,60}/g,'');
  let matches=[];
  for(const [type,item] of Object.entries(catalog)){
    if(['information_only','general'].includes(type))continue;
    const hits=[...positive.matchAll(new RegExp(item.pattern,'gi'))];
    if(hits.length)matches.push({type,label:item.name,evidence:[...new Set(hits.map(x=>x[0]))].slice(0,5)});
  }
  matches.sort((a,b)=>PRIORITY.indexOf(a.type)-PRIORITY.indexOf(b.type));
  let types=matches.map(x=>x.type);
  if(types.includes('class_meeting'))types=types.filter(x=>x!=='presentation');
  if(!types.length)types=[/仅供知悉|仅供了解|无需办理/.test(text)?'information_only':'general'];
  return {types,matches,role:/仅(?:需)?参加|只需参会|仅参会|只(?:需)?参加/.test(text)?'participant':'unknown'};
}
export function composeStages(types,role,catalog,definitions){
  const keys=[];
  for(const type of types){const selected=type==='class_meeting'&&role==='participant'?['brief','resources','event','archive']:catalog[type].stages;for(const key of selected)if(!keys.includes(key))keys.push(key);}
  const graph=Object.fromEntries(keys.map(k=>[k,definitions[k][2].filter(x=>keys.includes(x))]));
  if(graph.resources)graph.resources.push(...['grouping','topic'].filter(x=>keys.includes(x)));
  if(graph.analysis&&keys.includes('fieldwork'))graph.analysis=['fieldwork'];
  if(graph.draft)graph.draft.push(...['outline','analysis'].filter(x=>keys.includes(x)));
  if(graph.slides&&keys.includes('draft'))graph.slides.push('draft');
  if(graph.forms)graph.forms=keys.includes('eligibility')?['eligibility']:['brief'];
  if(graph.rehearsal&&keys.includes('materials'))graph.rehearsal.push('materials');
  if(graph.quality)graph.quality=keys.filter(x=>!['quality','delivery','event','archive'].includes(x));
  if(graph.event)graph.event=[['quality','rehearsal','resources','brief'].find(x=>keys.includes(x))];
  const ordered=[],remaining=new Set(keys);
  while(remaining.size){const ready=keys.filter(x=>remaining.has(x)&&graph[x].every(d=>ordered.includes(d)));if(!ready.length)throw Error('流程依赖需要核对，请调整类型组合。');for(const key of ready){ordered.push(key);remaining.delete(key);}}
  return ordered.map(id=>({id,title:definitions[id][0],weight:definitions[id][1],depends_on:[...new Set(graph[id])]}));
}
export function schedule(stages,today,deadline,eventDate,defaultDays=7){
  if(!stages.length)return {tasks:[],warnings:['此通知仅供知悉，不生成额外任务。']};
  const anchor=[deadline,eventDate].filter(Boolean).sort()[0]||addDays(today,defaultDays-1),end=anchor<today?today:anchor;
  const warnings=[];
  if(!deadline&&!eventDate)warnings.push('尚无正式截止，时间表为可调整的建议，不会写入正式截止日历。');
  if(anchor<today)warnings.push('原期限已过，当前时间表仅为补救建议。');
  const production=stages.filter(x=>!['event','archive'].includes(x.id));
  const span=daysBetween(today,end),total=production.reduce((a,b)=>a+b.weight,0)||1;
  if(production.length>span+1)warnings.push('可用日期较紧，部分步骤需同日完成，请核对实际空闲时间。');
  let consumed=0;
  const tasks=production.map(x=>{const start=addDays(today,Math.floor(span*consumed/total));consumed+=x.weight;return {...x,planning:{start_on:start,finish_on:addDays(today,Math.floor(span*consumed/total))},status:'pending',evidence:[]};});
  for(const x of stages.filter(x=>['event','archive'].includes(x.id))){const when=eventDate?addDays(eventDate,x.id==='archive'?1:0):null;tasks.push({...x,planning:{start_on:when,finish_on:when},status:'pending',evidence:[]});}
  return {tasks,warnings};
}
export function progress(project){const active=project.tasks.filter(t=>t.status!=='cancelled'&&(!t.deleted_at||t.status==='completed')),cleared=Number.isSafeInteger(project.purged_completed_count)&&project.purged_completed_count>0?project.purged_completed_count:0;return {done:active.filter(t=>t.status==='completed').length+cleared,total:active.length+cleared};}
export function visibleProjects(projects){return projects.filter(project=>!project.deleted_at);}
export function normalizeProjectState(project,at=new Date().toISOString()){
  for(const task of project.tasks){
    if(['pending','completed'].includes(task.status))continue;
    const previous=task.status;
    if(['cancelled','deleted'].includes(previous))task.deleted_at=task.deleted_at||at;
    task.status='pending';
    task.history=[...(task.history||[]),{action:'status_migrated',previous_status:previous,status:task.status,at}];
  }
  return project;
}
export function setTaskStatus(project,taskId,status,at=new Date().toISOString()){
  const task=project.tasks.find(task=>task.id===taskId);
  if(project.deleted_at||!task||task.deleted_at)throw Error('请先恢复已删除的任务。');
  if(!['pending','completed'].includes(status))throw Error('任务状态仅支持待办和已完成。');
  if(task.status===status)return task;
  task.status=status;
  task.history=[...(task.history||[]),{status,action:'user_status',at}];
  if(status==='completed')task.progress_evidence=task.progress_evidence||'本人在网页中标记为已完成。';
  return task;
}
export function deleteProject(projects,projectId,at=new Date().toISOString()){
  const project=projects.find(project=>project.id===projectId);
  if(!project||project.deleted_at)throw Error('未找到可删除的大任务。');
  project.deleted_at=at;
  project.history=[...(project.history||[]),{action:'deleted',at}];
  return project;
}
export function restoreProject(projects,projectId,at=new Date().toISOString()){
  const project=projects.find(project=>project.id===projectId);
  if(!project?.deleted_at)throw Error('未找到可恢复的大任务。');
  delete project.deleted_at;
  project.history=[...(project.history||[]),{action:'restored',at}];
  return project;
}
export function purgeProjectTrash(projects,projectIds){
  const selected=new Set(projectIds),removed=projects.filter(project=>project.deleted_at&&selected.has(project.id));
  const removedIds=new Set(removed.map(project=>project.id));
  return {projects:projects.filter(project=>!removedIds.has(project.id)),removedProjects:removed.length,removedTasks:removed.reduce((total,project)=>total+project.tasks.length,0)};
}
export function purgeTaskTrash(project,taskIds,at=new Date().toISOString()){
  if(project.deleted_at)return {removedTasks:0,completedTasks:0};
  const selected=new Set(taskIds),removed=project.tasks.filter(task=>task.deleted_at&&selected.has(task.id));
  if(!removed.length)return {removedTasks:0,completedTasks:0};
  const removedIds=new Set(removed.map(task=>task.id)),completed=removed.filter(task=>task.status==='completed').length;
  const previousCount=Number.isSafeInteger(project.purged_completed_count)&&project.purged_completed_count>0?project.purged_completed_count:0;
  project.purged_completed_count=previousCount+completed;
  project.tasks=project.tasks.filter(task=>!removedIds.has(task.id)).map(task=>({...task,depends_on:(task.depends_on||[]).filter(id=>!removedIds.has(id))}));
  project.history=[...(project.history||[]),{action:'task_trash_cleared',removed_count:removed.length,completed_count:completed,at}];
  return {removedTasks:removed.length,completedTasks:completed};
}
export function visibleTasks(project){return project.tasks.filter(task=>!task.deleted_at);}
export function deleteTask(project,taskId,at=new Date().toISOString()){
  const task=project.tasks.find(task=>task.id===taskId);
  if(project.deleted_at||!task||task.deleted_at)throw Error('未找到可删除的任务。');
  task.deleted_at=at;
  task.history=[...(task.history||[]),{action:'deleted',at}];
  return task;
}
export function deleteCompletedTask(project,taskId,at=new Date().toISOString()){
  const task=project.tasks.find(task=>task.id===taskId);
  if(!task||task.status!=='completed'||task.deleted_at)throw Error('只能删除列表中已完成的任务。');
  return deleteTask(project,taskId,at);
}
export function restoreDeletedTask(project,taskId,at=new Date().toISOString()){
  const task=project.tasks.find(task=>task.id===taskId);
  if(!task?.deleted_at)throw Error('未找到可恢复的已删除任务。');
  delete task.deleted_at;
  task.history=[...(task.history||[]),{action:'restored',at}];
  return task;
}
export function taskState(task){return task.deleted_at?STATUS.deleted:task.status==='completed'?STATUS.completed:STATUS.pending;}
export function needsPPT(context,catalog){
  const text=context.sourceText||context.text||'',types=context.types||[];
  if(types.includes('class_meeting')&&context.role==='participant'&&!types.includes('presentation'))return false;
  const positive=text.replace(/(?:无需|不需要|不用|不必|不要求|禁止|不得)[^。\n；;，,]{0,60}/g,'');
  const explicit=[...positive.matchAll(new RegExp(catalog.presentation.pattern,'gi'))].some(x=>/PPT|PowerPoint|幻灯片|演示文稿/i.test(x[0]));
  if(explicit)return true;
  if(/(?:无需|不需要|不用|不必|不要求)[^。\n；;，,]{0,24}(?:PPT|PowerPoint|幻灯片|演示文稿)/i.test(text))return false;
  return types.includes('presentation')||types.includes('class_meeting')||types.includes('competition_project')&&/路演|答辩/.test(positive);
}
export function adaptPPTStages(stages,required){return required?stages:stages.filter(x=>x.id!=='slides').map(x=>({...x,depends_on:x.depends_on.filter(id=>id!=='slides')}));}
export function buildPPTPrompt(context,catalog,spec){
  if(!needsPPT(context,catalog))return '';
  const text=context.sourceText||context.text||'',types=context.types||[];
  const match=pattern=>text.match(pattern)?.slice(1).find(Boolean);
  const topic=context.topic||match(/(?:主题|题目|选题)[：:为是]*\s*[“「"]([^”」"]+)[”」"]|[“"]([^”"]+)[”"]主题班会/i)||'待确认';
  const audience=context.audience||match(/(?:面向|听众[：:]?|参会对象[：:]?|汇报对象[：:]?)\s*([^，。；;\n]{2,40})/i)||'待确认';
  const duration=context.duration||match(/((?:约|不少于|不超过)?\s*\d+\s*(?:[-—~～至]\s*\d+\s*)?(?:分钟|min))/i)||'未规定，需核对；建议时长须单独标注';
  const pages=context.pages||match(/(?:PPT|PowerPoint|幻灯片|演示文稿|页数)[^。\n；;，,]{0,12}?((?:约|不少于|不超过|至少|最多)?\s*\d+\s*(?:[-—~～至]\s*\d+\s*)?(?:页|张))/i)||'未规定，按实际内容提出建议并说明依据';
  const role=({organizer:'组织者或负责人',participant:'参与者',unknown:'待确认'})[context.role]||'待确认';
  const lines=['# PPT生成提示词','',spec.intro,'','## 已知信息','',`事项：${context.title||'待确认'}`,`主题或选题：${topic}`,`流程类型：${types.map(k=>catalog[k].name).join(' + ')}`,`本人角色：${role}`,`听众：${audience}`,`时长：${duration}`,`页数：${pages}`,`已知提交截止：${context.deadline||'待确认'}（未提供的具体时刻不补写）`,`实际活动日期：${context.eventDate||context.event_date||'待确认'}`,'','## 场景要求',''];
  const selected=[['class_meeting','meeting'],['group_assignment','group'],['academic_writing','academic'],['competition_project','competition']].filter(([kind])=>types.includes(kind)).map(([,key])=>spec[key]);
  lines.push(...(selected.length?selected:[spec.general]),'','## 制作与验收要求','',...spec.requirements.map((value,i)=>`${i+1}. ${value}`),'','## 原始文件内容','',spec.source_note,'',text||'原始正文未提供，需补充后核对。');
  return lines.join('\n')+'\n';
}
export function makeICS(projects,now=new Date()){
  const escape=x=>String(x).replace(/\\/g,'\\\\').replace(/\n/g,'\\n').replace(/;/g,'\\;').replace(/,/g,'\\,');
  let lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Campus Flow//CN','CALSCALE:GREGORIAN'];
  for(const p of visibleProjects(projects).filter(p=>p.deadline&&progress(p).done<progress(p).total))lines.push('BEGIN:VEVENT',`UID:${p.id}@campus-flow.local`,`DTSTAMP:${now.toISOString().replace(/[-:]/g,'').replace(/\.\d+Z/,'Z')}`,`DTSTART;VALUE=DATE:${p.deadline.replace(/-/g,'')}`,`SUMMARY:${escape('[截止] '+p.title)}`,'TRANSP:TRANSPARENT','DESCRIPTION:'+escape('课序工作流记录的截止日期。阶段安排为建议，具体截止时刻尚未记录。'),'END:VEVENT');
  lines.push('END:VCALENDAR');
  const enc=new TextEncoder();return lines.map(line=>{let current='',parts=[];for(const c of line){if(enc.encode(current+c).length>75){parts.push(current);current=' ';}current+=c;}return [...parts,current].join('\r\n');}).join('\r\n')+'\r\n';
}
