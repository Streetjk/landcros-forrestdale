/* global SnAuthGate,SiteNavStaffNav */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const siteParam = new URLSearchParams(location.search).get('site') || 'landcros';
  const SITE = /^[a-z0-9][a-z0-9-]{1,62}$/.test(siteParam) ? siteParam : 'landcros';
  const API = `/api/sites/${encodeURIComponent(SITE)}/fire-ops`;
  const DEPARTMENTS = ['Mining','Workshop','REMAN','Parts Receival','Parts Despatch','Facilities','Office','Other'];
  const TRADES = ['Boilermaker','Fitter','Electrician','Mechanic','Welder','Supervisor','Other'];
  const STATUSES = {submitted:'Submitted',under_review:'Under review',reviewed:'Reviewed internally',notification_recorded:'DFES notification logged',completed:'Completed',cancelled:'Cancelled'};
  const STATUS_COLORS = {submitted:'neutral',under_review:'warn',reviewed:'warn',notification_recorded:'ok',completed:'ok',cancelled:'bad'};
  const defaultBuildings = [
    {id:'bld-mining',name:'Mining & CE & Truck Rebuild'},
    {id:'bld-module',name:'Module & Workshop'},
    {id:'bld-parts-despatch',name:'Parts Despatch'},
    {id:'bld-parts-receival',name:'Parts Receival'},
    {id:'bld-reman',name:'REMAN'},
    {id:'bld-office',name:'Office & Reception'},
    {id:'gate-1',name:'Gate 1'}, {id:'gate-2',name:'Gate 2'},
  ];
  let buildings = defaultBuildings;
  let me = null;
  let state = {work:[],staff:[],extinguishers:[]};
  let currentTab = 'overview';
  let feed = null;
  let toastTimer = null;
  const today = () => new Intl.DateTimeFormat('sv-SE',{timeZone:'Australia/Perth',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  function plusDays(iso,delta) { return new Date(Date.parse(`${iso}T00:00:00Z`)+delta*86400000).toISOString().slice(0,10); }
  function esc(text) { return String(text??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function date(value) {
    const iso=String(value||'').slice(0,10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return 'Not recorded';
    return new Intl.DateTimeFormat('en-AU',{timeZone:'Australia/Perth',day:'numeric',month:'short',year:'numeric'}).format(new Date(`${iso}T12:00:00+08:00`));
  }
  function clock(value) { return String(value||'').slice(0,5); }
  function buildingName(id) { return buildings.find(b=>b.id===id)?.name || id || 'Unspecified'; }
  // Contact-based SiteNav profiles may automatically receive editor role.
  // Safety registers and official receipt logging require site admin/owner.
  function manager() { return ['admin','owner'].includes(me?.role); }
  function badge(label,color='neutral') { return `<span class="badge ${color}">${esc(label)}</span>`; }
  function toast(message,isError=false) {
    const element=$('toast');
    element.textContent=message; element.hidden=false;
    element.classList.toggle('toast-error',isError);
    clearTimeout(toastTimer); toastTimer=setTimeout(()=>{element.hidden=true;},6000);
  }
  function showProblem(form,message) { form.querySelector('.form-error').textContent=message; }
  function loadingError(error) {
    if (error?.status===401) return 'Session expired. Sign in again.';
    if (error?.status===403) return 'Your staff account is not authorised for this SiteNav site.';
    if (error?.status===503) return 'Fire Operations is not yet available on the server. Check the database migration and connection.';
    const reason={FIRE_WATCH_REQUIRED:'Assign a trained fire-watch officer before marking an outdoor job reviewed.',
      FIRE_WATCH_TRAINING_UNVERIFIED:'The nominated fire-detection officer needs documented extinguisher training before this outdoor job can be internally reviewed.',
      BUSHFIRE_TRAINING_UNVERIFIED:'Within 30 m of vegetation the fire-detection officer also needs recorded firefighting-vehicle operation and bushfire suppression training.',
      VEGETATION_ASSESSMENT_REQUIRED:'Assess whether vegetation is within 30 m. Edit the work details to complete this field.',
      DBCA_ASSESSMENT_REQUIRED:'Assess whether the location is within 3 km of DBCA-managed land. Edit the work details.',
      WORK_DETAILS_LOCKED:'This job is already notification-recorded, completed or cancelled. Cancel/recreate rather than silently changing its date or scope.',
      DUPLICATE_RECORD:'This employee number or extinguisher asset code is already registered.',
      INVALID_STATUS_TRANSITION:'The work status changed; reload the register before updating.',
      REUSED_DFES_NOT_REFERENCE:'This DFES NOT number was already recorded against a different work date. New TFB days require a new notification.',
    }[error?.code];
    return reason || error?.message || 'Request failed. Please retry.';
  }
  async function request(url,options={}) {
    const response=await fetch(url,{credentials:'same-origin',cache:'no-store',...options});
    const data=await response.json().catch(()=>({}));
    if (!response.ok) {
      const err=new Error(data.message||data.error||`HTTP ${response.status}`);
      err.status=response.status;err.code=data.error;throw err;
    }
    return data;
  }
  async function write(path,data,method='POST') {
    return request(API+path,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  }
  function selectOptions(selector,items) {
    document.querySelectorAll(selector).forEach(select=>{
      const selected=select.value;
      select.replaceChildren();
      for (const item of items) {
        const option=document.createElement('option');
        option.value=typeof item==='string'?item:item.id;
        option.textContent=typeof item==='string'?item:item.name;
        select.append(option);
      }
      if (Array.from(select.options).some(o=>o.value===selected)) select.value=selected;
    });
  }
  function extendFilterSelect(id,items) {
    const select=$(id), value=select.value;
    select.replaceChildren(select.firstElementChild);
    for (const item of items) {
      const option=document.createElement('option');
      option.value=typeof item==='string'?item:item.id;
      option.textContent=typeof item==='string'?item:item.name;
      select.append(option);
    }
    select.value=value;
  }
  function populateOptions() {
    selectOptions('[data-departments]',DEPARTMENTS);
    selectOptions('[data-trades]',TRADES);
    selectOptions('[data-buildings]',buildings);
    extendFilterSelect('work-department',DEPARTMENTS);
    extendFilterSelect('staff-trade',TRADES);
    extendFilterSelect('staff-department',DEPARTMENTS);
    extendFilterSelect('asset-building',buildings);
    const watch=$('work-fire-watch'),selected=watch.value;
    watch.replaceChildren(new Option('Not assigned yet',''));
    state.staff.filter(s=>s.active).forEach(s=>watch.add(new Option(`${s.fullName} · ${s.trade}`,s.id)));
    watch.value=selected;
  }
  async function loadBuildings() {
    try {
      const response=await fetch('/data/buildings.geojson');
      if (!response.ok) return;
      const geo=await response.json();
      const items=(geo.features||[]).map(f=>({id:f.properties?.id,name:f.properties?.name})).filter(b=>/^[a-z0-9-]+$/.test(b.id||'')&&b.name);
      if (items.length) buildings=items;
      populateOptions();
    } catch { /* Use the known site building IDs; no phantom map positions. */ }
  }
  function setTab(tab) {
    currentTab=tab;
    document.querySelectorAll('[data-tab]').forEach(button=>button.setAttribute('aria-selected',String(button.dataset.tab===tab)));
    document.querySelectorAll('[data-panel]').forEach(panel=>panel.hidden=panel.dataset.panel!==tab);
  }
  function renderFeed() {
    if (!feed) return;
    const {bans,danger,warnings,armadaleMatches} = feed;
    if (bans?.state!=='ok') {
      $('ban-title').textContent='Unable to verify ban status';
      $('ban-description').textContent='Official feed unavailable. Check DFES and Emergency WA directly.';
    } else if (armadaleMatches?.length) {
      $('ban-title').textContent=`${armadaleMatches.length} relevant ban notice${armadaleMatches.length>1?'s':''}`;
      $('ban-description').textContent=armadaleMatches[0].title+' — check effective dates on Emergency WA.';
    } else {
      $('ban-title').textContent='No Armadale entry identified';
      $('ban-description').textContent='Not an all-clear: verify declared bans and effective dates directly.';
    }
    $('ban-checked').textContent=bans?.checkedAt ? `Checked ${new Intl.DateTimeFormat('en-AU',{timeZone:'Australia/Perth',hour:'2-digit',minute:'2-digit'}).format(new Date(bans.checkedAt))} AWST`:'Not checked';
    for (const [key,data,titleId,listId] of [['danger',danger,'danger-title','danger-items'],['warnings',warnings,'warning-title','warning-items']]) {
      if (data?.state!=='ok') {
        $(titleId).textContent='Feed unavailable';
        $(listId).textContent='Open Emergency WA for the authoritative information.';
      } else {
        $(titleId).textContent=`${data.items.length} notice${data.items.length===1?'':'s'} in feed`;
        $(listId).textContent=data.items.length?data.items.slice(0,3).map(i=>i.title).join(' · '):`No items in the current ${key==='danger'?'rating':'regional incident'} feed. This does not confirm conditions are safe.`;
      }
    }
  }
  function days7(work) { const start=today(),end=plusDays(start,6); return work.filter(w=>String(w.workDate).slice(0,10)>=start&&String(w.workDate).slice(0,10)<=end&&w.status!=='cancelled'); }
  function durationMinutes(item) {const [sh,sm]=clock(item.startTime).split(':').map(Number),[eh,em]=clock(item.endTime).split(':').map(Number);return (eh*60+em)-(sh*60+sm);}
  function trainingState(trained,expiry) {
    if (!trained) return ['Not recorded','bad'];
    if (!expiry) return ['No expiry recorded','neutral'];
    const left=Math.round((Date.parse(String(expiry).slice(0,10)+'T00:00:00Z')-Date.parse(today()+'T00:00:00Z'))/86400000);
    return left<0?['Expired','bad']:left<=30?['Due within 30 days','warn']:['Current','ok'];
  }
  function renderOverview() {
    const active=days7(state.work), dept=new Map();
    active.forEach(w=>dept.set(w.department,(dept.get(w.department)||0)+1));
    $('stat-work').textContent=active.length;
    $('stat-departments').textContent=`Across ${dept.size} department${dept.size===1?'':'s'}`;
    $('stat-notified').textContent=active.filter(w=>w.status==='notification_recorded'||w.notNumber).length;
    $('stat-trained').textContent=state.staff.filter(s=>s.active&&s.extinguisherTrainedOn).length;
    const due=state.staff.filter(s=>s.active&&trainingState(s.extinguisherTrainedOn,s.extinguisherExpiresOn)[1]!=='ok'&&s.extinguisherExpiresOn).length;
    $('stat-expiring').textContent=due?`${due} with expired / due training`:'Employees with training dates';
    $('stat-assets').textContent=state.extinguishers.length;
    $('stat-map-pins').textContent=`${state.extinguishers.filter(a=>a.sceneX!=null&&a.sceneZ!=null).length} positioned on SiteNav`;
    const entries=[...dept.entries()].sort((a,b)=>b[1]-a[1]);
    const max=Math.max(1,...entries.map(e=>e[1]));
    $('department-bars').classList.toggle('empty-message',!entries.length);
    $('department-bars').innerHTML=entries.length?entries.map(([name,count])=>`<div><div class="bar-row-head"><strong>${esc(name)}</strong><span>${count} job${count===1?'':'s'}</span></div><div class="bar-track"><span style="width:${Math.round(count/max*100)}%"></span></div></div>`).join(''):'No jobs entered for the next seven days.';
    const upcoming=[...active].sort((a,b)=>`${a.workDate} ${a.startTime}`.localeCompare(`${b.workDate} ${b.startTime}`)).slice(0,6);
    $('upcoming').classList.toggle('empty-message',!upcoming.length);
    $('upcoming').innerHTML=upcoming.length?upcoming.map(w=>`<div class="upcoming-row"><div class="day-token">${esc(String(w.workDate).slice(5,10))}</div><div><strong>${esc(w.department)} · ${esc(w.description)}</strong><small>${esc(clock(w.startTime))}–${esc(clock(w.endTime))} · ${esc(buildingName(w.buildingRef))}</small></div>${badge(STATUSES[w.status]||w.status,STATUS_COLORS[w.status])}</div>`).join(''):'No work submitted for the next seven days.';
  }
  function filteredWork() {
    const from=$('work-from').value,to=$('work-to').value,dept=$('work-department').value;
    return state.work.filter(w=>(!from||String(w.workDate).slice(0,10)>=from)&&(!to||String(w.workDate).slice(0,10)<=to)&&(!dept||w.department===dept));
  }
  function workActions(w) {
    if (!manager()) return '<span class="td-small">Site safety admin only</span>';
    const buttons=[];
    const action=(status,label)=>`<button class="table-action" data-action="status" data-id="${esc(w.id)}" data-status="${status}">${esc(label)}</button>`;
    if (['submitted','under_review','reviewed'].includes(w.status)) buttons.push(`<button class="table-action muted-action" data-action="edit-work" data-id="${esc(w.id)}">Edit details</button>`);
    if (w.status==='submitted') buttons.push(action('under_review','Start review'));
    if (w.status==='under_review') buttons.push(action('reviewed','Review complete'));
    if (w.status==='reviewed') {buttons.push(`<button class="table-action" data-action="not" data-id="${esc(w.id)}">Record DFES NOT</button>`); buttons.push(action('completed','Complete'));buttons.push(action('under_review','Reopen review'));}
    if (w.status==='notification_recorded') {buttons.push(action('completed','Complete'));buttons.push(action('under_review','Reopen review'));}
    if (['submitted','under_review','reviewed','notification_recorded'].includes(w.status)) buttons.push(action('cancelled','Cancel'));
    return `<div class="td-actions">${buttons.join('')}</div>`;
  }
  function renderWork() {
    const work=filteredWork().sort((a,b)=>`${a.workDate} ${a.startTime}`.localeCompare(`${b.workDate} ${b.startTime}`));
    const group=new Map();let minutes=0;
    work.filter(w=>w.status!=='cancelled').forEach(w=>{group.set(w.department,(group.get(w.department)||0)+1);minutes+=durationMinutes(w);});
    $('work-summary').innerHTML=`<span class="summary-chip">Jobs <strong>${work.length}</strong></span><span class="summary-chip">Planned work duration <strong>${(minutes/60).toFixed(1)} h</strong></span>`+[...group.entries()].map(([name,count])=>`<span class="summary-chip">${esc(name)} <strong>${count}</strong></span>`).join('');
    $('work-rows').innerHTML=work.length?work.map(w=>{
      const watch=state.staff.find(s=>s.id===w.fireWatchEmployeeId);
      const watchLabel=watch?watch.fullName:'Not assigned';
      const exposure=w.enclosure==='fully_enclosed'?'Fully enclosed':w.enclosure==='open_workshop'?'Open workshop':'Outdoors';
      return `<tr><td><strong>${esc(date(w.workDate))}</strong><span class="td-small">${esc(clock(w.startTime))}–${esc(clock(w.endTime))} AWST</span></td>
        <td><strong>${esc(w.department)}</strong><span class="td-small">${esc(w.trade)}</span></td>
        <td><strong>${esc(buildingName(w.buildingRef))}</strong><span class="td-small">${esc(w.locationDetail)}</span></td>
        <td class="td-note"><strong>${esc(w.description)}</strong><span class="td-small">${esc(w.equipment)} · ${esc(exposure)}</span><span class="td-small">Fire watch: ${esc(watchLabel)}</span>${w.controls?`<span class="td-small">Controls: ${esc(w.controls)}</span>`:''}</td>
        <td>${badge(STATUSES[w.status]||w.status,STATUS_COLORS[w.status])}${w.notNumber?`<span class="td-small">DFES NOT: ${esc(w.notNumber)}</span>`:''}${w.enclosure!=='fully_enclosed'&&!w.notNumber?'<span class="td-small">Notification must be checked if TFB applies</span>':''}</td>
        <td>${workActions(w)}</td></tr>`;
    }).join(''):`<tr><td colspan="6" class="table-empty">No hot-work submissions match the selected dates and department.</td></tr>`;
  }
  function renderStaff() {
    const trade=$('staff-trade').value,department=$('staff-department').value,q=$('staff-search').value.trim().toLowerCase();
    const rows=state.staff.filter(s=>(!trade||s.trade===trade)&&(!department||s.department===department)&&(!q||`${s.fullName} ${s.employeeNumber||''}`.toLowerCase().includes(q)));
    $('staff-rows').innerHTML=rows.length?rows.map(s=>{
      const extinguish=trainingState(s.extinguisherTrainedOn,s.extinguisherExpiresOn),watch=trainingState(s.fireWatchTrainedOn,s.fireWatchExpiresOn),bush=trainingState(s.bushfireTrainedOn,s.bushfireExpiresOn);
      const vehicle=trainingState(s.fireVehicleTrainedOn,s.fireVehicleExpiresOn);
      return `<tr><td><strong>${esc(s.fullName)}</strong>${!s.active?` ${badge('Inactive','bad')}`:''}<span class="td-small">${esc(s.employeeNumber||'No employee number')}</span></td>
        <td><strong>${esc(s.trade)}</strong><span class="td-small">${esc(s.department)}</span></td>
        <td>${badge(extinguish[0],extinguish[1])}<span class="td-small">Trained ${date(s.extinguisherTrainedOn)}<br>Expiry / review ${date(s.extinguisherExpiresOn)}</span></td>
        <td><span class="td-small">Fire-watch induction ${badge(watch[0],watch[1])}</span><span class="td-small">Vehicle operation ${badge(vehicle[0],vehicle[1])}</span><span class="td-small">Bushfire suppression ${badge(bush[0],bush[1])}</span></td>
        <td class="td-note">${esc(s.evidenceReference||'Not recorded')}</td>
        ${manager()?`<td><button class="table-action muted-action" data-action="edit-staff" data-id="${esc(s.id)}">Edit</button></td>`:''}</tr>`;
    }).join(''):`<tr><td colspan="6" class="table-empty">No staff records match. Add verified training records before assigning fire-watch officers.</td></tr>`;
  }
  function renderAssets() {
    const building=$('asset-building').value,condition=$('asset-condition').value;
    const rows=state.extinguishers.filter(a=>(!building||a.buildingRef===building)&&(!condition||a.condition===condition));
    $('asset-rows').innerHTML=rows.length?rows.map(a=>{
      const inspect=trainingState(a.inspectedOn,a.inspectionDueOn);
      const pin=a.sceneX!=null&&a.sceneZ!=null;
      const conditionText={in_service:'In service',out_of_service:'Out of service',missing:'Missing'}[a.condition]||a.condition;
      return `<tr><td><strong>${esc(a.assetCode)}</strong></td><td><strong>${esc(a.type)}</strong><span class="td-small">${esc(a.capacity)} ${esc(a.unit)}</span></td>
        <td><strong>${esc(buildingName(a.buildingRef))}</strong><span class="td-small">${esc(a.locationDetail)}</span></td>
        <td>${badge(inspect[0],inspect[1])}<span class="td-small">Inspected ${date(a.inspectedOn)}<br>Due ${date(a.inspectionDueOn)}</span></td>
        <td>${badge(conditionText,a.condition==='in_service'?'ok':'bad')}</td>
        <td>${pin?`<a class="table-action muted-action" href="/index.html?fire=1&fireasset=${encodeURIComponent(a.id)}">Locate on 3D map ↗</a>`:badge('Map pin needed','warn')}</td>
        ${manager()?`<td><button class="table-action muted-action" data-action="edit-asset" data-id="${esc(a.id)}">Edit</button></td>`:''}</tr>`;
    }).join(''):`<tr><td colspan="7" class="table-empty">No extinguisher assets recorded. Complete a physical inventory and enter verified locations.</td></tr>`;
  }
  function render() {populateOptions();renderOverview();renderWork();renderStaff();renderAssets();}
  function openDialog(id,record=null) {
    const dialog=$(id),form=dialog.querySelector('form');
    form.reset();showProblem(form,'');
    if (id==='work-dialog') {
      form.querySelector('h2').textContent=record?'Revise hot-work plan':'Plan hot work';
      form.elements.workDate.value=today();
      form.elements.startTime.value='08:00';
      form.elements.endTime.value='09:00';
    }
    if (record) for (const [key,value] of Object.entries(record)) {
      const input=form.elements.namedItem(key);
      if (!input) continue;
      if (input.type==='date') input.value=value?String(value).slice(0,10):'';
      else input.value=value==null?'':String(value);
    }
    dialog.showModal();
  }
  async function saveForm(form,kind) {
    const button=form.querySelector('[type=submit]');button.disabled=true;showProblem(form,'');
    try {
      const values=Object.fromEntries(new FormData(form).entries());
      const path={work:values.id?`/work/${values.id}/details`:'/work',staff:'/staff',asset:'/extinguishers',not:`/work/${values.id}`}[kind];
      if (kind==='work') for (const field of ['vegetationWithin30m','dbcaWithin3km']) values[field]=values[field]===''?null:values[field]==='true';
      if (kind==='staff') values.active=values.active==='true';
      if (kind==='not') values.status='notification_recorded';
      await write(path,values,(kind==='not'||(kind==='work'&&values.id))?'PATCH':'POST');
      form.closest('dialog').close();
      toast(kind==='work'?(values.id?'Hot-work plan revised; internal review reset.':'Hot-work plan submitted. No work authorisation implied.'):kind==='not'?'DFES notification receipt recorded.':'Register saved.');
      await loadData();
    } catch(error) {showProblem(form,loadingError(error));}
    finally {button.disabled=false;}
  }
  async function statusAction(id,status) {
    const reason={under_review:'Return this job to internal review?',reviewed:'Record internal review complete? This does not authorise work.',completed:'Mark the work as completed? Confirm all required notifications and workplace procedures first.',cancelled:'Cancel this job?'}[status];
    if (!window.confirm(reason||'Update this job?')) return;
    try { await write(`/work/${id}`,{status},'PATCH');toast(`Work status updated: ${STATUSES[status]||status}`);await loadData(); }
    catch(error) {toast(loadingError(error),true);}
  }
  function csvReport() {
    const cols=['Work Date','Start AWST','End AWST','Department','Trade','Building','Exact location','Description','Equipment','Enclosure','Vegetation <=30m','DBCA <=3km','Controls','Fire-watch officer','Status','DFES NOT number'];
    const records=filteredWork().map(w=>[String(w.workDate).slice(0,10),clock(w.startTime),clock(w.endTime),w.department,w.trade,buildingName(w.buildingRef),w.locationDetail,w.description,w.equipment,w.enclosure,w.vegetationWithin30m,w.dbcaWithin3km,w.controls,state.staff.find(s=>s.id===w.fireWatchEmployeeId)?.fullName||'',STATUSES[w.status]||w.status,w.notNumber||'']);
    // Formula-injection protection: all cells are text, with dangerous leading
    // spreadsheet operators neutralised before CSV quoting.
    const quote=value=>{let v=value==null?'':String(value);if (/^[\s]*[=+@\-\t\r]/.test(v))v="'"+v;return '"'+v.replace(/"/g,'""')+'"';};
    const blob=new Blob(['\ufeff',[cols,...records].map(row=>row.map(quote).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'});
    const url=URL.createObjectURL(blob);const anchor=document.createElement('a');anchor.href=url;anchor.download=`forrestdale-hot-work-${today()}.csv`;
    document.body.append(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  async function loadData() {
    state=await request(API);
    render();
  }
  async function loadFeed() {
    try {feed=await request(API+'/feed');renderFeed();}
    catch(error) {
      feed={bans:{state:'unavailable'},danger:{state:'unavailable'},warnings:{state:'unavailable'}};
      renderFeed();
    }
  }
  async function enter() {
    let info;
    try {info=await request('/api/auth/me');} catch { return false; }
    if (!info?.email || !info.role) return false;
    me=info;
    $('sn-auth-gate').hidden=true;
    $('fire-app').hidden=false;
    $('user-email').textContent=info.email;
    document.querySelectorAll('.editor-only').forEach(el=>el.hidden=!manager());
    SiteNavStaffNav?.mount?.({currentPage:'fire',siteSlug:SITE});
    await loadBuildings();
    loadData().catch(e=>toast(loadingError(e),true));
    loadFeed();
    return true;
  }
  const authGate=SnAuthGate.attach({next:location.pathname+location.search,onSignedIn:()=>{
    enter().then(ok=>{if(!ok)authGate.showError('Your account has no access to this site.');});
  }});
  document.querySelectorAll('[data-tab]').forEach(button=>button.addEventListener('click',()=>setTab(button.dataset.tab)));
  document.querySelectorAll('[data-goto]').forEach(button=>button.addEventListener('click',()=>setTab(button.dataset.goto)));
  for (const id of ['new-work','work-add']) $(id).addEventListener('click',()=>openDialog('work-dialog'));
  $('staff-add').addEventListener('click',()=>openDialog('staff-dialog'));
  $('asset-add').addEventListener('click',()=>openDialog('asset-dialog'));
  for (const [id,kind] of [['work-form','work'],['staff-form','staff'],['asset-form','asset'],['not-form','not']]) {
    $(id).addEventListener('submit',e=>{e.preventDefault();saveForm(e.currentTarget,kind);});
  }
  document.querySelectorAll('.close-dialog').forEach(button=>button.addEventListener('click',()=>button.closest('dialog').close()));
  document.querySelectorAll('dialog').forEach(dialog=>dialog.addEventListener('click',e=>{if(e.target===dialog)dialog.close();}));
  for (const id of ['work-from','work-to','work-department']) $(id).addEventListener('change',renderWork);
  for (const id of ['staff-trade','staff-department','staff-search']) $(id).addEventListener('input',renderStaff);
  for (const id of ['asset-building','asset-condition']) $(id).addEventListener('change',renderAssets);
  $('work-reset').addEventListener('click',()=>{$('work-from').value='';$('work-to').value='';$('work-department').value='';renderWork();});
  $('download-work').addEventListener('click',csvReport);
  $('print-work').addEventListener('click',()=>window.print());
  document.querySelectorAll('.table-scroller').forEach(container=>container.addEventListener('click',e=>{
    const button=e.target.closest('[data-action]');if(!button)return;
    const {action,id,status}=button.dataset;
    if (action==='status') return statusAction(id,status);
    if (action==='not') {openDialog('not-dialog',{id});return;}
    if (action==='edit-work') {const record=state.work.find(w=>w.id===id);if(record)openDialog('work-dialog',record);}
    if (action==='edit-staff') {const record=state.staff.find(s=>s.id===id);if(record)openDialog('staff-dialog',record);}
    if (action==='edit-asset') {const record=state.extinguishers.find(a=>a.id===id);if(record)openDialog('asset-dialog',record);}
  }));
  $('logout').addEventListener('click',async()=>{
    await fetch('/api/auth/logout',{method:'POST',credentials:'same-origin'}).catch(()=>{});
    me=null;state={work:[],staff:[],extinguishers:[]};
    $('fire-app').hidden=true;$('sn-auth-gate').hidden=false;
    SiteNavStaffNav?.unmount?.();authGate.showLoginState('Signed out. Sign in with your work account to continue.');
  });
  enter().then(ok=>{if(!ok)authGate.showLoginState('Sign in with your approved @hcma.com.au account to continue.');});
})();
