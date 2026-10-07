(() => {
  let sessionId = sessionStorage.getItem('photoSorterSessionId');
  if (!sessionId) {
    sessionId = globalThis.crypto?.randomUUID?.() || `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    sessionStorage.setItem('photoSorterSessionId', sessionId);
  }

  const $ = id => document.getElementById(id);
  const els = {
    loginScreen:$('loginScreen'), loginForm:$('loginForm'), loginName:$('loginName'), loginPin:$('loginPin'), loginBtn:$('loginBtn'), loginError:$('loginError'),
    setupScreen:$('setupScreen'), workspace:$('workspace'), workspaceActions:$('workspaceActions'), projectLabel:$('projectLabel'), activeSessions:$('activeSessions'),
    setupPath:$('setupPath'), setupBtn:$('setupBtn'), logoutBtn:$('logoutBtn'),
    viewerBreadcrumb:$('viewerBreadcrumb'), viewerCount:$('viewerCount'), viewerSearch:$('viewerSearch'), viewerView:$('viewerView'), viewerAddHallBtn:$('viewerAddHallBtn'),
    viewerFolders:$('viewerFolders'), viewerGrid:$('viewerGrid'), viewerEmpty:$('viewerEmpty'),
    previewEmpty:$('previewEmpty'), previewContent:$('previewContent'), previewImageButton:$('previewImageButton'), previewImage:$('previewImage'), previewFileName:$('previewFileName'), previewMeta:$('previewMeta'),
    mode1Selected:$('mode1Selected'), mode1Search:$('mode1Search'), mode1View:$('mode1View'), mode1PeopleBtn:$('mode1PeopleBtn'), mode1EquipmentBtn:$('mode1EquipmentBtn'), mode1RawBtn:$('mode1RawBtn'), mode1FilterPeople:$('mode1FilterPeople'), mode1FilterEquipment:$('mode1FilterEquipment'), mode1FilterRaw:$('mode1FilterRaw'), mode1FilterPeopleCount:$('mode1FilterPeopleCount'), mode1FilterEquipmentCount:$('mode1FilterEquipmentCount'), mode1FilterRawCount:$('mode1FilterRawCount'), mode1Empty:$('mode1Empty'), mode1Groups:$('mode1Groups'),
    mode2Hall:$('mode2Hall'), mode2Selected:$('mode2Selected'), mode2Search:$('mode2Search'), mode2View:$('mode2View'), mode2ResetBtn:$('mode2ResetBtn'), personAddInput:$('personAddInput'), peopleList:$('peopleList'), mode2Empty:$('mode2Empty'), mode2Grid:$('mode2Grid'),
    contextMenu:$('contextMenu'), contextResetBtn:$('contextResetBtn'), viewerContextMenu:$('viewerContextMenu'), viewerContextTitle:$('viewerContextTitle'), viewerMoveTargets:$('viewerMoveTargets'), instructionBtn:$('instructionBtn'), instructionModal:$('instructionModal'), instructionCloseBtn:$('instructionCloseBtn'), imageModal:$('imageModal'), modalImage:$('modalImage'), modalFileName:$('modalFileName'), modalCloseBtn:$('modalCloseBtn'),
    toast:$('toast'),
  };

  const loginPinInputs = [...document.querySelectorAll('.pin-digit')];
  const loginPinValue = () => loginPinInputs.map(input => input.value).join('');
  const clearLoginPin = () => loginPinInputs.forEach(input => { input.value = ''; });

  const state = {
    root:null, halls:[],
    viewer:{ path:'', loaded:false, selected:null, photos:[], selectedIds:new Set(), lastIndex:null, previewRequest:0, search:'', view:localStorage.getItem('photoSorterViewViewer') || 'grid' },
    mode1:{ photos:[], selected:new Set(), lastIndex:null, loaded:false, filters:{people:true,equipment:true,raw:true}, search:'', view:localStorage.getItem('photoSorterViewMode1') || 'grid' },
    mode2:{ hall:'', people:[], photos:[], selected:new Set(), lastIndex:null, loaded:false, search:'', view:localStorage.getItem('photoSorterViewMode2') || 'grid' },
    contextPhotoId:null,
    sessionStream:null,
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
      stopSessionStream();
      els.setupScreen.classList.add('hidden');
      els.workspace.classList.add('hidden');
      els.workspaceActions.classList.add('hidden');
      els.projectLabel.textContent = 'Требуется вход';
      setTimeout(() => (els.loginName.value.trim() ? loginPinInputs[0] : els.loginName).focus(), 0);
    }
  }

  const headerValue = value => encodeURIComponent(String(value ?? ''));

  async function api(url, options = {}) {
    const headers = {
      ...(options.headers || {}),
      'x-session-id':sessionId,
      'x-client-mode':headerValue(activeTab()),
      'x-client-hall':headerValue(currentHallForPresence()),
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
  const thumbUrl = photo => assetUrl('thumb', photo);

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

  const normalizeQuery = value => String(value || '').trim().toLocaleLowerCase('ru');
  function photoMatchesQuery(photo, query) {
    const q=normalizeQuery(query); if(!q)return true;
    return [photo?.name,photo?.originalFilename,photo?.personName,photo?.hall,photo?.relativePath]
      .filter(Boolean).some(value=>String(value).toLocaleLowerCase('ru').includes(q));
  }
  function normalizeView(value) { return ['grid','large','table'].includes(value) ? value : 'grid'; }
  function applyGridView(grid, value) {
    if(!grid)return;
    const view=normalizeView(value);grid.classList.toggle('view-large',view==='large');grid.classList.toggle('view-table',view==='table');
  }
  function applyViewMode(scope) {
    if(scope==='viewer')applyGridView(els.viewerGrid,state.viewer.view);
    if(scope==='mode1')document.querySelectorAll('#mode1Groups .photo-grid').forEach(grid=>applyGridView(grid,state.mode1.view));
    if(scope==='mode2')applyGridView(els.mode2Grid,state.mode2.view);
  }

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

  function renderSessions(sessions = []) {
    els.activeSessions.innerHTML = '';
    for (const item of sessions.slice(0, 8)) {
      const pill = document.createElement('div');
      pill.className = `session-pill${item.id === sessionId ? ' current' : ''}`;
      const mode = item.mode === 'mode1' ? 'Люди / оборудование' : item.mode === 'mode2' ? 'Люди / ФИО' : 'Файлы';
      const detail = `${item.display_name}${item.id === sessionId ? ' (вы)' : ''} · ${mode}${item.hall ? ` · ${item.hall}` : ''}`;
      pill.title = detail;
      pill.innerHTML = `<span class="session-dot"></span><span class="session-text">${escapeHtml(detail)}</span>`;
      els.activeSessions.appendChild(pill);
    }
  }

  async function refreshSessions() {
    const data = await api('/api/sessions');
    renderSessions(data.sessions || []);
  }

  async function pingPresence() {
    try { await api('/api/session', { method:'POST', body:'{}' }); } catch (_) {}
  }

  function stopSessionStream() {
    if (state.sessionStream) { state.sessionStream.close(); state.sessionStream = null; }
  }

  function startSessionStream() {
    stopSessionStream();
    if (els.loginScreen && !els.loginScreen.classList.contains('hidden')) return;
    const stream = new EventSource(`/api/sessions/stream?sessionId=${encodeURIComponent(sessionId)}&mode=${encodeURIComponent(activeTab())}&hall=${encodeURIComponent(currentHallForPresence())}`);
    stream.addEventListener('sessions', event => {
      try { renderSessions(JSON.parse(event.data || '[]')); } catch (err) { console.warn('Session stream parse error', err); }
    });
    stream.onerror = () => { /* EventSource reconnects automatically. */ };
    state.sessionStream = stream;
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
    startSessionStream();
    await pingPresence();
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
    document.querySelectorAll('.tab[data-tab]').forEach(tab => tab.addEventListener('click', () => safe(async () => {
      document.querySelectorAll('.tab[data-tab]').forEach(x=>x.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(x=>x.classList.remove('active'));
      tab.classList.add('active');
      $(tab.dataset.tab).classList.add('active');
      hideContextMenu();
      if (tab.dataset.tab === 'viewer' && !state.viewer.loaded) await loadViewer(state.viewer.path || '');
      if (tab.dataset.tab === 'mode1' && !state.mode1.loaded) await loadMode1();
      if (tab.dataset.tab === 'mode2' && !state.mode2.loaded) await loadMode2();
      await pingPresence();
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

  function viewerVisiblePhotos() { return state.viewer.photos.filter(photo=>photoMatchesQuery(photo,state.viewer.search)); }

  function syncViewerSelectionUI() {
    document.querySelectorAll('#viewerGrid .photo-card').forEach(card=>card.classList.toggle('selected',state.viewer.selectedIds.has(card.dataset.photoId)));
  }

  function applyViewerSearch() {
    const visibleIds=new Set(viewerVisiblePhotos().map(photo=>photo.id || photo.relativePath));
    let visible=0;
    document.querySelectorAll('#viewerGrid .photo-card').forEach(card=>{
      const key=card.dataset.photoId || card.dataset.relativePath;
      const show=visibleIds.has(key);card.classList.toggle('search-hidden',!show);if(show)visible++;
    });
    for(const id of [...state.viewer.selectedIds])if(!visibleIds.has(id))state.viewer.selectedIds.delete(id);
    state.viewer.lastIndex=null;syncViewerSelectionUI();
    const folderCount=els.viewerFolders.children.length;
    const total=state.viewer.photos.length;
    els.viewerCount.textContent=state.viewer.search?`${folderCount} папок · ${visible} из ${total} фото`:`${folderCount} папок · ${total} фото`;
    els.viewerEmpty.classList.toggle('hidden',folderCount + visible > 0);
  }

  async function loadViewer(relativePath = state.viewer.path || '') {
    const data = await api(`/api/browser/list?path=${encodeURIComponent(relativePath || '')}`);
    state.viewer.path = data.path || '';
    state.viewer.loaded = true;
    state.viewer.selected = null;state.viewer.selectedIds.clear();state.viewer.lastIndex=null;
    pingPresence();
    renderBreadcrumb(state.viewer.path);
    els.viewerAddHallBtn.classList.toggle('hidden',Boolean(state.viewer.path));
    els.viewerFolders.innerHTML = '';
    const viewerPathParts=String(state.viewer.path||'').split(/[\\/]+/).filter(Boolean);
    const inPeopleRoot=viewerPathParts.length===2 && viewerPathParts[1].toLocaleLowerCase('ru')==='люди';
    data.directories.forEach(dir => {
      const btn = document.createElement('button'); btn.className='folder-card';
      btn.innerHTML = `<span class="folder-card-main"><span class="folder-icon">📁</span><span class="folder-name">${escapeHtml(dir.name)}</span>${dir.custom?'<span class="folder-custom-badge">создан вручную</span>':''}</span><span class="folder-photo-count">${Number(dir.photoCount || 0)} фото</span>`;
      btn.addEventListener('click', ()=>safe(()=>loadViewer(dir.relativePath)));
      if(viewerPathParts.length===0 && dir.custom){
        btn.title='Правый клик — переименовать или удалить зал';
        btn.addEventListener('contextmenu',e=>{e.preventDefault();showCustomHallContextMenu(e.clientX,e.clientY,dir.name);});
      }
      if(inPeopleRoot){
        btn.title='Правый клик — перенести всё ФИО в другой зал';
        btn.addEventListener('contextmenu',e=>{e.preventDefault();showViewerPersonFolderContextMenu(e.clientX,e.clientY,viewerPathParts[0],dir.name);});
      }
      els.viewerFolders.appendChild(btn);
    });
    state.viewer.photos=(data.images||[]).map(item=>{
      const photo={...(item.photo || { id:null, status:null, personName:null })};
      photo.relativePath=item.relativePath;photo.name=item.name;return photo;
    });
    els.viewerGrid.innerHTML = '';
    state.viewer.photos.forEach((photo,index) => {
      const card = createPhotoCard(photo, { scope:'viewer', selectable:false });
      card.dataset.relativePath=photo.relativePath||'';
      card.addEventListener('click', e=>safe(()=>handleViewerSelect(photo,index,e)));
      card.addEventListener('contextmenu',e=>{e.preventDefault();safe(()=>openViewerMoveMenu(e,photo,index));});
      els.viewerGrid.appendChild(card);
    });
    applyViewMode('viewer');applyViewerSearch();clearPreview();
  }

  async function handleViewerSelect(photo,index,event) {
    const visible=viewerVisiblePhotos();const visibleIndex=visible.findIndex(item=>(item.id||item.relativePath)===(photo.id||photo.relativePath));
    const key=photo.id || photo.relativePath;
    if(event.shiftKey && state.viewer.lastIndex!=null && visibleIndex>=0){
      const a=Math.min(state.viewer.lastIndex,visibleIndex),b=Math.max(state.viewer.lastIndex,visibleIndex);for(let i=a;i<=b;i++){const item=visible[i];if(item?.id)state.viewer.selectedIds.add(item.id);}
    }else if(event.ctrlKey||event.metaKey){if(photo.id){if(state.viewer.selectedIds.has(photo.id))state.viewer.selectedIds.delete(photo.id);else state.viewer.selectedIds.add(photo.id);}state.viewer.lastIndex=visibleIndex;}
    else{state.viewer.selectedIds.clear();if(photo.id)state.viewer.selectedIds.add(photo.id);state.viewer.lastIndex=visibleIndex;}
    syncViewerSelectionUI();
    await selectViewerPhoto(photo);
  }

  async function selectViewerPhoto(photo) {
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
    if (card.dataset.scope === 'mode1') card.dataset.filterKey = mode1FilterKey(photo);
    const badges=card.querySelector('.photo-badges'); if (badges) badges.innerHTML=buildBadges(photo);
    const name=card.querySelector('.photo-name'); if (name) name.textContent=photo.name||'';
    const img=card.querySelector('.photo-thumb img'); if (img) img.alt=photo.name||'';
  }

  function createPhotoCard(photo, { scope, selectable=true, index=null, draggable=false }={}) {
    const card=document.createElement('div'); card.className='photo-card'; card.tabIndex=0;
    if(photo.id) card.dataset.photoId=photo.id; card.dataset.scope=scope||''; card.dataset.version=String(photo.version||1);
    if(scope==='mode1') card.dataset.filterKey=mode1FilterKey(photo);
    if(draggable) card.draggable=true;
    const frame=document.createElement('div');frame.className='photo-thumb';
    const img=document.createElement('img');img.alt=photo.name||'';img.draggable=false;img.loading='lazy';img.decoding='async';lazyImage(img,thumbUrl(photo));frame.appendChild(img);
    const badges=document.createElement('div');badges.className='photo-badges';badges.innerHTML=buildBadges(photo);
    const name=document.createElement('div');name.className='photo-name';name.textContent=photo.name||'';
    card.append(frame,badges,name);
    if(selectable) card.addEventListener('click',e=>handleSelect(scope,photo,selectionState(scope).photos.findIndex(p=>p.id===photo.id),e));
    card.addEventListener('dblclick',e=>{e.preventDefault();openModal(photo);});
    return card;
  }

  function selectionState(scope) { return scope==='mode1'?state.mode1:state.mode2; }
  function selectionPhotos(scope) { return scope==='mode1'?mode1VisiblePhotos():mode2VisiblePhotos(); }
  function handleSelect(scope, photo, index, event) {
    const s=selectionState(scope); if(!photo.id)return;
    index=selectionPhotos(scope).findIndex(p=>p.id===photo.id);
    if(event.shiftKey && s.lastIndex!=null && index!=null){
      const photos=selectionPhotos(scope); const a=Math.min(s.lastIndex,index),b=Math.max(s.lastIndex,index); for(let i=a;i<=b;i++)if(photos[i]?.id)s.selected.add(photos[i].id);
    } else if(event.ctrlKey||event.metaKey){ if(s.selected.has(photo.id))s.selected.delete(photo.id);else s.selected.add(photo.id); s.lastIndex=index; }
    else { s.selected.clear(); s.selected.add(photo.id); s.lastIndex=index; }
    syncSelectionUI(scope);
  }

  function syncSelectionUI(scope) {
    const s=selectionState(scope);
    document.querySelectorAll(`.photo-card[data-scope="${scope}"].selected`).forEach(card=>{
      if(!s.selected.has(card.dataset.photoId))card.classList.remove('selected');
    });
    for(const id of s.selected){
      const card=document.querySelector(`.photo-card[data-scope="${scope}"][data-photo-id="${CSS.escape(id)}"]`);
      if(card&&!card.classList.contains('selected'))card.classList.add('selected');
    }
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

  function mode1FilterKey(photo) {
    if (photo?.status === 'equipment') return 'equipment';
    if (photo?.status === 'raw') return 'raw';
    if (photo?.status === 'people' || photo?.status === 'person') return 'people';
    return 'raw';
  }

  function mode1PhotoVisible(photo) {
    return state.mode1.filters[mode1FilterKey(photo)] !== false && photoMatchesQuery(photo,state.mode1.search);
  }

  function mode1VisiblePhotos() {
    return state.mode1.photos.filter(mode1PhotoVisible);
  }

  function mode1Counts() {
    const total={people:0,equipment:0,raw:0};
    const halls=new Map();
    for (const photo of state.mode1.photos) {
      const key=mode1FilterKey(photo);
      total[key]+=1;
      if(!halls.has(photo.hall))halls.set(photo.hall,{people:0,equipment:0,raw:0});
      halls.get(photo.hall)[key]+=1;
    }
    return { total, halls };
  }

  function updateMode1FilterChips(counts = null) {
    const total=(counts || mode1Counts()).total;
    els.mode1FilterPeopleCount.textContent=String(total.people);
    els.mode1FilterEquipmentCount.textContent=String(total.equipment);
    els.mode1FilterRawCount.textContent=String(total.raw);
    for (const [key,button] of [['people',els.mode1FilterPeople],['equipment',els.mode1FilterEquipment],['raw',els.mode1FilterRaw]]) {
      const active=state.mode1.filters[key] !== false;
      button.classList.toggle('active',active);
      button.setAttribute('aria-pressed',String(active));
    }
  }

  function applyMode1Filters() {
    const counts=mode1Counts();
    els.mode1Groups.classList.toggle('hide-people',state.mode1.filters.people===false);
    els.mode1Groups.classList.toggle('hide-equipment',state.mode1.filters.equipment===false);
    els.mode1Groups.classList.toggle('hide-raw',state.mode1.filters.raw===false);

    const byId=new Map(state.mode1.photos.map(photo=>[photo.id,photo]));
    let selectionChanged=false;
    for (const id of [...state.mode1.selected]) {
      const photo=byId.get(id);
      if (!photo || !mode1PhotoVisible(photo)) {
        state.mode1.selected.delete(id);
        const card=document.querySelector(`.photo-card[data-scope="mode1"][data-photo-id="${CSS.escape(id)}"]`);
        if(card)card.classList.remove('selected');
        selectionChanged=true;
      }
    }
    state.mode1.lastIndex=null;

    document.querySelectorAll('#mode1Groups .photo-card').forEach(card=>{
      const photo=byId.get(card.dataset.photoId);card.classList.toggle('search-hidden',Boolean(photo && !photoMatchesQuery(photo,state.mode1.search)));
    });

    const visibleByHall=new Map();
    for(const photo of state.mode1.photos){if(mode1PhotoVisible(photo))visibleByHall.set(photo.hall,(visibleByHall.get(photo.hall)||0)+1);}
    let visibleTotal=0;
    document.querySelectorAll('#mode1Groups .hall-group').forEach(section=>{
      const visible=visibleByHall.get(section.dataset.hall)||0;
      visibleTotal+=visible;
      section.classList.toggle('hidden',visible===0);
      const title=section.querySelector('.hall-title');
      if(title) title.textContent=`ЗАЛ: ${section.dataset.hall || ''} · ${visible} фото`;
    });

    els.mode1Empty.classList.toggle('hidden',visibleTotal>0);
    updateMode1FilterChips(counts);
    els.mode1Selected.textContent=`Выбрано: ${state.mode1.selected.size}`;
    const disabled=!state.mode1.selected.size;
    els.mode1PeopleBtn.disabled=disabled;els.mode1EquipmentBtn.disabled=disabled;els.mode1RawBtn.disabled=disabled;
    if(selectionChanged) state.mode1.lastIndex=null;
  }

  function toggleMode1Filter(key) {
    state.mode1.filters[key]=!state.mode1.filters[key];
    applyMode1Filters();
  }

  async function loadMode1() {
    const data=await api('/api/mode1/photos');
    state.mode1.photos=data.photos||[];state.mode1.selected.clear();state.mode1.lastIndex=null;state.mode1.loaded=true;
    renderMode1();
  }
  function renderMode1() {
    els.mode1Groups.innerHTML='';
    const groups=new Map(); state.mode1.photos.forEach((p,i)=>{if(!groups.has(p.hall))groups.set(p.hall,[]);groups.get(p.hall).push({p,i});});
    for(const [hall,items] of groups){
      const section=document.createElement('section');section.className='hall-group';section.dataset.hall=hall;
      const title=document.createElement('h2');title.className='hall-title';title.textContent=`ЗАЛ: ${hall} · ${items.length} фото`;
      const grid=document.createElement('div');grid.className='photo-grid';items.forEach(({p,i})=>grid.appendChild(createPhotoCard(p,{scope:'mode1',selectable:true,index:i})));
      section.append(title,grid);els.mode1Groups.appendChild(section);
    }
    applyViewMode('mode1');applyMode1Filters();
  }

  async function applyMode1(target) {
    const ids=[...state.mode1.selected];if(!ids.length)return;
    markPending('mode1',ids,true);
    try {
      const data=await api('/api/mode1/classify',{method:'POST',body:JSON.stringify({photoIds:ids,target,expectedVersions:expectedVersions('mode1',ids)})});
      patchStatePhotos('mode1',data.photos||[]);
      state.mode1.selected.clear();state.mode1.lastIndex=null;applyMode1Filters();
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
  function mode2VisiblePhotos(){return state.mode2.photos.filter(photo=>photoMatchesQuery(photo,state.mode2.search));}
  function applyMode2Search(){
    const visibleIds=new Set(mode2VisiblePhotos().map(photo=>photo.id));
    document.querySelectorAll('#mode2Grid .photo-card').forEach(card=>card.classList.toggle('search-hidden',!visibleIds.has(card.dataset.photoId)));
    for(const id of [...state.mode2.selected])if(!visibleIds.has(id))state.mode2.selected.delete(id);
    state.mode2.lastIndex=null;syncSelectionUI('mode2');els.mode2Empty.classList.toggle('hidden',visibleIds.size>0);
  }
  function renderMode2() {
    renderPeople(); els.mode2Grid.innerHTML='';
    state.mode2.photos.forEach((photo,index)=>{
      const card=createPhotoCard(photo,{scope:'mode2',selectable:true,index,draggable:true});
      card.addEventListener('dragstart',e=>startPhotoDrag(e,photo,state.mode2.photos.findIndex(p=>p.id===photo.id),card));
      card.addEventListener('dragend',endPhotoDrag);
      card.addEventListener('contextmenu',e=>{e.preventDefault();if(!state.mode2.selected.has(photo.id)){state.mode2.selected.clear();state.mode2.selected.add(photo.id);state.mode2.lastIndex=index;syncSelectionUI('mode2');}showContextMenu(e.clientX,e.clientY,photo.id);});
      els.mode2Grid.appendChild(card);
    }); applyViewMode('mode2');applyMode2Search();
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
    dragGhost=document.createElement('div');dragGhost.className='drag-ghost';dragGhost.innerHTML=`<img src="${thumbUrl(photo)}" alt=""><div>${state.mode2.selected.size>1?`${state.mode2.selected.size} фото`:'Фото → ФИО'}</div>`;document.body.appendChild(dragGhost);e.dataTransfer.setDragImage(dragGhost,70,50);card.style.opacity='.65';card.dataset.dragging='1';
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

  function viewerExpectedVersions(ids){
    const map={};for(const id of ids){const photo=state.viewer.photos.find(item=>item.id===id);if(photo)map[id]=Number(photo.version||1);}return map;
  }

  function hideViewerContextMenu(){els.viewerContextMenu.classList.add('hidden');}

  function renderViewerMoveTargets(sourceHall, onTarget, unavailableMessage = null, labelForHall = hall => hall){
    const targets=state.halls.filter(hall=>hall.localeCompare(sourceHall,'ru',{sensitivity:'base'})!==0);
    els.viewerMoveTargets.innerHTML='';
    if(unavailableMessage){
      const empty=document.createElement('div');empty.className='context-empty';empty.textContent=unavailableMessage;els.viewerMoveTargets.appendChild(empty);
    }else if(!targets.length){
      const empty=document.createElement('div');empty.className='context-empty';empty.textContent='Нет другого зала для переноса.';els.viewerMoveTargets.appendChild(empty);
    }else{
      for(const hall of targets){
        const btn=document.createElement('button');btn.type='button';btn.textContent=labelForHall(hall);
        btn.addEventListener('click',()=>safe(()=>onTarget(hall)));
        els.viewerMoveTargets.appendChild(btn);
      }
    }
    return targets.length;
  }

  function positionViewerContextMenu(x,y,targetCount){
    els.viewerContextMenu.style.left=`${Math.min(x,innerWidth-340)}px`;
    els.viewerContextMenu.style.top=`${Math.min(y,innerHeight-Math.min(480,80+targetCount*38))}px`;
    els.viewerContextMenu.classList.remove('hidden');
  }

  function showViewerContextMenu(x,y,sourcePhoto){
    hideContextMenu();
    const sourceHall=sourcePhoto?.hall || String(state.viewer.path||'').split(/[\\/]+/).filter(Boolean)[0] || '';
    els.viewerContextTitle.textContent=state.viewer.selectedIds.size>1
      ? `Переместить ${state.viewer.selectedIds.size} фото в зал`
      : 'Переместить фото в зал';
    const unavailable=!sourcePhoto?.id || !['raw','people','person','equipment'].includes(sourcePhoto?.status)
      ? 'Для этого файла перенос между залами недоступен.'
      : null;
    const destinationLabel=hall=>{
      if(sourcePhoto?.status==='raw')return `${hall} / RAW`;
      if(sourcePhoto?.status==='equipment')return `${hall} / Оборудование`;
      if(sourcePhoto?.status==='people')return `${hall} / Люди`;
      if(sourcePhoto?.status==='person')return `${hall} / Люди / ${sourcePhoto.personName || 'ФИО'}`;
      return hall;
    };
    const targetCount=renderViewerMoveTargets(sourceHall,moveViewerSelectionToHall,unavailable,destinationLabel);
    positionViewerContextMenu(x,y,targetCount);
  }

  function showViewerPersonFolderContextMenu(x,y,sourceHall,personName){
    hideContextMenu();
    state.viewer.selectedIds.clear();state.viewer.lastIndex=null;syncViewerSelectionUI();
    els.viewerContextTitle.textContent=`Переместить «${personName}» в зал`;
    const targetCount=renderViewerMoveTargets(sourceHall,hall=>moveViewerPersonFolderToHall(sourceHall,personName,hall),null,hall=>`${hall} / Люди / ${personName}`);
    positionViewerContextMenu(x,y,targetCount);
  }

  function showCustomHallContextMenu(x,y,hallName){
    hideContextMenu();state.viewer.selectedIds.clear();syncViewerSelectionUI();
    els.viewerContextTitle.textContent=`Зал «${hallName}»`;els.viewerMoveTargets.innerHTML='';
    const rename=document.createElement('button');rename.type='button';rename.textContent='Переименовать';rename.addEventListener('click',()=>safe(()=>renameCustomHall(hallName)));
    const remove=document.createElement('button');remove.type='button';remove.className='danger-menu-item';remove.textContent='Удалить зал';remove.addEventListener('click',()=>safe(()=>deleteCustomHall(hallName)));
    els.viewerMoveTargets.append(rename,remove);positionViewerContextMenu(x,y,2);
  }

  async function renameCustomHall(hallName){
    const name=prompt('Новое название зала',hallName);if(!name?.trim()||name.trim()===hallName){hideViewerContextMenu();return;}
    const data=await api(`/api/halls/${encodeURIComponent(hallName)}`,{method:'PATCH',body:JSON.stringify({name:name.trim()})});
    hideViewerContextMenu();state.halls=data.halls||state.halls;fillHallSelect();state.mode1.loaded=false;state.mode2.loaded=false;await loadViewer('');toast(`Зал «${hallName}» переименован в «${data.hall?.name || name.trim()}»`);
  }

  async function deleteCustomHall(hallName){
    if(!confirm(`Удалить созданный зал «${hallName}»?\n\nФотографии будут возвращены в предыдущие залы. Если для какой-либо фотографии предыдущий зал неизвестен, удаление будет отменено.`))return;
    const data=await api(`/api/halls/${encodeURIComponent(hallName)}`,{method:'DELETE',body:'{}'});
    hideViewerContextMenu();state.halls=data.halls||state.halls;fillHallSelect();state.mode1.loaded=false;state.mode2.loaded=false;await loadViewer('');toast(`Зал «${hallName}» удалён. Возвращено фото: ${Number(data.restored||0)}`);
  }

  function openViewerMoveMenu(event,photo,index){
    if(photo.id&&!state.viewer.selectedIds.has(photo.id)){
      state.viewer.selectedIds.clear();state.viewer.selectedIds.add(photo.id);state.viewer.lastIndex=viewerVisiblePhotos().findIndex(item=>item.id===photo.id);syncViewerSelectionUI();
    }
    state.viewer.selected=photo;safe(()=>selectViewerPhoto(photo));
    showViewerContextMenu(event.clientX,event.clientY,photo);
  }

  async function moveViewerSelectionToHall(targetHall){
    const ids=[...state.viewer.selectedIds];if(!ids.length)throw new Error('Выберите фотографии для переноса');
    const data=await api('/api/browser/move-to-hall',{method:'POST',body:JSON.stringify({photoIds:ids,targetHall,expectedVersions:viewerExpectedVersions(ids)})});
    hideViewerContextMenu();
    state.halls=data.halls||state.halls;fillHallSelect();state.mode1.loaded=false;state.mode2.loaded=false;
    await loadViewer(state.viewer.path||'');
    toast(`Перемещено в «${targetHall}»: ${ids.length} фото`);
  }

  async function moveViewerPersonFolderToHall(sourceHall,personName,targetHall){
    const data=await api('/api/browser/move-person-folder',{method:'POST',body:JSON.stringify({sourceHall,personName,targetHall})});
    hideViewerContextMenu();
    state.halls=data.halls||state.halls;fillHallSelect();state.mode1.loaded=false;state.mode2.loaded=false;
    await loadViewer(state.viewer.path||'');
    toast(`«${personName}» → «${targetHall}»: ${Number(data.movedCount||0)} фото`);
  }

  async function addHall(){
    if(state.viewer.path)throw new Error('Новый зал можно создать только в корне проекта');
    const name=prompt('Название новой папки / зала');if(!name?.trim())return;
    const data=await api('/api/halls',{method:'POST',body:JSON.stringify({name:name.trim()})});
    state.halls=data.halls||state.halls;fillHallSelect();state.mode1.loaded=false;state.mode2.loaded=false;
    await loadViewer('');toast(`Создана папка «${data.hall?.name || name.trim()}»`);
  }

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
    applyMode1Filters();
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
    renderPeople();applyViewMode('mode2');applyMode2Search();
  }

  async function liveRefresh() {
    if(document.hidden || !state.root)return;
    if(activeTab()==='mode1')await refreshMode1Diff();
    else if(activeTab()==='mode2')await refreshMode2Diff();
  }

  async function refreshActive(){const tab=activeTab();if(tab==='viewer')await loadViewer(state.viewer.path||'');else if(tab==='mode1')await loadMode1();else if(tab==='mode2')await loadMode2();}

  function openInstruction() {
    els.instructionModal.classList.remove('hidden');
    els.instructionModal.setAttribute('aria-hidden', 'false');
  }

  function closeInstruction() {
    els.instructionModal.classList.add('hidden');
    els.instructionModal.setAttribute('aria-hidden', 'true');
  }

  els.setupBtn.addEventListener('click',()=>safe(setupRoot));els.setupPath.addEventListener('keydown',e=>{if(e.key==='Enter')safe(setupRoot);});
  els.previewImageButton.addEventListener('click',()=>{if(state.viewer.selected)openModal(state.viewer.selected);});
  els.viewerAddHallBtn.addEventListener('click',()=>safe(addHall));
  els.viewerSearch.addEventListener('input',()=>{state.viewer.search=els.viewerSearch.value;applyViewerSearch();});
  els.viewerView.addEventListener('change',()=>{state.viewer.view=normalizeView(els.viewerView.value);localStorage.setItem('photoSorterViewViewer',state.viewer.view);applyViewMode('viewer');});
  els.mode1PeopleBtn.addEventListener('click',()=>safe(()=>applyMode1('people')));els.mode1EquipmentBtn.addEventListener('click',()=>safe(()=>applyMode1('equipment')));els.mode1RawBtn.addEventListener('click',()=>safe(()=>applyMode1('raw')));
  els.mode1Search.addEventListener('input',()=>{state.mode1.search=els.mode1Search.value;applyMode1Filters();});
  els.mode1View.addEventListener('change',()=>{state.mode1.view=normalizeView(els.mode1View.value);localStorage.setItem('photoSorterViewMode1',state.mode1.view);applyViewMode('mode1');});
  els.mode1FilterPeople.addEventListener('click',()=>toggleMode1Filter('people'));
  els.mode1FilterEquipment.addEventListener('click',()=>toggleMode1Filter('equipment'));
  els.mode1FilterRaw.addEventListener('click',()=>toggleMode1Filter('raw'));
  els.mode2Search.addEventListener('input',()=>{state.mode2.search=els.mode2Search.value;applyMode2Search();});
  els.mode2View.addEventListener('change',()=>{state.mode2.view=normalizeView(els.mode2View.value);localStorage.setItem('photoSorterViewMode2',state.mode2.view);applyViewMode('mode2');});
  els.mode2Hall.addEventListener('change',()=>safe(async()=>{state.mode2.hall=els.mode2Hall.value;await loadMode2();await pingPresence();}));els.mode2ResetBtn.addEventListener('click',()=>safe(resetMode2));els.personAddInput.addEventListener('keydown',e=>{if(e.key==='Enter')safe(addPerson);});
  els.contextResetBtn.addEventListener('click',()=>safe(async()=>{hideContextMenu();await resetMode2();}));document.addEventListener('click',e=>{if(!els.contextMenu.contains(e.target))hideContextMenu();if(!els.viewerContextMenu.contains(e.target))hideViewerContextMenu();});
  els.instructionBtn.addEventListener('click',openInstruction);els.instructionCloseBtn.addEventListener('click',closeInstruction);els.instructionModal.addEventListener('click',e=>{if(e.target===els.instructionModal)closeInstruction();});
  els.modalCloseBtn.addEventListener('click',closeModal);els.imageModal.addEventListener('click',e=>{if(e.target===els.imageModal)closeModal();});
  document.addEventListener('keydown',e=>{
    if(e.key==='Escape'){if(!els.instructionModal.classList.contains('hidden'))closeInstruction();if(!els.imageModal.classList.contains('hidden'))closeModal();hideContextMenu();hideViewerContextMenu();return;}
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
      const name = els.loginName.value.trim().replace(/\s+/g, ' ');
      const password = loginPinValue();
      if (!name) { els.loginName.focus(); throw new Error('Введите имя'); }
      if (!/^\d{5}$/.test(password)) { (loginPinInputs.find(input => !input.value) || loginPinInputs[0]).focus(); throw new Error('Введите 5 цифр PIN-кода'); }
      const res = await fetch('/api/auth/login', {
        method:'POST',
        credentials:'same-origin',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({ name, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Ошибка входа');
      localStorage.setItem('photoSorterLastName', name);
      clearLoginPin();
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
    stopSessionStream();
    showLogin(true);
  }

  async function init() {
    const res=await fetch('/api/auth/status',{credentials:'same-origin'});
    const data=await res.json();
    if(!data.authenticated){showLogin(true);return;}
    showLogin(false);
    await loadProject();
  }

  els.viewerSearch.value=state.viewer.search;els.mode1Search.value=state.mode1.search;els.mode2Search.value=state.mode2.search;
  els.viewerView.value=normalizeView(state.viewer.view);els.mode1View.value=normalizeView(state.mode1.view);els.mode2View.value=normalizeView(state.mode2.view);

  els.loginName.value = localStorage.getItem('photoSorterLastName') || '';
  loginPinInputs.forEach((input, index) => {
    input.addEventListener('input', () => {
      input.value = input.value.replace(/\D/g, '').slice(-1);
      if (input.value && index < loginPinInputs.length - 1) loginPinInputs[index + 1].focus();
    });
    input.addEventListener('keydown', event => {
      if (event.key === 'Backspace' && !input.value && index > 0) loginPinInputs[index - 1].focus();
      if (event.key === 'ArrowLeft' && index > 0) { event.preventDefault(); loginPinInputs[index - 1].focus(); }
      if (event.key === 'ArrowRight' && index < loginPinInputs.length - 1) { event.preventDefault(); loginPinInputs[index + 1].focus(); }
    });
    input.addEventListener('paste', event => {
      const digits = (event.clipboardData?.getData('text') || '').replace(/\D/g, '').slice(0, 5);
      if (!digits) return;
      event.preventDefault();
      loginPinInputs.forEach((field, i) => { field.value = digits[i] || ''; });
      loginPinInputs[Math.min(digits.length, 5) - 1].focus();
    });
  });

  els.loginForm.addEventListener('submit',e=>{e.preventDefault();login();});
  els.logoutBtn.addEventListener('click',()=>safe(logout));

  setTabs();
  safe(init);
  setInterval(()=>{if(!els.loginScreen.classList.contains('hidden'))return;safe(refreshSessions);},60000);
  setInterval(()=>{if(!els.loginScreen.classList.contains('hidden'))return;safe(liveRefresh);},5000);
})();
