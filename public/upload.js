(() => {
  const $ = id => document.getElementById(id);
  const els = {
    gate:$('uploadGate'), workspace:$('uploadWorkspace'), gateForm:$('uploadGateForm'), password:$('uploadPassword'), unlock:$('uploadUnlockBtn'), gateError:$('uploadGateError'),
    lock:$('uploadLockBtn'), folder:$('uploadFolderInput'), summary:$('uploadSummary'), progress:$('uploadProgress'), progressText:$('uploadProgressText'), start:$('uploadStartBtn'), toast:$('toast'),
  };
  let uploadPassword = '';
  let uploadLimits = { maxChunkBytes:8*1024*1024, maxFileBytes:300*1024*1024 };

  const headerValue = value => encodeURIComponent(String(value ?? ''));
  const humanBytes = bytes => { const units=['Б','КБ','МБ','ГБ']; let value=Number(bytes||0),i=0; while(value>=1024&&i<units.length-1){value/=1024;i++;} return `${value.toFixed(i?1:0)} ${units[i]}`; };
  function toast(message,error=false){els.toast.textContent=message;els.toast.classList.toggle('error',error);els.toast.classList.remove('hidden');clearTimeout(toast.timer);toast.timer=setTimeout(()=>els.toast.classList.add('hidden'),4000);}
  async function adminFetch(url, options={}) {
    const headers={...(options.headers||{}),'x-upload-password':headerValue(uploadPassword)};
    const isBinary=options.body instanceof Blob || options.body instanceof ArrayBuffer || ArrayBuffer.isView(options.body);
    if(options.body && !isBinary && !headers['Content-Type'])headers['Content-Type']='application/json';
    const res=await fetch(url,{...options,headers,credentials:'same-origin'});
    const type=res.headers.get('content-type')||'';
    const data=type.includes('application/json')?await res.json():await res.text();
    if(!res.ok){const err=new Error(data?.error||data||`HTTP ${res.status}`);err.status=res.status;if(data?.expectedOffset!=null)err.expectedOffset=Number(data.expectedOffset);throw err;}
    return data;
  }
  function selectedUploadFiles(){
    const files=[...els.folder.files];
    if(!files.length)throw new Error('Выберите корневую папку проекта');
    const supported=/\.(jpe?g|png|webp|heic)$/i;
    const usable=files.filter(file=>supported.test(file.name)&&!/_thumb(?:\s*\(\d+\))?/i.test(file.name));
    if(!usable.length)throw new Error('В выбранной папке нет поддерживаемых фотографий');
    const roots=new Set(usable.map(file=>(file.webkitRelativePath||file.name).replace(/\\/g,'/').split('/').filter(Boolean)[0]));
    if(roots.size!==1)throw new Error('Не удалось определить единую корневую папку');
    const rootName=[...roots][0];
    return usable.map(file=>{
      const raw=(file.webkitRelativePath||file.name).replace(/\\/g,'/');
      const parts=raw.split('/').filter(Boolean);
      if(parts[0]===rootName)parts.shift();
      if(parts.length<2)throw new Error('Выберите папку проекта, а не отдельный зал');
      if(['raw','Люди','Оборудование'].includes(parts[0]))throw new Error('Выберите корневую папку проекта, внутри которой находятся залы');
      return {file,relativePath:parts.join('/')};
    });
  }
  function lock(){uploadPassword='';els.password.value='';els.workspace.classList.add('hidden');els.gate.classList.remove('hidden');els.folder.value='';els.summary.textContent='Папка не выбрана';els.progress.value=0;els.progressText.textContent='';els.start.disabled=true;setTimeout(()=>els.password.focus(),0);}
  async function unlock(){
    els.gateError.classList.add('hidden');
    const candidate=els.password.value;
    if(!candidate)throw new Error('Введите пароль загрузки');
    uploadPassword=candidate;els.unlock.disabled=true;
    try{uploadLimits=await adminFetch('/api/admin/upload/verify',{method:'POST',body:'{}'});els.gate.classList.add('hidden');els.workspace.classList.remove('hidden');}
    catch(err){uploadPassword='';els.gateError.textContent=err.message;els.gateError.classList.remove('hidden');throw err;}
    finally{els.unlock.disabled=false;}
  }
  async function startUpload(){
    const entries=selectedUploadFiles();
    const chunkSize=Math.min(Number(uploadLimits.maxChunkBytes||8*1024*1024),8*1024*1024);
    const totalBytes=entries.reduce((sum,item)=>sum+item.file.size,0);let doneBytes=0,doneFiles=0;
    els.start.disabled=true;els.start.dataset.busy='1';els.folder.disabled=true;
    const update=()=>{const pct=totalBytes?Math.min(100,doneBytes/totalBytes*100):0;els.progress.value=pct;els.progressText.textContent=`${doneFiles}/${entries.length} файлов · ${humanBytes(doneBytes)} / ${humanBytes(totalBytes)} · ${pct.toFixed(1)}%`;};
    update();
    try{
      for(const entry of entries){
        if(entry.file.size>Number(uploadLimits.maxFileBytes||Infinity))throw new Error(`Слишком большой файл: ${entry.relativePath}`);
        const encoded=encodeURIComponent(entry.relativePath);
        let status=await adminFetch(`/api/admin/upload/status?path=${encoded}&total=${entry.file.size}`,{method:'GET'});
        if(status.conflict)throw new Error(`Файл уже существует с другим размером: ${entry.relativePath}`);
        let offset=Number(status.received||0);doneBytes+=offset;
        if(status.complete){doneFiles++;update();continue;}
        while(offset<entry.file.size){
          const end=Math.min(entry.file.size,offset+chunkSize);const blob=entry.file.slice(offset,end);
          try{const result=await adminFetch(`/api/admin/upload/chunk?path=${encoded}&total=${entry.file.size}&offset=${offset}`,{method:'PUT',body:blob});const next=Number(result.received);doneBytes+=Math.max(0,next-offset);offset=next;update();}
          catch(err){if(err.status===409&&Number.isFinite(err.expectedOffset)){const next=err.expectedOffset;doneBytes+=Math.max(0,next-offset);offset=next;update();continue;}throw err;}
        }
        doneFiles++;update();
      }
      els.progressText.textContent='Индексирую загруженные фотографии…';
      const finish=await adminFetch('/api/admin/upload/finish',{method:'POST',body:'{}'});
      els.progress.value=100;els.progressText.textContent=`Готово · ${finish.photos} фото в базе · ${finish.halls} залов`;
      toast('Загрузка завершена');
    }finally{els.start.disabled=false;els.folder.disabled=false;delete els.start.dataset.busy;}
  }
  els.gateForm.addEventListener('submit',e=>{e.preventDefault();unlock().catch(err=>console.error(err));});
  els.lock.addEventListener('click',()=>{if(els.start.dataset.busy!=='1')lock();});
  els.folder.addEventListener('change',()=>{try{const files=selectedUploadFiles();const bytes=files.reduce((s,x)=>s+x.file.size,0);els.summary.textContent=`${files.length} фото · ${humanBytes(bytes)}`;els.start.disabled=false;}catch(err){els.summary.textContent=err.message;els.start.disabled=true;}});
  els.start.addEventListener('click',()=>startUpload().catch(err=>{console.error(err);toast(err.message,true);}));
  setTimeout(()=>els.password.focus(),0);
})();
