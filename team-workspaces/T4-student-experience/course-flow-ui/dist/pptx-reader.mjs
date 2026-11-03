// 只在浏览器中读取 OOXML 内容，不执行宏，不访问演示文稿中的外部链接。
const DRAWING=new Set(['http://schemas.openxmlformats.org/drawingml/2006/main','http://purl.oclc.org/ooxml/drawingml/main']);
const PRESENTATION=new Set(['http://schemas.openxmlformats.org/presentationml/2006/main','http://purl.oclc.org/ooxml/presentationml/main']);
const elements=node=>Array.from(node.childNodes||[]).filter(child=>child.nodeType===1);
const descendants=(node,name)=>Array.from(node.getElementsByTagNameNS('*',name));

export function resolvePartPath(source,target){
  if(!target||/^[a-z][a-z0-9+.-]*:|^\/\//i.test(target)||/[?#\0\\]/.test(target))throw Error('PPTX 包含无法读取的文件关系。');
  let value;try{value=decodeURIComponent(target);}catch{throw Error('PPTX 文件关系路径无效。');}
  if(/[?#\0\\]/.test(value))throw Error('PPTX 文件关系路径无效。');
  const parts=value.startsWith('/')?[]:source.split('/').slice(0,-1);
  for(const part of value.split('/')){
    if(!part||part==='.')continue;
    if(part==='..'){if(!parts.length)throw Error('PPTX 文件关系超出包内范围。');parts.pop();}
    else parts.push(part);
  }
  return parts.join('/');
}
const relsPath=part=>{const parts=part.split('/'),name=parts.pop();return [...parts,'_rels',name+'.rels'].join('/');};
const relationshipId=node=>Array.from(node.attributes).find(a=>a.localName==='id'&&/relationships$/.test(a.namespaceURI||''))?.value;

function paragraphText(node){
  if(node.nodeType!==1)return '';
  if(DRAWING.has(node.namespaceURI)&&node.localName==='t')return node.textContent;
  if(DRAWING.has(node.namespaceURI)&&node.localName==='br')return '\n';
  if(DRAWING.has(node.namespaceURI)&&node.localName==='tab')return '\t';
  return elements(node).map(paragraphText).join('');
}
function contentBlocks(node,notes=false){
  if(node.nodeType!==1)return [];
  if(notes&&PRESENTATION.has(node.namespaceURI)&&node.localName==='sp'){
    const placeholder=descendants(node,'ph')[0];
    if(placeholder&&placeholder.getAttribute('type')!=='body')return [];
  }
  if(DRAWING.has(node.namespaceURI)&&node.localName==='p'){
    const text=paragraphText(node).trim();return text?[text]:[];
  }
  if(DRAWING.has(node.namespaceURI)&&node.localName==='tbl'){
    const rows=elements(node).filter(child=>child.localName==='tr').map(row=>elements(row).filter(child=>child.localName==='tc').map(cell=>contentBlocks(cell,notes).join(' / ')).join(' | '));
    return rows.some(row=>row.replace(/[|\s]/g,''))?['【表格】\n'+rows.join('\n')]:[];
  }
  if(node.localName==='AlternateContent'){
    const branch=elements(node).find(child=>child.localName==='Choice')||elements(node).find(child=>child.localName==='Fallback');
    return branch?contentBlocks(branch,notes):[];
  }
  return elements(node).flatMap(child=>contentBlocks(child,notes));
}

export async function readPPTX(bytes,onProgress=()=>{}){
  const input=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);
  if(input.byteLength>10*1024*1024)throw Error('PPTX 超过 10 MB，请精简或拆分后导入。');
  if(input[0]===0xd0&&input[1]===0xcf)throw Error('这是旧版 PPT 或受密码保护的文件，请解除密码并另存为 PPTX，或导出 PDF。');
  if(!globalThis.JSZip)throw Error('演示文稿读取组件尚未就绪，请刷新后重试。');
  let archive;try{archive=await globalThis.JSZip.loadAsync(input);}catch(error){throw Error(/encrypt|password/i.test(error.message)?'演示文稿受密码保护，请解除密码后重试。':'演示文稿无法打开，文件可能损坏或并非 PPTX。');}
  let totalXML=0;
  async function xml(path,required=true){
    const entry=archive.file(path);
    if(!entry){if(required)throw Error('PPTX 内容不完整，缺少 '+path+'。');return null;}
    const text=await entry.async('string');totalXML+=text.length;
    if(text.length>8000000||totalXML>24000000)throw Error('PPTX 文字内容过大，请拆分后导入。');
    if(/<!DOCTYPE|<!ENTITY/i.test(text))throw Error('PPTX 内部 XML 结构不受支持，请另存为新文件后重试。');
    const doc=new DOMParser().parseFromString(text,'application/xml');
    if(descendants(doc,'parsererror').length)throw Error('PPTX 内部 XML 无法解析，请重新另存文件。');
    return doc;
  }
  function relationships(doc){return doc?descendants(doc,'Relationship').map(node=>({id:node.getAttribute('Id'),type:node.getAttribute('Type'),target:node.getAttribute('Target'),external:node.getAttribute('TargetMode')==='External'})):[];}
  const rootRelationships=relationships(await xml('_rels/.rels',false));
  const mainRelation=rootRelationships.find(rel=>rel.type.endsWith('/officeDocument'));
  if(mainRelation?.external)throw Error('PPTX 的主文件不能是外部链接。');
  const main=mainRelation?resolvePartPath('',mainRelation.target):'ppt/presentation.xml';
  const presentation=await xml(main);
  if(presentation.documentElement.localName!=='presentation'||!PRESENTATION.has(presentation.documentElement.namespaceURI))throw Error('文件不是可读取的 PowerPoint 演示文稿。');
  const links=relationships(await xml(relsPath(main)));
  const slides=descendants(presentation,'sldId').filter(node=>PRESENTATION.has(node.namespaceURI));
  if(!slides.length)throw Error('演示文稿没有幻灯片。');
  if(slides.length>200)throw Error('PPTX 超过 200 页，请拆分后导入。');
  const pages=[],emptyPages=[],imagePages=[],graphicPages=[],hiddenPages=[];let readable=false,notesCount=0;
  for(let index=0;index<slides.length;index++){
    const number=index+1;onProgress(number,slides.length);
    const link=links.find(rel=>rel.id===relationshipId(slides[index])&&rel.type.endsWith('/slide'));
    if(!link||link.external)throw Error('第 '+number+' 页的文件关系缺失或无效。');
    const path=resolvePartPath(main,link.target),slide=await xml(path);
    if(slide.documentElement.localName!=='sld')throw Error('第 '+number+' 页内容不是幻灯片。');
    const body=contentBlocks(slide.documentElement).join('\n');
    const hidden=['0','false'].includes(slide.documentElement.getAttribute('show'));
    if(hidden)hiddenPages.push(number);
    if(!body)emptyPages.push(number);
    if(descendants(slide,'pic').length)imagePages.push(number);
    if(descendants(slide,'chart').length||descendants(slide,'relIds').length)graphicPages.push(number);
    const slideLinks=relationships(await xml(relsPath(path),false));
    const notesLink=slideLinks.find(rel=>rel.type.endsWith('/notesSlide'));let notes='';
    if(notesLink){
      if(notesLink.external)throw Error('第 '+number+' 页备注指向外部文件，无法读取。');
      const notesDocument=await xml(resolvePartPath(path,notesLink.target));
      notes=contentBlocks(notesDocument.documentElement,true).join('\n');
      if(notes)notesCount++;
    }
    if(body||notes)readable=true;
    pages.push(`【第 ${number} 页${hidden?'（隐藏页）':''}】\n${body||'（页面未检测到可读取文字）'}${notes?'\n【演讲者备注】\n'+notes:''}`);
  }
  if(!readable)throw Error('演示文稿中未找到可读取的文字，可能是图片型课件。请先完成 OCR，或粘贴已识别的要求。');
  const warnings=[];
  const pageList=pages=>pages.slice(0,20).join('、')+(pages.length>20?' 等':'' );
  if(emptyPages.length)warnings.push(`第 ${pageList(emptyPages)} 页未检测到页面文字，请核对图片、空白页或备注中的要求。`);
  if(imagePages.length)warnings.push(`第 ${pageList(imagePages)} 页含图片，图片中的文字尚未识别，请对照原件核对或先做 OCR。`);
  if(graphicPages.length)warnings.push(`第 ${pageList(graphicPages)} 页含图表或 SmartArt，其内部内容未完整提取，请对照原件核对。`);
  if(hiddenPages.length)warnings.push(`第 ${pageList(hiddenPages)} 页是隐藏页，已单独标注，请核对要求是否仍适用。`);
  return {text:pages.join('\n\n'),pageCount:slides.length,notesCount,warnings};
}
