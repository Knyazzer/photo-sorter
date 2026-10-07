(() => {
  const qs = new URLSearchParams(location.search);
  if (qs.get('token')) {
    localStorage.setItem('photoSorterToken', qs.get('token'));
    qs.delete('token');
    history.replaceState({}, '', `${location.pathname}${qs.toString() ? `?${qs}` : ''}${location.hash}`);
  }
  const token = localStorage.getItem('photoSorterToken') || '';
  const $ = id => document.getElementById(id);

  const els = {
    setupScreen:$('setupScreen'), workspace:$('workspace'), workspaceActions:$('workspaceActions'), projectLabel:$('projectLabel'),
    setupPath:$('setupPath'), setupBtn:$('setupBtn'), syncBtn:$('syncBtn'), undoBtn:$('undoBtn'),
    viewerBreadcrumb:$('viewerBreadcrumb'), viewerReloadBtn:$('viewerReloadBtn'), viewerCount:$('viewerCount'),
    viewerFolders:$('viewerFolders'), viewerGrid:$('viewerGrid'), viewerEmpty:$('viewerEmpty'),
    previewEmpty:$('previewEmpty'), previewContent:$('previewContent'), previewImageButton:$('previewImageButton'), previewImage:$('previewImage'), previewFileName:$('previewFileName'), previewMeta:$('previewMeta'),
    mode1Selected:$('mode1Selected'), mode1PeopleBtn:$('mode1PeopleBtn'), mode1EquipmentBtn:$('mode1EquipmentBtn'), mode1RawBtn:$('mode1RawBtn'), mode1ReloadBtn:$('mode1ReloadBtn'), mode1Empty:$('mode1Empty'), mode1Groups:$('mode1Groups'),
    mode2Hall:$('mode2Hall'), mode2Selected:$('mode2Selected'), mode2ResetBtn:$('mode2ResetBtn'), mode2ReloadBtn:$('mode2ReloadBtn'), personAddInput:$('personAddInput'), peopleList:$('peopleList'), mode2Empty:$('mode2Empty'), mode2Grid:$('mode2Grid'),
    contextMenu:$('contextMenu'), contextResetBtn:$('contextResetBtn'), imageModal:$('imageModal'), modalImage:$('modalImage'), modalFileName:$('modalFileName'), modalCloseBtn:$('modalCloseBtn'), toast:$('toast'),
  };

  const state = {
    root:null, halls:[],
    viewer:{ path:'', loaded:false, selected:null, previewRequest:0 },
    mode1:{ photos:[], selected:new Set(), lastIndex:null, loaded:false },
    mode2:{ hall:'', people:[], photos:[], selected:new Set(), lastIndex:null, loaded:false },
    contextPhotoId:null,
  };

  async function api(url, options = {}) {
    const headers = { ...(options.headers || {}), 'x-access-token':token };
    if (options.body && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, { ...options, headers });
    const type = res.headers.get('content-type') || '';
    const data = type.includes('application/json') ? await res.json() : await res.text();
    if (!res.ok) throw new Error(data?.error || data || `HTTP ${res.status}`);
    return data;
  }

  const imageUrl = p => `/api/image?path=${encodeURIComponent(p)}&token=${encodeURIComponent(token)}`;
  const previewUrl = p => `/api/preview?path=${encodeURIComponent(p)}&token=${encodeURIComponent(token)}`;
  function toast(message, error=false) {
    els.toast.textContent = message;
    els.toast.classList.toggle('error', error);
    els.toast.classList.remove('hidden');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(()=>els.toast.classList.add('hidden'), 3500);
  }
  async function safe(fn) { try { await fn(); } catch (err) { console.error(err); toast(err.message, true); } }
  const escapeHtml = value => String(value).replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
  const activeTab = () => document.querySelector('.tab.active')?.dataset.tab || 'viewer';

  const lazyObserver = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const img = entry.target;
      if (img.dataset.src) { img.src = img.dataset.src; delete img.dataset.src; }
      lazyObserver.unobserve(img);
    }
  }, { rootMargin:'500px 0px' }) : null;
  function lazyImage(img, src) {
    if (lazyObserver) { img.dataset.src = src; lazyObserver.observe(img); }
    else img.src = src;
  }

  function showSetup(show) {
    els.setupScreen.classList.toggle('hidden', !show);
    els.workspace.classList.toggle('hidden', show);
    els.workspaceActions.classList.toggle('hidden', show);
  }

  async function loadProject() {
    const data = await api('/api/project');
    if (!data.root || !data.exists) {
      state.root = null;
      els.projectLabel.textContent = data.root ? `Недоступно: ${data.root}` : 'Проект не настроен';
      showSetup(true);
      return;
    }
    state.root = data.root;
    state.halls = data.halls || [];
    els.projectLabel.textContent = data.root;
    showSetup(false);
    fillHallSelect();
    await loadViewer('');
  }

  function fillHallSelect() {
    const current = state.mode2.hall || state.halls[0] || '';
    els.mode2Hall.innerHTML = state.halls.map(h=>`<option value="${escapeHtml(h)}">${escapeHtml(h)}</option>`).join('');
    if (state.halls.includes(current)) els.mode2Hall.value = current;
    state.mode2.hall = els.mode2Hall.value || '';
  }

  async function setupRoot() {
    const value = els.setupPath.value.trim();
    if (!value) throw new Error('Укажите корень проекта');
    const data = await api('/api/setup/root', { method:'POST', body:JSON.stringify({ path:value }) });
    state.root = data.root;
    state.halls = data.halls || [];
    els.projectLabel.textContent = data.root;
    showSetup(false);
    fillHallSelect();
    toast(`Проект проиндексирован: ${data.sync.photos} фото`);
    await loadViewer('');
  }

  function setTabs() {
    document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => safe(async () => {
      document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(x=>x.classList.remove('active'));
      tab.classList.add('active');
      $(tab.dataset.tab).classList.add('active');
      hideContextMenu();
      if (tab.dataset.tab === 'viewer' && !state.viewer.loaded) await loadViewer(state.viewer.path || '');
      if (tab.dataset.tab === 'mode1' && !state.mode1.loaded) await loadMode1();
      if (tab.dataset.tab === 'mode2' && !state.mode2.loaded) await loadMode2();
    })));
  }

  function renderBreadcrumb(relativePath) {
    els.viewerBreadcrumb.innerHTML = '';
    const parts = relativePath ? relativePath.split(/[\\/]+/).filter(Boolean) : [];
    const add = (label, target, current) => {
      if (els.viewerBreadcrumb.children.length) {
        const sep = document.createElement('span'); sep.className='crumb-sep'; sep.textContent='/' ; els.viewerBreadcrumb.appendChild(sep);
      }
      const btn = document.createElement('button'); btn.className=`crumb${current?' current':''}`; btn.textContent=label; btn.disabled=current;
      if (!current) btn.addEventListener('click', ()=>safe(()=>loadViewer(target)));
      els.viewerBreadcrumb.appendChild(btn);
    };
    add('Проект', '', parts.length===0);
    parts.forEach((part, i)=>add(part, parts.slice(0,i+1).join('/'), i===parts.length-1));
  }

  async function loadViewer(relativePath = state.viewer.path || '') {
    const data = await api(`/api/browser/list?path=${encodeURIComponent(relativePath || '')}`);
    state.viewer.path = data.path || '';
    state.viewer.loaded = true;
    state.viewer.selected = null;
    renderBreadcrumb(state.viewer.path);
    els.viewerCount.textContent = `${data.directories.length} папок · ${data.images.length} фото`;
    els.viewerFolders.innerHTML = '';
    data.directories.forEach(dir => {
      const btn = document.createElement('button'); btn.className='folder-card';
      btn.innerHTML = `<span class="folder-icon">📁</span><span>${escapeHtml(dir.name)}</span>`;
      btn.addEventListener('click', ()=>safe(()=>loadViewer(dir.relativePath)));
      els.viewerFolders.appendChild(btn);
    });
    els.viewerGrid.innerHTML = '';
    data.images.forEach(item => {
      const photo = item.photo || { id:null, relativePath:item.relativePath, name:item.name, status:null, personName:null };
      photo.relativePath = item.relativePath; photo.name = item.name;
      const card = createPhotoCard(photo, { scope:'viewer', selectable:false });
      card.addEventListener('click', ()=>safe(()=>selectViewerPhoto(photo, card)));
      els.viewerGrid.appendChild(card);
    });
    els.viewerEmpty.classList.toggle('hidden', data.directories.length + data.images.length > 0);
    clearPreview();
  }

  async function selectViewerPhoto(photo, card) {
    document.querySelectorAll('#viewerGrid .photo-card.selected').forEach(x=>x.classList.remove('selected'));
    card.classList.add('selected');
    state.viewer.selected = photo;
    const requestId = ++state.viewer.previewRequest;
    els.previewEmpty.classList.add('hidden');
    els.previewContent.classList.remove('hidden');
    els.previewImage.src = previewUrl(photo.relativePath);
    els.previewFileName.textContent = photo.name;
    els.previewMeta.innerHTML = '<div class="muted">Читаю метаданные…</div>';
    const data = await api(`/api/photo/metadata?path=${encodeURIComponent(photo.relativePath)}`);
    if (requestId !== state.viewer.previewRequest) return;
    renderPreviewMetadata(data);
  }

  function clearPreview() {
    ++state.viewer.previewRequest;
    els.previewEmpty.classList.remove('hidden');
    els.previewContent.classList.add('hidden');
    els.previewImage.removeAttribute('src');
    els.previewFileName.textContent=''; els.previewMeta.innerHTML='';
  }

  function humanBytes(value) {
    if (value == null) return null;
    const units=['Б','КБ','МБ','ГБ']; let n=Number(value), i=0;
    while(n>=1024 && i<units.length-1){n/=1024;i++;}
    return `${n.toFixed(i?1:0)} ${units[i]}`;
  }
  function formatDate(value) {
    if (!value) return null;
    const m=String(value).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
    return m ? `${m[3]}.${m[2]}.${m[1]} ${m[4]}:${m[5]}:${m[6]}` : value;
  }
  function statusText(photo) {
    if (!photo) return null;
    if (photo.status==='raw') return 'Не отсортировано (RAW)';
    if (photo.status==='equipment') return 'Оборудование';
    if (photo.status==='people') return 'Люди — ФИО не назначено';
    if (photo.status==='person') return `Люди — ${photo.personName || 'ФИО'}`;
    return photo.status;
  }
  function renderPreviewMetadata(data) {
    const rows=[];
    const add=(label,value)=>{if(value!==null&&value!==undefined&&value!=='')rows.push([label,String(value)])};
    add('Имя файла',data.filename); add('Путь',data.relativePath); add('Размер',humanBytes(data.sizeBytes)); add('Формат',data.format);
    if(data.width&&data.height)add('Разрешение',`${data.width} × ${data.height}`);
    add('Дата и время съёмки',formatDate(data.shotAt)); add('Состояние',statusText(data.photo)); add('Исходное имя',data.photo?.originalFilename);
    const exif=data.exif||{};
    add('Камера', [exif.Make,exif.Model].filter(Boolean).join(' ') || null); add('Объектив',exif.LensModel); add('ISO',exif.ISO);
    if(exif.ExposureTime!=null) add('Выдержка', exif.ExposureTime>0&&exif.ExposureTime<1?`1/${Math.round(1/exif.ExposureTime)} с`:`${exif.ExposureTime} с`);
    if(exif.FNumber!=null)add('Диафрагма',`f/${Number(exif.FNumber).toFixed(1)}`); if(exif.FocalLength!=null)add('Фокусное расстояние',`${Number(exif.FocalLength).toFixed(1)} мм`);
    add('Ориентация',exif.Orientation); add('DateTimeOriginal',exif.DateTimeOriginal); add('CreateDate',exif.CreateDate); add('ModifyDate',exif.ModifyDate);
    if(exif.GPS?.latitude!=null&&exif.GPS?.longitude!=null)add('GPS',`${exif.GPS.latitude.toFixed(6)}, ${exif.GPS.longitude.toFixed(6)}`);
    els.previewMeta.innerHTML='';
    rows.forEach(([label,value])=>{const row=document.createElement('div');row.className='metadata-row';row.innerHTML=`<span class="metadata-label">${escapeHtml(label)}</span><span class="metadata-value">${escapeHtml(value)}</span>`;els.previewMeta.appendChild(row)});
  }

  function createPhotoCard(photo, { scope, selectable=true, index=null, draggable=false }={}) {
    const card=document.createElement('div'); card.className='photo-card'; card.tabIndex=0;
    if(photo.id) card.dataset.photoId=photo.id; card.dataset.scope=scope||'';
    if(draggable) card.draggable=true;
    const frame=document.createElement('div');frame.className='photo-thumb';
    const img=document.createElement('img');img.alt=photo.name||'';img.draggable=false;lazyImage(img,previewUrl(photo.relativePath));frame.appendChild(img);
    const badges=document.createElement('div');badges.className='photo-badges';
    if(photo.status){const b=document.createElement('span');b.className=`badge ${photo.status}`;b.textContent=photo.status==='raw'?'RAW':photo.status==='equipment'?'ОБОРУДОВАНИЕ':'ЛЮДИ';badges.appendChild(b)}
    if(photo.personName){const b=document.createElement('span');b.className='badge person-name';b.textContent=photo.personName;b.title=photo.personName;badges.appendChild(b)}
    const name=document.createElement('div');name.className='photo-name';name.textContent=photo.name||'';
    card.append(frame,badges,name);
    if(selectable) card.addEventListener('click',e=>handleSelect(scope,photo,index,e));
    card.addEventListener('dblclick',e=>{e.preventDefault();openModal(photo)});
    return card;
  }

  function selectionState(scope) { return scope==='mode1'?state.mode1:state.mode2; }
  function handleSelect(scope, photo, index, event) {
    const s=selectionState(scope); if(!photo.id)return;
    if(event.shiftKey && s.lastIndex!=null && index!=null){
      const photos=s.photos; const a=Math.min(s.lastIndex,index),b=Math.max(s.lastIndex,index); for(let i=a;i<=b;i++)if(photos[i]?.id)s.selected.add(photos[i].id);
    } else if(event.ctrlKey||event.metaKey){ if(s.selected.has(photo.id))s.selected.delete(photo.id);else s.selected.add(photo.id); s.lastIndex=index; }
    else { s.selected.clear(); s.selected.add(photo.id); s.lastIndex=index; }
    syncSelectionUI(scope);
  }
  function syncSelectionUI(scope) {
    const s=selectionState(scope);
    document.querySelectorAll(`.photo-card[data-scope="${scope}"]`).forEach(card=>card.classList.toggle('selected',s.selected.has(card.dataset.photoId)));
    if(scope==='mode1'){
      els.mode1Selected.textContent=`Выбрано: ${s.selected.size}`; const disabled=!s.selected.size; els.mode1PeopleBtn.disabled=disabled;els.mode1EquipmentBtn.disabled=disabled;els.mode1RawBtn.disabled=disabled;
    } else {
      els.mode2Selected.textContent=`Выбрано: ${s.selected.size}`;els.mode2ResetBtn.disabled=!s.selected.size;
    }
  }

  async function loadMode1() {
    const data=await api('/api/mode1/photos');
    state.mode1.photos=data.photos||[];state.mode1.selected.clear();state.mode1.lastIndex=null;state.mode1.loaded=true;
    renderMode1();
  }
  function renderMode1() {
    els.mode1Groups.innerHTML=''; els.mode1Empty.classList.toggle('hidden',state.mode1.photos.length>0);
    const groups=new Map(); state.mode1.photos.forEach((p,i)=>{if(!groups.has(p.hall))groups.set(p.hall,[]);groups.get(p.hall).push({p,i})});
    for(const [hall,items] of groups){
      const section=document.createElement('section');section.className='hall-group';const title=document.createElement('h2');title.className='hall-title';title.textContent=`ЗАЛ: ${hall} · ${items.length} фото`;
      const grid=document.createElement('div');grid.className='photo-grid';items.forEach(({p,i})=>grid.appendChild(createPhotoCard(p,{scope:'mode1',selectable:true,index:i})));
      section.append(title,grid);els.mode1Groups.appendChild(section);
    }
    syncSelectionUI('mode1');
  }
  async function applyMode1(target) {
    const ids=[...state.mode1.selected];if(!ids.length)return;
    await api('/api/mode1/classify',{method:'POST',body:JSON.stringify({photoIds:ids,target})});
    state.viewer.loaded=false;state.mode2.loaded=false;await loadMode1();toast(`Обновлено фотографий: ${ids.length}`);
  }

  async function loadMode2() {
    const hall=els.mode2Hall.value||state.halls[0]||'';state.mode2.hall=hall;
    if(!hall){state.mode2.people=[];state.mode2.photos=[];renderMode2();return;}
    const data=await api(`/api/mode2/data?hall=${encodeURIComponent(hall)}`);
    state.mode2.people=data.people||[];state.mode2.photos=data.photos||[];state.mode2.selected.clear();state.mode2.lastIndex=null;state.mode2.loaded=true;renderMode2();
  }
  function renderMode2() {
    renderPeople(); els.mode2Grid.innerHTML='';els.mode2Empty.classList.toggle('hidden',state.mode2.photos.length>0);
    state.mode2.photos.forEach((photo,index)=>{
      const card=createPhotoCard(photo,{scope:'mode2',selectable:true,index,draggable:true});
      card.addEventListener('dragstart',e=>startPhotoDrag(e,photo,index,card));
      card.addEventListener('dragend',endPhotoDrag);
      card.addEventListener('contextmenu',e=>{e.preventDefault();if(!state.mode2.selected.has(photo.id)){state.mode2.selected.clear();state.mode2.selected.add(photo.id);state.mode2.lastIndex=index;syncSelectionUI('mode2')}showContextMenu(e.clientX,e.clientY,photo.id)});
      els.mode2Grid.appendChild(card);
    }); syncSelectionUI('mode2');
  }
  function renderPeople() {
    els.peopleList.innerHTML='';
    state.mode2.people.forEach(person=>{
      const row=document.createElement('div');row.className='person-row';row.dataset.personId=person.id;
      const left=document.createElement('div');
      const input=document.createElement('input');input.className='person-name-input';input.value=person.name;input.dataset.original=person.name;
      const count=document.createElement('div');count.className='person-count';count.textContent=`${person.photoCount} фото`;
      left.append(input,count);
      const remove=document.createElement('button');remove.className='person-remove ghost';remove.textContent='×';remove.title='Удалить ФИО';
      input.addEventListener('keydown',e=>{if(e.key==='Enter')input.blur();if(e.key==='Escape'){input.value=input.dataset.original;input.blur()}});
      input.addEventListener('change',()=>safe(async()=>{const name=input.value.trim();if(!name){input.value=input.dataset.original;return}const data=await api(`/api/people/${person.id}`,{method:'PATCH',body:JSON.stringify({name})});input.dataset.original=data.person.name;state.viewer.loaded=false;state.mode1.loaded=false;await loadMode2();toast('ФИО обновлено')}));
      remove.addEventListener('click',()=>safe(()=>removePerson(person)));
      row.addEventListener('dragover',e=>{e.preventDefault();e.dataTransfer.dropEffect='move';row.classList.add('dragover')});
      row.addEventListener('dragleave',()=>row.classList.remove('dragover'));
      row.addEventListener('drop',e=>{e.preventDefault();row.classList.remove('dragover');safe(()=>assignSelected(person.id))});
      row.append(left,remove);els.peopleList.appendChild(row);
    });
  }
  async function addPerson() {
    const name=els.personAddInput.value.trim();if(!name)return;
    await api('/api/people',{method:'POST',body:JSON.stringify({hall:state.mode2.hall,name})});els.personAddInput.value='';state.viewer.loaded=false;await loadMode2();toast('ФИО добавлено');
  }
  async function removePerson(person) {
    let result=await api(`/api/people/${person.id}`,{method:'DELETE',body:JSON.stringify({confirm:false})});
    if(result.requiresConfirmation){const ok=confirm(`У «${person.name}» ${result.count} фото. Они будут возвращены в RAW с исходными именами. Продолжить?`);if(!ok)return;result=await api(`/api/people/${person.id}`,{method:'DELETE',body:JSON.stringify({confirm:true})})}
    state.viewer.loaded=false;state.mode1.loaded=false;await loadMode2();toast(result.returnedToRaw?`ФИО удалено, ${result.returnedToRaw} фото возвращено в RAW`:'ФИО удалено');
  }

  let dragGhost=null;
  function startPhotoDrag(e,photo,index,card){
    if(!state.mode2.selected.has(photo.id)){state.mode2.selected.clear();state.mode2.selected.add(photo.id);state.mode2.lastIndex=index;syncSelectionUI('mode2')}
    e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',[...state.mode2.selected].join(','));
    dragGhost=document.createElement('div');dragGhost.className='drag-ghost';dragGhost.innerHTML=`<img src="${previewUrl(photo.relativePath)}" alt=""><div>${state.mode2.selected.size>1?`${state.mode2.selected.size} фото`:'Фото → ФИО'}</div>`;document.body.appendChild(dragGhost);e.dataTransfer.setDragImage(dragGhost,70,50);card.style.opacity='.65';card.dataset.dragging='1';
  }
  function endPhotoDrag(){document.querySelectorAll('[data-dragging="1"]').forEach(x=>{x.style.opacity='';delete x.dataset.dragging});document.querySelectorAll('.person-row.dragover').forEach(x=>x.classList.remove('dragover'));if(dragGhost)dragGhost.remove();dragGhost=null}
  async function assignSelected(personId){const ids=[...state.mode2.selected];if(!ids.length)throw new Error('Выберите фотографии');await api('/api/mode2/assign',{method:'POST',body:JSON.stringify({photoIds:ids,personId})});state.viewer.loaded=false;state.mode1.loaded=false;await loadMode2();toast(`Назначено фотографий: ${ids.length}`)}
  async function resetMode2(){const ids=[...state.mode2.selected];if(!ids.length)return;await api('/api/photos/reset',{method:'POST',body:JSON.stringify({photoIds:ids})});state.viewer.loaded=false;state.mode1.loaded=false;await loadMode2();toast(`Возвращено в RAW: ${ids.length}`)}

  function showContextMenu(x,y,photoId){state.contextPhotoId=photoId;els.contextMenu.style.left=`${Math.min(x,innerWidth-300)}px`;els.contextMenu.style.top=`${Math.min(y,innerHeight-70)}px`;els.contextMenu.classList.remove('hidden')}
  function hideContextMenu(){els.contextMenu.classList.add('hidden');state.contextPhotoId=null}

  function openModal(photo){els.modalImage.src=imageUrl(photo.relativePath);els.modalFileName.textContent=photo.name;els.imageModal.classList.remove('hidden');els.imageModal.setAttribute('aria-hidden','false')}
  function closeModal(){els.imageModal.classList.add('hidden');els.imageModal.setAttribute('aria-hidden','true');els.modalImage.removeAttribute('src')}

  async function syncProject(){const data=await api('/api/sync',{method:'POST',body:'{}'});state.viewer.loaded=false;state.mode1.loaded=false;state.mode2.loaded=false;toast(`Синхронизация: ${data.photos} фото`);await refreshActive()}
  async function undo(){const data=await api('/api/undo',{method:'POST',body:'{}'});if(!data.ok)return toast(data.message||'Нет действий для отмены');state.viewer.loaded=false;state.mode1.loaded=false;state.mode2.loaded=false;await refreshActive();toast(`Отменено операций: ${data.count}`)}
  async function refreshActive(){const tab=activeTab();if(tab==='viewer')await loadViewer(state.viewer.path||'');else if(tab==='mode1')await loadMode1();else if(tab==='mode2')await loadMode2()}

  els.setupBtn.addEventListener('click',()=>safe(setupRoot));els.setupPath.addEventListener('keydown',e=>{if(e.key==='Enter')safe(setupRoot)});
  els.syncBtn.addEventListener('click',()=>safe(syncProject));els.undoBtn.addEventListener('click',()=>safe(undo));
  els.viewerReloadBtn.addEventListener('click',()=>safe(()=>loadViewer(state.viewer.path||'')));
  els.previewImageButton.addEventListener('click',()=>{if(state.viewer.selected)openModal(state.viewer.selected)});
  els.mode1ReloadBtn.addEventListener('click',()=>safe(loadMode1));els.mode1PeopleBtn.addEventListener('click',()=>safe(()=>applyMode1('people')));els.mode1EquipmentBtn.addEventListener('click',()=>safe(()=>applyMode1('equipment')));els.mode1RawBtn.addEventListener('click',()=>safe(()=>applyMode1('raw')));
  els.mode2Hall.addEventListener('change',()=>safe(async()=>{state.mode2.hall=els.mode2Hall.value;await loadMode2()}));els.mode2ReloadBtn.addEventListener('click',()=>safe(loadMode2));els.mode2ResetBtn.addEventListener('click',()=>safe(resetMode2));els.personAddInput.addEventListener('keydown',e=>{if(e.key==='Enter')safe(addPerson)});
  els.contextResetBtn.addEventListener('click',()=>safe(async()=>{hideContextMenu();await resetMode2()}));document.addEventListener('click',e=>{if(!els.contextMenu.contains(e.target))hideContextMenu()});
  els.modalCloseBtn.addEventListener('click',closeModal);els.imageModal.addEventListener('click',e=>{if(e.target===els.imageModal)closeModal()});
  document.addEventListener('keydown',e=>{
    if(e.key==='Escape'){if(!els.imageModal.classList.contains('hidden'))closeModal();hideContextMenu();return}
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();safe(undo);return}
    if(e.target.matches('input,textarea,select'))return;
    if(activeTab()==='mode1'){
      if(e.key==='1'){e.preventDefault();safe(()=>applyMode1('people'))}
      else if(e.key==='2'){e.preventDefault();safe(()=>applyMode1('equipment'))}
      else if(e.key==='0'){e.preventDefault();safe(()=>applyMode1('raw'))}
    }
  });

  setTabs(); safe(loadProject);
})();
