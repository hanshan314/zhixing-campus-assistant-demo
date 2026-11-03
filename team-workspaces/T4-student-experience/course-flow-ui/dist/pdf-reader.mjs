// PDF 在浏览器内读取；文件与密码不会发送到服务端。
export function textFromItems(items){
  const lines=[];let line='',lastY=null;
  for(const item of items){
    if(typeof item.str!=='string')continue;
    const y=item.transform?.[5];
    if(line&&lastY!==null&&Number.isFinite(y)&&Math.abs(y-lastY)>3){lines.push(line.trim());line='';}
    const previous=line.at(-1)||'',next=item.str[0]||'';
    const join=line&&!/\s/.test(previous)&&!/[\u3400-\u9fff]/.test(previous)&&!/[\u3400-\u9fff，。；：！？]/.test(next)?' ':'';
    line+=join+item.str;
    if(Number.isFinite(y))lastY=y;
    if(item.hasEOL&&line){lines.push(line.trim());line='';lastY=null;}
  }
  if(line.trim())lines.push(line.trim());
  return lines.filter(Boolean).join('\n');
}

export async function readPDF(bytes,onProgress=()=>{}){
  const pdfjs=await import('./vendor/pdfjs/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc=new URL('./vendor/pdfjs/pdf.worker.min.mjs',import.meta.url).href;
  const task=pdfjs.getDocument({data:new Uint8Array(bytes),
    cMapUrl:new URL('./vendor/pdfjs/cmaps/',import.meta.url).href,cMapPacked:true,
    standardFontDataUrl:new URL('./vendor/pdfjs/standard_fonts/',import.meta.url).href,
    wasmUrl:new URL('./vendor/pdfjs/wasm/',import.meta.url).href,isEvalSupported:false});
  let document;
  try{
    document=await task.promise;
    if(document.numPages>200)throw Error('PDF 超过 200 页，请拆分后导入。');
    const pages=[],emptyPages=[];
    for(let number=1;number<=document.numPages;number++){
      onProgress(number,document.numPages);
      const page=await document.getPage(number);
      const content=await page.getTextContent();
      const text=textFromItems(content.items);
      if(!text.trim())emptyPages.push(number);
      pages.push(`【第 ${number} 页】\n${text}`);
      page.cleanup();
    }
    if(emptyPages.length===document.numPages)throw Error('这份 PDF 没有可提取的文字层，可能是扫描件。请先完成 OCR，或粘贴识别后的正文再继续。');
    return {text:pages.join('\n\n'),pageCount:document.numPages,emptyPages,
      warnings:emptyPages.length?[`第 ${emptyPages.join('、')} 页未提取到文字，可能包含扫描图片或空白页，需核对后补充正文。`]:[]};
  }catch(error){
    if(error.name==='PasswordException')throw Error('这份 PDF 已加密，请先解密后导入未加密副本。');
    if(['InvalidPDFException','MissingPDFException','UnexpectedResponseException'].includes(error.name))throw Error('PDF 文件损坏或格式不完整，请重新导出后再试。');
    throw error;
  }finally{await (document?document.destroy():task.destroy()).catch(()=>{});}
}
