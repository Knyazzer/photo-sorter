(() => {
  let sessionId = sessionStorage.getItem('photoSorterSessionId');
  if (!sessionId) {
    sessionId = globalThis.crypto?.randomUUID?.() || `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    sessionStorage.setItem('photoSorterSessionId', sessionId);
  }

  const $ = id => document.getElementById(id);
  const els = {
    loginScreen:$('loginScreen'), loginForm:$('loginForm'), loginUsername:$('loginUsername'), loginPassword:$('loginPassword'), loginBtn:$('loginBtn'), loginError:$('loginError'),
    setupScreen:$('setupScreen'), workspace:$('workspace'), workspaceActions:$('workspaceActions'), projectLabel:$('projectLabel'), activeSessions:$('activeSessions'),
    setupPath:$('setupPath'), setupBtn:$('setupBtn'), syncBtn:$('syncBtn'), undoBtn:$('undoBtn'), uploadBtn:$('uploadBtn'), logoutBtn:$('logoutBtn'),
    viewerBreadcrumb:$('viewerBreadcrumb'), viewerReloadBtn:$('viewerReloadBtn'), viewerCount:$('viewerCount'),
    viewerFolders:$('viewerFolders'), viewerGrid:$('viewerGrid'), viewerEmpty:$('viewerEmpty'),
    previewEmpty:$('previewEmpty'), previewContent:$('previewContent'), previewImageButton:$('previewImageButton'), previewImage:$('previewImage'), previewFileName:$('previewFileName'), previewMeta:$('previewMeta'),
    mode1Selected:$('mode1Selected'), mode1PeopleBtn:$('mode1PeopleBtn'), mode1EquipmentBtn:$('mode1EquipmentBtn'), mode1RawBtn:$('mode1RawBtn'), mode1ReloadBtn:$('mode1ReloadBtn'), mode1Empty:$('mode1Empty'), mode1Groups:$('mode1Groups'),
    mode2Hall:$('mode2Hall'), mode2Selected:$('mode2Selected'), mode2ResetBtn:$('mode2ResetBtn'), mode2ReloadBtn:$('mode2ReloadBtn'), personAddInput:$('personAddInput'), peopleList:$('peopleList'), mode2Empty:$('mode2Empty'), mode2Grid:$('mode2Grid'),
    contextMenu:$('contextMenu'), contextResetBtn:$('contextResetBtn'), imageModal:$('imageModal'), modalImage:$('modalImage'), modalFileName:$('modalFileName'), modalCloseBtn:$('modalCloseBtn'),
    uploadModal:$('uploadModal'), uploadCloseBtn:$('uploadCloseBtn'), uploadCancelBtn:$('uploadCancelBtn'), uploadPasswordInput:$('uploadPasswordInput'), uploadFolderInput:$('uploadFolderInput'), uploadSummary:$('uploadSummary'), uploadProgress:$('uploadProgress'), uploadProgressText:$('uploadProgressText'), uploadStartBtn:$('uploadStartBtn'),
    toast:$('toast'),
  };

  const state = {
    root:null, halls:[],
    viewer:{ path:'', loaded:false, selected:null, previewRequest:0 },
    mode1:{ photos:[], selected:new Set(), lastIndex:null, loaded:false },
    mode2:{ hall:'', people:[], photos:[], selected:new Set(), lastIndex:null, loaded:false },
    contextPhotoId:null,
  };

  const activeTab = () => document.querySelector('.tab.active')?.dataset.tab || 'viewer';
  function currentHallForPresence() {
    if (activeTab() === 'mode2') return state.mode2.hall || '';
    if (activeTab() === 'viewer') return (state.viewer.path || '').split(/[\\/]+/).filter(Boolean)[0] || '';
    return '';
  }

  function showLogin(show) {
    els.loginScreen.classList.toggle('hidden', !show);
    if (show) {
      els.setupScreen.classList.add('hidden');
      els.workspace.classList.add('hidden');
      els.workspaceActions.classList.add('hidden');
      els.projectLabel.textContent = 'Требуется вход';
      setTimeout(() => els.loginUsername.focus(), 0);
    }
  }

  async function api(url, options = {}) {
    const headers = {
      ...(options.headers || {}),
      'x-session-id':sessionId,
      'x-client-mode':activeTab(),
      'x-client-hall':currentHallForPresence(),
    };
    const isBinary = options.body instanceof Blob || options.body instanceof ArrayBuffer || ArrayBuffer.isView(options.body);
    if (options.body && !(options.body instanceof FormData) && !isBinary && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, { ...options, headers, credentials:'same-origin' });
    const type = res.headers.get('content-type') || '';
    const data = type.includes('application/json') ? await res.json() : await res.text();
    if (!res.ok) {
      if (res.status === 401) showLogin(true);
      const err = new Error(data?.error || data || `HTTP ${res.status}`);
      err.status = res.status;
      if (data?.expectedOffset != null) err.expectedOffset = Number(data.expectedOffset);
      throw err;
    }
    return data;
  }

  function assetUrl(kind, photo) {
    if (photo?.id) {
      const rev = photo.contentRevision ? `&rev=${encodeURIComponent(photo.contentRevision)}` : '';
      return `/api/${kind}?id=${encodeURIComponent(photo.id)}${rev}`;
    }
    return `/api/${kind}?path=${encodeURIComponent(photo?.relativePath || '')}`;
  }
  const imageUrl = photo => assetUrl('image', photo);
  const previewUrl = photo => assetUrl('preview', photo);

  function toast(message, error=false) {
    els.toast.textContent = message;
    els.toast.classList.toggle('error', error);
    els.toast.classList.remove('hidden');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(()=>els.toast.classList.add('hidden'), 3500);
  }

  async function safe(fn) {
    try { await fn(); }
    catch (err) {
      console.error(err);
      toast(err.message, true);
      if (err.status === 409) {
        state.viewer.loaded=false; state.mode1.loaded=false; state.mode2.loaded=false;
        try { await refreshActive(); } catch (_) {}
      }
    }
  }

  const escapeHtml = value => String(value).replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));

  const lazyObserver = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const img = entry.target;
      if (img.dataset.src) { img.src = img.dataset.src; delete img.dataset.src; }
      lazyObserver.unobserve(img);
    }
  }, { rootMargin:'600px 0px' }) : null;

  function lazyImage(img, src) {
    if (lazyObserver) { img.dataset.src = src; lazyObserver.observe(img); }
    else img.src = src;
  }

  function showSetup(show) {
    els.setupScreen.classList.toggle('hidden', !show);
    els.workspace.classList.toggle('hidden', show);
    els.workspaceActions.classList.toggle('hidden', show);
  }

  async function refreshSessions() {
    const data = await api('/api/sessions');
    const sessions = data.sessions || [];
    els.activeSessions.innerHTML = '';
    for (const item of sessions.slice(0, 6)) {
      const pill = document.createElement('div');
      pill.className = `session-pill${item.id === sessionId ? ' current' : ''}`;
      const mode = item.mode === 'mode1' ? 'Люди / оборудование' : item.mode === 'mode2' ? 'Люди / ФИО' : 'Файлы';
      const detail = `${item.id === sessionId ? 'Вы' : item.display_name} · ${mode}${item.hall ? ` · ${item.hall}` : ''}`;
      pill.title = detail;
      pill.innerHTML = `<span class="session-dot"></span><span class="session-text">${escapeHtml(detail)}</span>`;
      els.activeSessions.appendChild(pill);
    }
  }

  async function loadProject() {
    const data = await api('/api/project');
    if (!data.root || !data.exists) {
      state.root = null;
      els.projectLabel.textContent = data.root ? `Недоступно: ${data.root}` : 'Проект не настроен';
      showSetup(true);
      await refreshSessions();
      return;
    }
    state.root = data.root;
    state.halls = data.halls || [];
    els.projectLabel.textContent = data.root;
    showSetup(false);
    fillHallSelect();
    await loadViewer('');
    await refreshSessions();
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
    const uploadPassword = prompt('Введите отдельный пароль загрузки / администратора');
    if (!uploadPassword) return;
    const data = await api('/api/setup/root', { method:'POST', body:JSON.stringify({ path:value, uploadPassword }) });
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
      await refreshSessions();
    })));
  }

  function renderBreadcrumb(relativePath) {
    els.viewerBreadcrumb.innerHTML = '';
    const parts = relativePath ? relativePath.split(/[\\/]+/).filter(Boolean) : [];
    const add = (label, target, current) => {
      if (els.viewerBreadcrumb.children.length) {
        const sep = document.createElement('span'); sep.className='crumb-sep'; sep.textContent='/'; els.viewerBreadcrumb.appendChild(sep);
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
    els.previewImage.src = previewUrl(photo);
    els.previewFileName.textContent = photo.name;
    els.previewMeta.innerHTML = '<div class="muted">Читаю метаданные…</div>';
    const query = photo.id ? `id=${encodeURIComponent(photo.id)}` : `path=${encodeURIComponent(photo.relativePath)}`;
    const data = await api(`/api/photo/metadata?${query}`);
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
    const add=(label,value)=>{if(value!==null&&value!==undefined&&value!=='')rows.push([label,String(value)]);};
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
    rows.forEach(([label,value])=>{const row=document.createElement('div');row.className='metadata-row';row.innerHTML=`<span class="metadata-label">${escapeHtml(label)}</span><span class="metadata-value">${escapeHtml(value)}</span>`;els.previewMeta.appendChild(row);});
  }

  function buildBadges(photo) {
    const badges=[];
    if(photo.status){
      const text=photo.status==='raw'?'RAW':photo.status==='equipment'?'ОБОРУДОВАНИЕ':'ЛЮДИ';
      badges.push(`<span class="badge ${escapeHtml(photo.status)}">${text}</span>`);
    }
    if(photo.personName) badges.push(`<span class="badge person-name" title="${escapeHtml(photo.personName)}">${escapeHtml(photo.personName)}</span>`);
    return badges.join('');
  }

  function patchCard(card, photo) {
    if (!card || !photo) return;
    card.dataset.version = String(photo.version || 1);
    const badges=card.querySelector('.photo-badges'); if (badges) badges.innerHTML=buildBadges(photo);
    const name=card.querySelector('.photo-name'); if (name) name.textContent=photo.name||'';
    const img=card.querySelector('.photo-thumb img'); if (img) img.alt=photo.name||'';
  }

  function createPhotoCard(photo, { scope, selectable=true, index=null, draggable=false }={}) {
    const card=document.createElement('div'); card.className='photo-card'; card.tabIndex=0;
    if(photo.id) card.dataset.photoId=photo.id; card.dataset.scope=scope||''; card.dataset.version=String(photo.version||1);
    if(draggable) card.draggable=true;
    const frame=document.createElement('div');frame.className='photo-thumb';
    const img=document.createElement('img');img.alt=photo.name||'';img.draggable=false;lazyImage(img,previewUrl(photo));frame.appendChild(img);
    const badges=document.createElement('div');badges.className='photo-badges';badges.innerHTML=buildBadges(photo);
    const name=document.createElement('div');name.className='photo-name';name.textContent=photo.name||'';
    card.append(frame,badges,name);
    if(selectable) card.addEventListener('click',e=>handleSelect(scope,photo,selectionState(scope).photos.findIndex(p=>p.id===photo.id),e));
    card.addEventListener('dblclick',e=>{e.preventDefault();openModal(photo);});
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

  function expectedVersions(scope, ids) {
    const photos=selectionState(scope).photos;
    const map={};
    for(const id of ids){const p=photos.find(x=>x.id===id);if(p)map[id]=Number(p.version||1);}
    return map;
  }

  function markPending(scope, ids, pending) {
    for(const id of ids){const card=document.querySelector(`.photo-card[data-scope="${scope}"][data-photo-id="${CSS.escape(id)}"]`);if(card)card.classList.toggle('pending',pending);}
  }

  function patchStatePhotos(scope, updatedPhotos) {
    const s=selectionState(scope);
    for(const fresh of updatedPhotos||[]){
      const current=s.photos.find(p=>p.id===fresh.id);
      if(current){Object.assign(current,fresh);patchCard(document.querySelector(`.photo-card[data-scope="${scope}"][data-photo-id="${CSS.escape(fresh.id)}"]`),current);}
    }
  }

  function recomputePeopleCounts() {
    const counts=new Map();
    for(const p of state.mode2.photos){if(p.personId)counts.set(Number(p.personId),(counts.get(Number(p.personId))||0)+1);}
    state.mode2.people=state.mode2.people.map(person=>({...person,photoCount:counts.get(Number(person.id))||0}));
  }

  async function loadMode1() {
    const data=await api('/api/mode1/photos');
    state.mode1.photos=data.photos||[];state.mode1.selected.clear();state.mode1.lastIndex=null;state.mode1.loaded=true;
    renderMode1();
  }
  function renderMode1() {
    els.mode1Groups.innerHTML='';els.mode1Empty.classList.toggle('hidden',state.mode1.photos.length>0);
    const groups=new Map(); state.mode1.photos.forEach((p,i)=>{if(!groups.has(p.hall))groups.set(p.hall,[]);groups.get(p.hall).push({p,i});});
    for(const [hall,items] of groups){
      const section=document.createElement('section');section.className='hall-group';
      const title=document.createElement('h2');title.className='hall-title';title.textContent=`ЗАЛ: ${hall} · ${items.length} фото`;
      const grid=document.createElement('div');grid.className='photo-grid';items.forEach(({p,i})=>grid.appendChild(createPhotoCard(p,{scope:'mode1',selectable:true,index:i})));
      section.append(title,grid);els.mode1Groups.appendChild(section);
    }
    syncSelectionUI('mode1');
  }

  async function applyMode1(target) {
    const ids=[...state.mode1.selected];if(!ids.length)return;
    markPending('mode1',ids,true);
    try {
      const data=await api('/api/mode1/classify',{method:'POST',body:JSON.stringify({photoIds:ids,target,expectedVersions:expectedVersions('mode1',ids)})});
      patchStatePhotos('mode1',data.photos||[]);
      state.mode1.selected.clear();state.mode1.lastIndex=null;syncSelectionUI('mode1');
      state.viewer.loaded=false;state.mode2.loaded=false;
      toast(`Обновлено фотографий: ${ids.length}`);
    } finally { markPending('mode1',ids,false); }
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
      card.addEventListener('dragstart',e=>startPhotoDrag(e,photo,state.mode2.photos.findIndex(p=>p.id===photo.id),card));
      card.addEventListener('dragend',endPhotoDrag);
      card.addEventListener('contextmenu',e=>{e.preventDefault();if(!state.mode2.selected.has(photo.id)){state.mode2.selected.clear();state.mode2.selected.add(photo.id);state.mode2.lastIndex=index;syncSelectionUI('mode2');}showContextMenu(e.clientX,e.clientY,photo.id);});
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
      input.addEventListener('keydown',e=>{if(e.key==='Enter')input.blur();if(e.key==='Escape'){input.value=input.dataset.original;input.blur();}});
      input.addEventListener('change',()=>safe(async()=>{
        const name=input.value.trim();if(!name){input.value=input.dataset.original;return;}
        const data=await api(`/api/people/${person.id}`,{method:'PATCH',body:JSON.stringify({name})});
        const updated=data.person;
        person.name=updated.name;input.dataset.original=updated.name;
        if(updated.photos){patchStatePhotos('mode2',updated.photos);}
        state.viewer.loaded=false;state.mode1.loaded=false;renderPeople();toast('ФИО обновлено');
      }));
      remove.addEventListener('click',()=>safe(()=>removePerson(person)));
      row.addEventListener('dragover',e=>{e.preventDefault();e.dataTransfer.dropEffect='move';row.classList.add('dragover');});
      row.addEventListener('dragleave',()=>row.classList.remove('dragover'));
      row.addEventListener('drop',e=>{e.preventDefault();row.classList.remove('dragover');safe(()=>assignSelected(person.id));});
      row.append(left,remove);els.peopleList.appendChild(row);
    });
  }

  async function addPerson() {
    const name=els.personAddInput.value.trim();if(!name)return;
    const data=await api('/api/people',{method:'POST',body:JSON.stringify({hall:state.mode2.hall,name})});
    els.personAddInput.value='';state.mode2.people.push(data.person);state.mode2.people.sort((a,b)=>a.name.localeCompare(b.name,'ru'));renderPeople();state.viewer.loaded=false;toast('ФИО добавлено');
  }

  async function removePerson(person) {
    let result=await api(`/api/people/${person.id}`,{method:'DELETE',body:JSON.stringify({confirm:false})});
    if(result.requiresConfirmation){
      const ok=confirm(`У «${person.name}» ${result.count} фото. Они будут возвращены в корень папки «Люди» и останутся классифицированными как люди. Продолжить?`);
      if(!ok)return;
      result=await api(`/api/people/${person.id}`,{method:'DELETE',body:JSON.stringify({confirm:true})});
    }
    if(result.photos)patchStatePhotos('mode2',result.photos);
    state.mode2.people=state.mode2.people.filter(p=>Number(p.id)!==Number(person.id));
    recomputePeopleCounts();renderPeople();
    state.viewer.loaded=false;state.mode1.loaded=false;
    toast(result.returnedToPeople?`ФИО удалено, ${result.returnedToPeople} фото возвращено в корень «Люди»`:'ФИО удалено');
  }

  let dragGhost=null;
  function startPhotoDrag(e,photo,index,card){
    if(!state.mode2.selected.has(photo.id)){state.mode2.selected.clear();state.mode2.selected.add(photo.id);state.mode2.lastIndex=index;syncSelectionUI('mode2');}
    e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',[...state.mode2.selected].join(','));
    dragGhost=document.createElement('div');dragGhost.className='drag-ghost';dragGhost.innerHTML=`<img src="${previewUrl(photo)}" alt=""><div>${state.mode2.selected.size>1?`${state.mode2.selected.size} фото`:'Фото → ФИО'}</div>`;document.body.appendChild(dragGhost);e.dataTransfer.setDragImage(dragGhost,70,50);card.style.opacity='.65';card.dataset.dragging='1';
  }
  function endPhotoDrag(){document.querySelectorAll('[data-dragging="1"]').forEach(x=>{x.style.opacity='';delete x.dataset.dragging;});document.querySelectorAll('.person-row.dragover').forEach(x=>x.classList.remove('dragover'));if(dragGhost)dragGhost.remove();dragGhost=null;}

  async function assignSelected(personId){
    const ids=[...state.mode2.selected];if(!ids.length)throw new Error('Выберите фотографии');
    markPending('mode2',ids,true);
    try{
      const data=await api('/api/mode2/assign',{method:'POST',body:JSON.stringify({photoIds:ids,personId,expectedVersions:expectedVersions('mode2',ids)})});
      patchStatePhotos('mode2',data.photos||[]);recomputePeopleCounts();renderPeople();
      state.mode2.selected.clear();state.mode2.lastIndex=null;syncSelectionUI('mode2');state.viewer.loaded=false;state.mode1.loaded=false;toast(`Назначено фотографий: ${ids.length}`);
    } finally {markPending('mode2',ids,false);}
  }

  async function resetMode2(){
    const ids=[...state.mode2.selected];if(!ids.length)return;
    markPending('mode2',ids,true);
    try{
      await api('/api/photos/reset',{method:'POST',body:JSON.stringify({photoIds:ids,expectedVersions:expectedVersions('mode2',ids)})});
      state.mode2.photos=state.mode2.photos.filter(p=>!ids.includes(p.id));
      ids.forEach(id=>document.querySelector(`.photo-card[data-scope="mode2"][data-photo-id="${CSS.escape(id)}"]`)?.remove());
      state.mode2.selected.clear();state.mode2.lastIndex=null;recomputePeopleCounts();renderPeople();syncSelectionUI('mode2');els.mode2Empty.classList.toggle('hidden',state.mode2.photos.length>0);
      state.viewer.loaded=false;state.mode1.loaded=false;toast(`Возвращено в RAW: ${ids.length}`);
    } finally {markPending('mode2',ids,false);}
  }

  function showContextMenu(x,y,photoId){state.contextPhotoId=photoId;els.contextMenu.style.left=`${Math.min(x,innerWidth-300)}px`;els.contextMenu.style.top=`${Math.min(y,innerHeight-70)}px`;els.contextMenu.classList.remove('hidden');}
  function hideContextMenu(){els.contextMenu.classList.add('hidden');state.contextPhotoId=null;}

  function openModal(photo){els.modalImage.src=imageUrl(photo);els.modalFileName.textContent=photo.name;els.imageModal.classList.remove('hidden');els.imageModal.setAttribute('aria-hidden','false');}
  function closeModal(){els.imageModal.classList.add('hidden');els.imageModal.setAttribute('aria-hidden','true');els.modalImage.removeAttribute('src');}

  async function refreshMode1Diff() {
    if (!state.mode1.loaded || activeTab() !== 'mode1') return;
    const data=await api('/api/mode1/photos');
    const incoming=data.photos||[];
    const currentIds=new Set(state.mode1.photos.map(p=>p.id));
    const incomingIds=new Set(incoming.map(p=>p.id));
    if (incoming.length!==state.mode1.photos.length || incoming.some(p=>!currentIds.has(p.id)) || state.mode1.photos.some(p=>!incomingIds.has(p.id))) {
      state.mode1.photos=incoming;state.mode1.selected.clear();state.mode1.lastIndex=null;renderMode1();return;
    }
    for(const fresh of incoming){
      const current=state.mode1.photos.find(p=>p.id===fresh.id);
      if(current && Number(current.version)!==Number(fresh.version)){Object.assign(current,fresh);patchCard(document.querySelector(`.photo-card[data-scope="mode1"][data-photo-id="${CSS.escape(fresh.id)}"]`),current);}
    }
  }

  async function refreshMode2Diff() {
    if (!state.mode2.loaded || activeTab() !== 'mode2' || !state.mode2.hall) return;
    const data=await api(`/api/mode2/data?hall=${encodeURIComponent(state.mode2.hall)}`);
    const incoming=data.photos||[];
    const incomingById=new Map(incoming.map(p=>[p.id,p]));
    for(const current of [...state.mode2.photos]){
      if(!incomingById.has(current.id)){
        state.mode2.selected.delete(current.id);
        document.querySelector(`.photo-card[data-scope="mode2"][data-photo-id="${CSS.escape(current.id)}"]`)?.remove();
      }
    }
    state.mode2.photos=state.mode2.photos.filter(p=>incomingById.has(p.id));
    const currentById=new Map(state.mode2.photos.map(p=>[p.id,p]));
    for(const fresh of incoming){
      const current=currentById.get(fresh.id);
      if(current){
        if(Number(current.version)!==Number(fresh.version)){Object.assign(current,fresh);patchCard(document.querySelector(`.photo-card[data-scope="mode2"][data-photo-id="${CSS.escape(fresh.id)}"]`),current);}
      }else{
        state.mode2.photos.push(fresh);
        const card=createPhotoCard(fresh,{scope:'mode2',selectable:true,index:state.mode2.photos.length-1,draggable:true});
        card.addEventListener('dragstart',e=>startPhotoDrag(e,fresh,state.mode2.photos.findIndex(p=>p.id===fresh.id),card));
        card.addEventListener('dragend',endPhotoDrag);
        card.addEventListener('contextmenu',e=>{e.preventDefault();if(!state.mode2.selected.has(fresh.id)){state.mode2.selected.clear();state.mode2.selected.add(fresh.id);state.mode2.lastIndex=state.mode2.photos.findIndex(p=>p.id===fresh.id);syncSelectionUI('mode2');}showContextMenu(e.clientX,e.clientY,fresh.id);});
        els.mode2Grid.appendChild(card);
      }
    }
    state.mode2.people=data.people||[];
    renderPeople();syncSelectionUI('mode2');els.mode2Empty.classList.toggle('hidden',state.mode2.photos.length>0);
  }

  async function liveRefresh() {
    if(document.hidden || !state.root)return;
    if(activeTab()==='mode1')await refreshMode1Diff();
    else if(activeTab()==='mode2')await refreshMode2Diff();
  }

  async function syncProject(){const data=await api('/api/sync',{method:'POST',body:'{}'});state.viewer.loaded=false;state.mode1.loaded=false;state.mode2.loaded=false;toast(`Синхронизация: ${data.photos} фото`);await refreshActive();}
  async function undo(){const data=await api('/api/undo',{method:'POST',body:'{}'});if(!data.ok)return toast(data.message||'Нет действий для отмены');state.viewer.loaded=false;state.mode1.loaded=false;state.mode2.loaded=false;await refreshActive();toast(`Отменено операций: ${data.count}`);}
  async function refreshActive(){const tab=activeTab();if(tab==='viewer')await loadViewer(state.viewer.path||'');else if(tab==='mode1')await loadMode1();else if(tab==='mode2')await loadMode2();}

  els.setupBtn.addEventListener('click',()=>safe(setupRoot));els.setupPath.addEventListener('keydown',e=>{if(e.key==='Enter')safe(setupRoot);});
  els.syncBtn.addEventListener('click',()=>safe(syncProject));els.undoBtn.addEventListener('click',()=>safe(undo));
  els.viewerReloadBtn.addEventListener('click',()=>safe(()=>loadViewer(state.viewer.path||'')));
  els.previewImageButton.addEventListener('click',()=>{if(state.viewer.selected)openModal(state.viewer.selected);});
  els.mode1ReloadBtn.addEventListener('click',()=>safe(loadMode1));els.mode1PeopleBtn.addEventListener('click',()=>safe(()=>applyMode1('people')));els.mode1EquipmentBtn.addEventListener('click',()=>safe(()=>applyMode1('equipment')));els.mode1RawBtn.addEventListener('click',()=>safe(()=>applyMode1('raw')));
  els.mode2Hall.addEventListener('change',()=>safe(async()=>{state.mode2.hall=els.mode2Hall.value;await loadMode2();await refreshSessions();}));els.mode2ReloadBtn.addEventListener('click',()=>safe(loadMode2));els.mode2ResetBtn.addEventListener('click',()=>safe(resetMode2));els.personAddInput.addEventListener('keydown',e=>{if(e.key==='Enter')safe(addPerson);});
  els.contextResetBtn.addEventListener('click',()=>safe(async()=>{hideContextMenu();await resetMode2();}));document.addEventListener('click',e=>{if(!els.contextMenu.contains(e.target))hideContextMenu();});
  els.modalCloseBtn.addEventListener('click',closeModal);els.imageModal.addEventListener('click',e=>{if(e.target===els.imageModal)closeModal();});
  document.addEventListener('keydown',e=>{
    if(e.key==='Escape'){if(!els.imageModal.classList.contains('hidden'))closeModal();hideContextMenu();return;}
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();safe(undo);return;}
    if(e.target.matches('input,textarea,select'))return;
    if(activeTab()==='mode1'){
      if(e.key==='1'){e.preventDefault();safe(()=>applyMode1('people'));}
      else if(e.key==='2'){e.preventDefault();safe(()=>applyMode1('equipment'));}
      else if(e.key==='0'){e.preventDefault();safe(()=>applyMode1('raw'));}
    }
  });

  async function login() {
    els.loginError.classList.add('hidden');
    els.loginBtn.disabled = true;
    try {
      const res = await fetch('/api/auth/login', {
        method:'POST',
        credentials:'same-origin',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({ username:els.loginUsername.value.trim(), password:els.loginPassword.value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Ошибка входа');
      els.loginPassword.value = '';
      showLogin(false);
      await loadProject();
    } catch (err) {
      els.loginError.textContent = err.message;
      els.loginError.classList.remove('hidden');
    } finally {
      els.loginBtn.disabled = false;
    }
  }

  async function logout() {
    try { await fetch('/api/auth/logout', { method:'POST', credentials:'same-origin' }); } catch (_) {}
    closeUpload();
    showLogin(true);
  }

  function openUpload() {
    els.uploadPasswordInput.value = '';
    els.uploadFolderInput.value = '';
    els.uploadSummary.textContent = 'Папка не выбрана';
    els.uploadProgress.value = 0;
    els.uploadProgressText.textContent = '';
    els.uploadStartBtn.disabled = false;
    els.uploadModal.classList.remove('hidden');
    els.uploadModal.setAttribute('aria-hidden','false');
    setTimeout(()=>els.uploadPasswordInput.focus(),0);
  }

  function closeUpload() {
    if (els.uploadStartBtn.dataset.busy === '1') return;
    els.uploadModal.classList.add('hidden');
    els.uploadModal.setAttribute('aria-hidden','true');
  }

  function humanUploadBytes(bytes) {
    const units=['Б','КБ','МБ','ГБ']; let value=Number(bytes||0),i=0;
    while(value>=1024&&i<units.length-1){value/=1024;i++;}
    return `${value.toFixed(i?1:0)} ${units[i]}`;
  }

  function selectedUploadFiles() {
    const files=[...els.uploadFolderInput.files];
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
      return { file, relativePath:parts.join('/') };
    });
  }

  async function adminFetch(url, options, password) {
    return api(url, { ...options, headers:{ ...(options?.headers||{}), 'x-upload-password':password } });
  }

  async function startUpload() {
    const password=els.uploadPasswordInput.value;
    if(!password)throw new Error('Введите пароль загрузки');
    const entries=selectedUploadFiles();
    const verify=await adminFetch('/api/admin/upload/verify',{method:'POST',body:JSON.stringify({})},password);
    const chunkSize=Math.min(Number(verify.maxChunkBytes||8*1024*1024),8*1024*1024);
    const totalBytes=entries.reduce((sum,item)=>sum+item.file.size,0);
    let doneBytes=0;
    let doneFiles=0;
    els.uploadStartBtn.disabled=true;els.uploadStartBtn.dataset.busy='1';els.uploadFolderInput.disabled=true;els.uploadPasswordInput.disabled=true;
    const update=()=>{
      const pct=totalBytes?Math.min(100,doneBytes/totalBytes*100):0;
      els.uploadProgress.value=pct;
      els.uploadProgressText.textContent=`${doneFiles}/${entries.length} файлов · ${humanUploadBytes(doneBytes)} / ${humanUploadBytes(totalBytes)} · ${pct.toFixed(1)}%`;
    };
    update();
    try {
      for(const entry of entries){
        const encoded=encodeURIComponent(entry.relativePath);
        let status=await adminFetch(`/api/admin/upload/status?path=${encoded}&total=${entry.file.size}`,{method:'GET'},password);
        if(status.conflict)throw new Error(`Файл уже существует с другим размером: ${entry.relativePath}`);
        let offset=Number(status.received||0);
        doneBytes+=offset;
        if(status.complete){doneFiles++;update();continue;}
        while(offset<entry.file.size){
          const end=Math.min(entry.file.size,offset+chunkSize);
          const blob=entry.file.slice(offset,end);
          try {
            const result=await adminFetch(`/api/admin/upload/chunk?path=${encoded}&total=${entry.file.size}&offset=${offset}`,{method:'PUT',body:blob},password);
            const next=Number(result.received);
            doneBytes+=Math.max(0,next-offset);offset=next;update();
          } catch(err) {
            if(err.status===409&&Number.isFinite(err.expectedOffset)){
              const next=err.expectedOffset;
              doneBytes+=Math.max(0,next-offset);offset=next;update();continue;
            }
            throw err;
          }
        }
        doneFiles++;update();
      }
      els.uploadProgressText.textContent='Индексирую загруженные фотографии…';
      const finish=await adminFetch('/api/admin/upload/finish',{method:'POST',body:JSON.stringify({})},password);
      state.viewer.loaded=false;state.mode1.loaded=false;state.mode2.loaded=false;
      await loadProject();
      toast(`Загрузка завершена: ${finish.photos} фото в базе`);
      delete els.uploadStartBtn.dataset.busy;
      closeUpload();
    } finally {
      els.uploadStartBtn.disabled=false;els.uploadFolderInput.disabled=false;els.uploadPasswordInput.disabled=false;delete els.uploadStartBtn.dataset.busy;
    }
  }

  async function init() {
    const res=await fetch('/api/auth/status',{credentials:'same-origin'});
    const data=await res.json();
    if(!data.authenticated){showLogin(true);return;}
    showLogin(false);
    await loadProject();
  }

  els.loginForm.addEventListener('submit',e=>{e.preventDefault();login();});
  els.logoutBtn.addEventListener('click',()=>safe(logout));
  els.uploadBtn.addEventListener('click',openUpload);
  els.uploadCloseBtn.addEventListener('click',closeUpload);
  els.uploadCancelBtn.addEventListener('click',closeUpload);
  els.uploadStartBtn.addEventListener('click',()=>safe(startUpload));
  els.uploadFolderInput.addEventListener('change',()=>{
    try { const files=selectedUploadFiles(); const bytes=files.reduce((s,x)=>s+x.file.size,0); els.uploadSummary.textContent=`${files.length} фото · ${humanUploadBytes(bytes)}`; }
    catch(err){els.uploadSummary.textContent=err.message;}
  });
  els.uploadModal.addEventListener('click',e=>{if(e.target===els.uploadModal)closeUpload();});

  setTabs();
  safe(init);
  setInterval(()=>{if(!els.loginScreen.classList.contains('hidden'))return;safe(refreshSessions);},15000);
  setInterval(()=>{if(!els.loginScreen.classList.contains('hidden'))return;safe(liveRefresh);},5000);
})();
