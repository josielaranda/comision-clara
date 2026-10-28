(() => {
  'use strict';
  const STORAGE_KEY = 'comision-clara-data-v1';
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const today = () => { const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
  const uid = () => globalThis.crypto?.randomUUID?.() || 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const r=Math.random()*16|0;return(c==='x'?r:(r&3|8)).toString(16)});
  const blankData = () => ({ version: 1, currency: 'MXN', sellers: [], products: [], records: [] });
  let data = loadData();
  const localSnapshot = clone(data);
  let supabaseClient = null;
  let activeUser = null;
  let remoteReady = false;
  let lastSynced = null;
  let syncBusy = false;
  let syncQueued = false;
  let refreshQueued = false;
  let realtimeChannel = null;
  let refreshTimer = null;
  let toastTimer;

  function clone(value) { return JSON.parse(JSON.stringify(value)); }

  function loadData() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (!saved) return blankData();
      const parsed = JSON.parse(saved);
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.sellers) || !Array.isArray(parsed.products) || !Array.isArray(parsed.records)) return blankData();
      parsed.currency = 'MXN';
      parsed.sellers = parsed.sellers.filter(x=>x&&typeof x.id==='string'&&typeof x.name==='string').map(x=>({...x,archived:Boolean(x.archived)}));
      parsed.products = parsed.products.filter(x=>x&&typeof x.id==='string'&&typeof x.name==='string'&&Number.isFinite(Number(x.commission))&&Number(x.commission)>0).map(x=>({...x,commission:Number(x.commission),archived:Boolean(x.archived)}));
      parsed.records = parsed.records.filter(r => r && typeof r.id === 'string' && typeof r.sellerName === 'string' && typeof r.productName === 'string' && Number.isFinite(Number(r.total)) && Number(r.total)>=0 && Array.isArray(r.payments)).map(r => ({...r, quantity: Number(r.quantity) || 1, unitCommission: Number(r.unitCommission) || 0, total: Number(r.total), payments:r.payments.filter(p=>p&&Number.isFinite(Number(p.amount))&&Number(p.amount)>0).map(p=>({...p,amount:Number(p.amount)}))}));
      return parsed;
    } catch { return blankData(); }
  }
  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); return true; }
    catch { showToast('No se pudieron guardar los cambios. Descarga un respaldo y libera espacio.'); return false; }
  }
  function dbError(error) { return error?.message || 'Error de conexión con la base de datos.'; }
  function showAuth(message='') { $('#authScreen').classList.remove('hidden');$('#appShell').classList.add('hidden');$('#mobileNav').classList.add('hidden');$('#logoutButton').classList.add('hidden');if(message)$('#loginError').textContent=message; }
  function showApp() { $('#authScreen').classList.add('hidden');$('#appShell').classList.remove('hidden');$('#mobileNav').classList.remove('hidden');$('#logoutButton').classList.remove('hidden'); }
  function localHasRecords(source) { return source.sellers.length+source.products.length+source.records.length>0; }
  function toDbRows(source) {
    return {
      sellers:source.sellers.map(x=>({id:x.id,name:x.name,archived:Boolean(x.archived)})),
      products:source.products.map(x=>({id:x.id,name:x.name,commission:Number(x.commission),archived:Boolean(x.archived)})),
      commissions:source.records.map(x=>({id:x.id,seller_id:x.sellerId||null,product_id:x.productId||null,seller_name:x.sellerName,product_name:x.productName,quantity:Number(x.quantity),unit_commission:Number(x.unitCommission),total:Number(x.total),commission_date:x.date,note:x.note||''})),
      payments:source.records.flatMap(x=>x.payments.map(p=>({id:p.id,commission_id:x.id,amount:Number(p.amount),payment_date:p.date,note:p.note||''})))
    };
  }
  function fromDbRows(sellers,products,commissions,payments) {
    const paymentMap=new Map();for(const p of payments){if(!paymentMap.has(p.commission_id))paymentMap.set(p.commission_id,[]);paymentMap.get(p.commission_id).push({id:p.id,amount:Number(p.amount),date:p.payment_date,note:p.note||''});}
    return {version:1,currency:'MXN',sellers:sellers.map(x=>({id:x.id,name:x.name,archived:Boolean(x.archived)})),products:products.map(x=>({id:x.id,name:x.name,commission:Number(x.commission),archived:Boolean(x.archived)})),records:commissions.map(x=>({id:x.id,sellerId:x.seller_id,productId:x.product_id,sellerName:x.seller_name,productName:x.product_name,quantity:Number(x.quantity),unitCommission:Number(x.unit_commission),total:Number(x.total),date:x.commission_date,note:x.note||'',payments:(paymentMap.get(x.id)||[]).sort((a,b)=>a.date.localeCompare(b.date))}))};
  }
  async function syncCollection(table,oldRows,newRows) {
    const oldMap=new Map(oldRows.map(x=>[x.id,x])),newMap=new Map(newRows.map(x=>[x.id,x]));
    const changed=newRows.filter(x=>JSON.stringify(oldMap.get(x.id))!==JSON.stringify(x));
    if(changed.length){const {error}=await supabaseClient.from(table).upsert(changed,{onConflict:'id'});if(error)throw error;}
    const removed=oldRows.filter(x=>!newMap.has(x.id)).map(x=>x.id);
    if(removed.length){const {error}=await supabaseClient.from(table).delete().in('id',removed);if(error)throw error;}
  }
  async function persistDiff(before,after) {
    const oldRows=toDbRows(before),newRows=toDbRows(after);
    await syncCollection('sellers',oldRows.sellers,newRows.sellers);
    await syncCollection('products',oldRows.products,newRows.products);
    await syncCollection('commissions',oldRows.commissions,newRows.commissions);
    await syncCollection('payments',oldRows.payments,newRows.payments);
  }
  async function flushRemote() {
    if(!remoteReady||!supabaseClient||syncBusy)return;
    syncBusy=true;
    while(syncQueued){syncQueued=false;const snapshot=clone(data);try{await persistDiff(lastSynced||blankData(),snapshot);lastSynced=snapshot;}catch(error){showToast(`No se pudo sincronizar: ${dbError(error)}`);syncBusy=false;return;}}
    syncBusy=false;
    if(refreshQueued){refreshQueued=false;await loadRemoteData(false);}
  }
  function saveShared() {
    if(!save())return false;
    if(remoteReady){syncQueued=true;void flushRemote();}
    return true;
  }
  async function loadRemoteData(offerImport=true) {
    if(!activeUser||!supabaseClient)return;
    if(syncBusy){refreshQueued=true;return;}
    const [memberResult,sellerResult,productResult,commissionResult,paymentResult]=await Promise.all([
      supabaseClient.from('commission_members').select('user_id').eq('user_id',activeUser.id).maybeSingle(),
      supabaseClient.from('sellers').select('*').order('name'),
      supabaseClient.from('products').select('*').order('name'),
      supabaseClient.from('commissions').select('*').order('commission_date',{ascending:false}),
      supabaseClient.from('payments').select('*').order('payment_date',{ascending:true})
    ]);
    const failure=[memberResult,sellerResult,productResult,commissionResult,paymentResult].find(x=>x.error);
    if(failure)throw failure.error;
    if(!memberResult.data){remoteReady=false;activeUser=null;showAuth('Esta cuenta aún no tiene acceso. Pide al administrador que la autorice en Supabase.');await supabaseClient.auth.signOut();return;}
    const remote=fromDbRows(sellerResult.data||[],productResult.data||[],commissionResult.data||[],paymentResult.data||[]);
    if(offerImport&&!localHasRecords(remote)&&localHasRecords(localSnapshot)&&confirm('La base compartida está vacía y este dispositivo tiene datos guardados localmente. ¿Importar esos datos a la base compartida?')){
      data=clone(localSnapshot);lastSynced=blankData();remoteReady=true;showApp();render();syncQueued=true;await flushRemote();return;
    }
    data=remote;lastSynced=clone(remote);remoteReady=true;localStorage.setItem(STORAGE_KEY,JSON.stringify(data));showApp();render();
  }
  function queueRemoteRefresh() { clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>{if(syncBusy){refreshQueued=true;return}loadRemoteData(false).catch(error=>showToast(`No se pudo actualizar: ${dbError(error)}`));},350); }
  async function activateSession(session) {
    if(!session){activeUser=null;remoteReady=false;lastSynced=null;if(realtimeChannel){supabaseClient.removeChannel(realtimeChannel);realtimeChannel=null;}showAuth();return;}
    if(activeUser?.id===session.user.id&&remoteReady)return;
    activeUser=session.user;$('#loginError').textContent='';
    try{await loadRemoteData(true);if(!activeUser)return;if(realtimeChannel)supabaseClient.removeChannel(realtimeChannel);realtimeChannel=supabaseClient.channel('commission-data').on('postgres_changes',{event:'*',schema:'public',table:'sellers'},queueRemoteRefresh).on('postgres_changes',{event:'*',schema:'public',table:'products'},queueRemoteRefresh).on('postgres_changes',{event:'*',schema:'public',table:'commissions'},queueRemoteRefresh).on('postgres_changes',{event:'*',schema:'public',table:'payments'},queueRemoteRefresh).subscribe();}
    catch(error){activeUser=null;remoteReady=false;showAuth(`No se pudo abrir la base: ${dbError(error)}. Verifica que ejecutaste supabase/setup.sql.`);}
  }
  function esc(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function money(value) { return `$${new Intl.NumberFormat('es-MX',{minimumFractionDigits:2,maximumFractionDigits:2,useGrouping:true}).format(Number(value)||0)} MXN`; }
  function formatDate(value) { if(!/^\d{4}-\d{2}-\d{2}$/.test(String(value||'')))return '—';const [year,month,day]=value.split('-');return `${day}/${month}/${year}`; }
  function validDate(value) { if(!/^\d{4}-\d{2}-\d{2}$/.test(String(value||'')))return false;const [y,m,d]=value.split('-').map(Number);const parsed=new Date(Date.UTC(y,m-1,d));return parsed.getUTCFullYear()===y&&parsed.getUTCMonth()===m-1&&parsed.getUTCDate()===d; }
  const balance = r => Math.max(0, Number(r.total) - r.payments.reduce((s,p)=>s+Number(p.amount||0),0));
  function showToast(message) { const el=$('#toast'); el.textContent=message;el.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('show'),2800); }
  function empty(message, hint='') { return `<div class="empty-state"><strong>${esc(message)}</strong>${esc(hint)}</div>`; }
  function setView(name) {
    $$('.view').forEach(v=>v.classList.toggle('active',v.id===`view-${name}`));
    $$('.nav-item,[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===name));
    render(); window.scrollTo({top:0,behavior:'smooth'});
  }
  function recordRows(records, withActions=true) {
    if(!records.length) return empty('No hay comisiones para mostrar.','Agrega vendedores y productos, y luego registra una comisión.');
    return `<div class="table-wrap"><table><thead><tr><th>Vendedor / producto</th><th>Fecha</th><th>Total</th><th>Pagado</th><th>Saldo</th><th>Estado</th>${withActions?'<th></th>':''}</tr></thead><tbody>${records.map(r=>{const paid=r.payments.reduce((s,p)=>s+Number(p.amount),0),left=balance(r),paidAll=left<.005;return `<tr><td><span class="cell-main">${esc(r.sellerName)}</span><span class="cell-sub">${esc(r.productName)} · ${Number(r.quantity)} unidad${Number(r.quantity)===1?'':'es'}${r.note?` · ${esc(r.note)}`:''}</span></td><td>${formatDate(r.date)}</td><td class="money">${money(r.total)}</td><td>${money(paid)}</td><td class="money">${money(left)}</td><td><span class="status ${paidAll?'status-paid':'status-pending'}">${paidAll?'Pagada':'Pendiente'}</span></td>${withActions?`<td><div class="row-actions"><button class="small-action" data-action="history" data-id="${esc(r.id)}">Historial (${r.payments.length})</button>${left>=.005?`<button class="small-action" data-action="pay" data-id="${esc(r.id)}">＋ Pago</button>`:''}<button class="small-action" data-action="edit-record" data-id="${esc(r.id)}" aria-label="Editar">Editar</button><button class="small-action danger" data-action="delete-record" data-id="${esc(r.id)}" aria-label="Eliminar">Eliminar</button></div></td>`:''}</tr>`}).join('')}</tbody></table></div>`;
  }
  function renderDashboard() {
    const owed=data.records.reduce((s,r)=>s+Number(r.total),0),paid=data.records.reduce((s,r)=>s+r.payments.reduce((a,p)=>a+Number(p.amount),0),0);
    $('#totalOwed').textContent=money(owed);$('#totalPaid').textContent=money(paid);$('#totalPending').textContent=money(Math.max(0,owed-paid));$('#openRecords').textContent=data.records.filter(r=>balance(r)>=.005).length;
    $('#dashboardRecords').innerHTML=recordRows(data.records.filter(r=>balance(r)>=.005).sort((a,b)=>b.date.localeCompare(a.date)).slice(0,5),false);
    const sums=new Map(); for(const r of data.records){const s=sums.get(r.sellerName)||{owed:0,paid:0};s.owed+=Number(r.total);s.paid+=r.payments.reduce((a,p)=>a+Number(p.amount),0);sums.set(r.sellerName,s)}
    const rows=[...sums].sort((a,b)=>(b[1].owed-b[1].paid)-(a[1].owed-a[1].paid));
    $('#sellerSummary').innerHTML=rows.length?`<div class="table-wrap"><table><thead><tr><th>Vendedor</th><th>Generado</th><th>Pagado</th><th>Falta por pagar</th></tr></thead><tbody>${rows.map(([name,s])=>`<tr><td class="cell-main">${esc(name)}</td><td>${money(s.owed)}</td><td>${money(s.paid)}</td><td class="money">${money(Math.max(0,s.owed-s.paid))}</td></tr>`).join('')}</tbody></table></div>`:empty('Aún no hay vendedores con comisiones.');
  }
  function renderRecords() {
    const q=($('#recordSearch')?.value||'').trim().toLocaleLowerCase('es');const status=$('#statusFilter')?.value||'all';
    const list=data.records.filter(r=>(!q||`${r.sellerName} ${r.productName} ${r.note||''}`.toLocaleLowerCase('es').includes(q))&&(status==='all'||(status==='paid'?balance(r)<.005:balance(r)>=.005))).sort((a,b)=>b.date.localeCompare(a.date));
    $('#recordsTable').innerHTML=recordRows(list,true);
  }
  function renderCatalogs() {
    const sellerList=data.sellers.filter(x=>!x.archived), productList=data.products.filter(x=>!x.archived);
    $('#sellerList').innerHTML=data.sellers.length?`<div class="catalog-list">${data.sellers.map(s=>`<div class="catalog-item ${s.archived?'archived':''}"><div><span class="catalog-item-name">${esc(s.name)}</span><span class="catalog-item-meta">${s.archived?'Archivado':'Vendedor activo'}</span></div><div class="item-actions"><button class="small-action" data-action="toggle-seller" data-id="${esc(s.id)}">${s.archived?'Reactivar':'Archivar'}</button><button class="small-action" data-action="rename-seller" data-id="${esc(s.id)}">Editar</button></div></div>`).join('')}</div>`:empty('Todavía no hay vendedores.','Agrega a la primera persona que recibe comisión.');
    $('#productList').innerHTML=data.products.length?`<div class="catalog-list">${data.products.map(p=>`<div class="catalog-item ${p.archived?'archived':''}"><div><span class="catalog-item-name">${esc(p.name)}</span><span class="catalog-item-meta">${p.archived?'Archivado':`${money(p.commission)} por unidad`}</span></div><div class="item-actions"><button class="small-action" data-action="toggle-product" data-id="${esc(p.id)}">${p.archived?'Reactivar':'Archivar'}</button><button class="small-action" data-action="rename-product" data-id="${esc(p.id)}">Editar</button></div></div>`).join('')}</div>`:empty('Todavía no hay productos.','Agrega productos y define su comisión por unidad.');
    $('#recordSeller').innerHTML=`<option value="">Selecciona un vendedor</option>${sellerList.map(s=>`<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}`;
    $('#recordProduct').innerHTML=`<option value="">Selecciona un producto</option>${productList.map(p=>`<option value="${esc(p.id)}">${esc(p.name)} — ${money(p.commission)} / unidad</option>`).join('')}`;
  }
  function render() { renderDashboard();renderRecords();renderCatalogs(); }
  function openRecord(id='') {
    renderCatalogs(); const r=data.records.find(x=>x.id===id);$('#recordForm').reset();$('#recordId').value=r?.id||'';$('#recordDialogTitle').textContent=r?'Editar comisión':'Nueva comisión';if(r){if(![...$('#recordSeller').options].some(o=>o.value===r.sellerId))$('#recordSeller').add(new Option(`${r.sellerName} (archivado)`,r.sellerId));if(![...$('#recordProduct').options].some(o=>o.value===r.productId))$('#recordProduct').add(new Option(`${r.productName} (archivado)`,r.productId));}$('#recordSeller').value=r?.sellerId||'';$('#recordProduct').value=r?.productId||'';$('#recordQuantity').value=r?.quantity||1;$('#recordDate').value=r?.date||today();$('#recordNote').value=r?.note||'';$('#recordFormError').textContent='';updateCalculation();$('#recordDialog').showModal();
  }
  function updateCalculation() {const p=data.products.find(x=>x.id===$('#recordProduct').value),record=data.records.find(r=>r.id===$('#recordId').value);const qty=Number($('#recordQuantity').value);const unit=p?(record&&record.productId===p.id?Number(record.unitCommission):Number(p.commission)):0;$('#calculatedTotal').textContent=money(unit*(Number.isFinite(qty)&&qty>0?qty:0));$('#unitCommission').textContent=`Comisión por unidad: ${money(unit)}`;}
  function openPayment(recordId,paymentId='') {const r=data.records.find(x=>x.id===recordId);if(!r)return;const payment=r.payments.find(p=>p.id===paymentId);if(paymentId&&!payment)return;const otherPaid=r.payments.filter(p=>p.id!==paymentId).reduce((sum,p)=>sum+Number(p.amount),0),available=Math.max(0,Number(r.total)-otherPaid);$('#paymentForm').reset();$('#paymentRecordId').value=recordId;$('#paymentId').value=payment?.id||'';$('#paymentDialogTitle').textContent=payment?'Editar pago':'Registrar pago';$('#paymentSubmitButton').textContent=payment?'Guardar cambios':'Guardar pago';$('#paymentAmount').max=available.toFixed(2);$('#paymentAmount').value=payment?Number(payment.amount).toFixed(2):available.toFixed(2);$('#paymentDate').value=payment?.date||today();$('#paymentDate').max=today();$('#paymentNote').value=payment?.note||'';$('#paymentFormError').textContent='';$('#paymentContext').innerHTML=`<strong>${esc(r.sellerName)} · ${esc(r.productName)}</strong><br>Saldo disponible para este pago: <strong>${money(available)}</strong>`;$('#paymentDialog').showModal();}
  function openHistory(recordId) {const r=data.records.find(x=>x.id===recordId);if(!r)return;const paid=r.payments.reduce((sum,p)=>sum+Number(p.amount),0);$('#historySummary').innerHTML=`<strong>${esc(r.sellerName)} · ${esc(r.productName)}</strong><br>Registrado: ${formatDate(r.date)} · Total: <strong>${money(r.total)}</strong><br>Pagado: <strong>${money(paid)}</strong> · Saldo: <strong>${money(balance(r))}</strong>`;const payments=[...r.payments].sort((a,b)=>a.date.localeCompare(b.date));$('#paymentHistory').innerHTML=payments.length?`<div class="table-wrap history-table"><table><thead><tr><th>Fecha</th><th>Monto</th><th>Nota</th><th>Acciones</th><th>Recibo</th></tr></thead><tbody>${payments.map(p=>`<tr><td>${formatDate(p.date)}</td><td class="money">${money(p.amount)}</td><td>${esc(p.note||'—')}</td><td><div class="row-actions"><button class="small-action" data-action="edit-payment" data-record-id="${esc(r.id)}" data-payment-id="${esc(p.id)}">Editar</button><button class="small-action danger" data-action="delete-payment" data-record-id="${esc(r.id)}" data-payment-id="${esc(p.id)}">Eliminar</button></div></td><td><button class="small-action" data-action="receipt" data-record-id="${esc(r.id)}" data-payment-id="${esc(p.id)}">Descargar PDF</button></td></tr>`).join('')}</tbody></table></div>`:empty('Todavía no hay pagos registrados.','Agrega el primer abono para esta comisión.');$('#historyAddPayment').dataset.id=recordId;$('#historyAddPayment').classList.toggle('hidden',balance(r)<.005);$('#historyDialog').showModal();}
  function downloadReceipt(recordId,paymentId) {
    const record=data.records.find(r=>r.id===recordId),payment=record?.payments.find(p=>p.id===paymentId),PDF=window.jspdf?.jsPDF;
    if(!record||!payment){showToast('No se encontró ese pago.');return;}
    if(!PDF){showToast('No se pudo cargar el generador de PDF. Revisa la conexión e inténtalo otra vez.');return;}
    const doc=new PDF({unit:'mm',format:'a5'});
    doc.setFont('helvetica','bold');doc.setFontSize(20);doc.text('RECIBO DE PAGO',20,24);
    doc.setFont('helvetica','normal');doc.setFontSize(10);doc.text(`Folio: ${payment.id.slice(0,8).toUpperCase()}`,20,34);
    doc.setDrawColor(210,220,215);doc.line(20,40,128,40);
    doc.setFont('helvetica','bold');doc.text('Nombre',20,51);doc.setFont('helvetica','normal');doc.text(doc.splitTextToSize(record.sellerName,76),52,51);
    doc.setFont('helvetica','bold');doc.text('Fecha',20,68);doc.setFont('helvetica','normal');doc.text(formatDate(payment.date),52,68);
    doc.setFont('helvetica','bold');doc.text('Monto',20,85);doc.setFont('helvetica','normal');doc.text(money(payment.amount),52,85);
    doc.setFont('helvetica','bold');doc.text('Concepto',20,102);doc.setFont('helvetica','normal');const concept=doc.splitTextToSize(`Comisión de ${record.productName} (${record.quantity} unidad${Number(record.quantity)===1?'':'es'})`,76);doc.text(concept,52,102);
    if(payment.note){const noteY=102+Math.max(1,concept.length)*6+8;doc.setFont('helvetica','bold');doc.text('Nota',20,noteY);doc.setFont('helvetica','normal');doc.text(doc.splitTextToSize(payment.note,76),52,noteY);}
    doc.setDrawColor(210,220,215);doc.line(20,175,128,175);doc.setFontSize(8);doc.text('Comisión Clara · Recibo generado digitalmente',20,183);
    doc.save(`recibo-${payment.id.slice(0,8)}.pdf`);
  }
  function openItem(type,id='') {const arr=type==='seller'?data.sellers:data.products;const item=arr.find(x=>x.id===id);$('#itemForm').reset();$('#itemType').value=type;$('#itemId').value=item?.id||'';$('#itemDialogEyebrow').textContent=type==='seller'?'VENDEDORES':'PRODUCTOS';$('#itemDialogTitle').textContent=item?'Editar':type==='seller'?'Agregar vendedor':'Agregar producto';$('#itemName').value=item?.name||'';$('#commissionField').classList.toggle('hidden',type==='seller');$('#itemCommission').required=type==='product';$('#itemCommission').value=item?.commission??'';$('#itemFormError').textContent='';$('#itemDialog').showModal();}
  function csvCell(v){return `"${String(v??'').replace(/"/g,'""')}"`}
  function download(name,content,type) {const blob=new Blob([content],{type});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  function exportJson() {download(`comision-clara-respaldo-${today()}.json`,JSON.stringify({...data,exportedAt:new Date().toISOString()},null,2),'application/json');showToast('Respaldo descargado. Guárdalo en un lugar seguro.');}
  function exportCsv() {const header=['Vendedor','Producto','Cantidad','Comisión por unidad','Comisión total (MXN)','Total pagado (MXN)','Saldo pendiente (MXN)','Estado','Fecha','Nota','Pagos'];const rows=data.records.map(r=>[r.sellerName,r.productName,r.quantity,r.unitCommission,r.total,r.payments.reduce((a,p)=>a+Number(p.amount),0),balance(r),balance(r)<.005?'Pagada':'Pendiente',formatDate(r.date),r.note,r.payments.map(p=>`${formatDate(p.date)}: ${Number(p.amount).toFixed(2)} MXN${p.note?` (${p.note})`:''}`).join(' | ')]);download(`comisiones-${today()}.csv`,'\uFEFF'+[header,...rows].map(row=>row.map(csvCell).join(',')).join('\r\n'),'text/csv;charset=utf-8');showToast('Archivo CSV descargado.');}
  function handleAction(button) {
    const action=button.dataset.action,id=button.dataset.id;
    if(action==='new-record'){if(!data.sellers.some(x=>!x.archived)||!data.products.some(x=>!x.archived)){setView('catalogos');showToast('Primero agrega al menos un vendedor y un producto.');return}openRecord()}
    if(action==='edit-record')openRecord(id);if(action==='history')openHistory(id);if(action==='pay'){const returnHistory=$('#historyDialog').open?id:'';if($('#historyDialog').open)$('#historyDialog').close();$('#paymentForm').dataset.returnHistory=returnHistory;openPayment(id)}
    if(action==='edit-payment'){const recordId=button.dataset.recordId;$('#historyDialog').close();$('#paymentForm').dataset.returnHistory=recordId;openPayment(recordId,button.dataset.paymentId)}
    if(action==='delete-payment'){const recordId=button.dataset.recordId,r=data.records.find(x=>x.id===recordId);if(r&&confirm('¿Eliminar este pago del historial? El saldo pendiente se recalculará.')){r.payments=r.payments.filter(p=>p.id!==button.dataset.paymentId);if(saveShared()){render();openHistory(recordId);showToast('Pago eliminado y saldo actualizado.')}}}
    if(action==='receipt')downloadReceipt(button.dataset.recordId,button.dataset.paymentId);
    if(action==='delete-record'){const r=data.records.find(x=>x.id===id);if(r&&confirm(`¿Eliminar la comisión de ${r.sellerName} para ${r.productName}, incluyendo su historial de pagos?`)){data.records=data.records.filter(x=>x.id!==id);saveShared();render();showToast('Comisión eliminada.')}}
    if(action==='new-seller')openItem('seller');if(action==='new-product')openItem('product');
    if(action==='rename-seller')openItem('seller',id);if(action==='rename-product')openItem('product',id);
    if(action==='toggle-seller'||action==='toggle-product'){const arr=action==='toggle-seller'?data.sellers:data.products;const x=arr.find(y=>y.id===id);if(x){x.archived=!x.archived;saveShared();render();showToast(x.archived?'Elemento archivado.':'Elemento reactivado.')}}
    if(action==='export-json')exportJson();if(action==='export-csv')exportCsv();
    if(action==='clear-data'&&confirm('¿Borrar todos los vendedores, productos, comisiones y pagos compartidos de la base de datos? Esta acción no se puede deshacer.')){data=blankData();saveShared();render();showToast('Se borraron los datos compartidos.');}
  }
  document.addEventListener('click',event=>{const view=event.target.closest('[data-view],[data-view-link]');if(view){setView(view.dataset.view||view.dataset.viewLink);return}const action=event.target.closest('[data-action]');if(action){handleAction(action);return}const close=event.target.closest('[data-close]');if(close)$('#'+close.dataset.close).close();});
  $('#recordProduct').addEventListener('change',updateCalculation);$('#recordQuantity').addEventListener('input',updateCalculation);$('#recordSearch').addEventListener('input',renderRecords);$('#statusFilter').addEventListener('change',renderRecords);
  $('#recordForm').addEventListener('submit',event=>{event.preventDefault();const error=$('#recordFormError'),id=$('#recordId').value,seller=data.sellers.find(x=>x.id===$('#recordSeller').value),product=data.products.find(x=>x.id===$('#recordProduct').value),quantity=Number($('#recordQuantity').value),date=$('#recordDate').value;error.textContent='';const existing=data.records.find(r=>r.id===id);if(!seller||!product||(!existing&&(seller.archived||product.archived))){error.textContent='Selecciona un vendedor y un producto activos.';return}if(!Number.isSafeInteger(quantity)||quantity<1){error.textContent='La cantidad debe ser un número entero mayor que cero.';return}if(!validDate(date)){error.textContent='Selecciona una fecha de comisión válida.';return}const unit=existing&&existing.productId===product.id?Number(existing.unitCommission):Number(product.commission),total=Number((unit*quantity).toFixed(2)),paid=existing?existing.payments.reduce((s,p)=>s+Number(p.amount),0):0;if(total+0.000001<paid){error.textContent=`El total no puede ser menor a lo ya pagado (${money(paid)}).`;return}const record={id:id||uid(),sellerId:seller.id,productId:product.id,sellerName:existing&&existing.sellerId===seller.id?existing.sellerName:seller.name,productName:existing&&existing.productId===product.id?existing.productName:product.name,quantity,unitCommission:unit,total,date,note:$('#recordNote').value.trim(),payments:existing?.payments||[]};if(existing)data.records=data.records.map(r=>r.id===id?record:r);else data.records.push(record);if(saveShared()){ $('#recordDialog').close();render();showToast(existing?'Comisión actualizada.':'Comisión guardada.');}});
  $('#paymentForm').addEventListener('submit',event=>{event.preventDefault();const recordId=$('#paymentRecordId').value,paymentId=$('#paymentId').value,r=data.records.find(x=>x.id===recordId),raw=$('#paymentAmount').value,rawAmount=Number(raw),amount=Math.round(rawAmount*100)/100,date=$('#paymentDate').value,error=$('#paymentFormError');error.textContent='';if(!r){error.textContent='No se encontró la comisión.';return}if(!Number.isFinite(rawAmount)||amount<=0){error.textContent='El monto debe ser al menos 0.01.';return}if(Math.abs(rawAmount-amount)>1e-8){error.textContent='Usa máximo dos decimales para el monto.';return}const previous=r.payments.find(p=>p.id===paymentId),otherPaid=r.payments.filter(p=>p.id!==paymentId).reduce((sum,p)=>sum+Number(p.amount),0),available=Math.max(0,Number(r.total)-otherPaid);if(paymentId&&!previous){error.textContent='No se encontró el pago que quieres editar.';return}if(amount>available+0.000001){error.textContent=`El pago supera el saldo disponible de ${money(available)}.`;return}if(!validDate(date)){error.textContent='Selecciona una fecha de pago válida.';return}if(date>today()){error.textContent='La fecha de pago no puede ser futura.';return}const updated={id:paymentId||uid(),amount,date,note:$('#paymentNote').value.trim()};if(previous)r.payments=r.payments.map(p=>p.id===paymentId?updated:p);else r.payments.push(updated);const returnHistory=$('#paymentForm').dataset.returnHistory;$('#paymentForm').dataset.returnHistory='';if(saveShared()){$('#paymentDialog').close();render();if(returnHistory)openHistory(returnHistory);showToast(paymentId?'Pago actualizado y saldo recalculado.':'Pago registrado.');}});
  $('#itemForm').addEventListener('submit',event=>{event.preventDefault();const type=$('#itemType').value,id=$('#itemId').value,name=$('#itemName').value.trim(),commission=Number($('#itemCommission').value),arr=type==='seller'?data.sellers:data.products,error=$('#itemFormError');error.textContent='';if(!name){error.textContent='Escribe un nombre.';return}if(arr.some(x=>x.id!==id&&!x.archived&&x.name.toLocaleLowerCase('es')===name.toLocaleLowerCase('es'))){error.textContent='Ya existe un elemento activo con ese nombre.';return}if(type==='product'&&(!Number.isFinite(commission)||commission<=0)){error.textContent='La comisión por unidad debe ser mayor que cero.';return}const item=arr.find(x=>x.id===id);if(item){const oldName=item.name;item.name=name;if(type==='product')item.commission=Number(commission.toFixed(2));else data.records.filter(r=>r.sellerId===id).forEach(r=>{if(r.sellerName===oldName)r.sellerName=name})}else arr.push({id:uid(),name,...(type==='product'?{commission:Number(commission.toFixed(2))}:{})});if(saveShared()){$('#itemDialog').close();render();showToast(type==='seller'?'Vendedor guardado.':'Producto guardado.');}});
  $('#importFile').addEventListener('change',async event=>{const file=event.target.files?.[0];event.target.value='';if(!file)return;try{const parsed=JSON.parse(await file.text());const valid=parsed&&parsed.version===1&&Array.isArray(parsed.sellers)&&Array.isArray(parsed.products)&&Array.isArray(parsed.records)&&parsed.records.every(r=>r&&typeof r.id==='string'&&typeof r.sellerName==='string'&&typeof r.productName==='string'&&Number.isFinite(Number(r.total))&&Array.isArray(r.payments)&&r.payments.every(p=>Number.isFinite(Number(p.amount))&&Number(p.amount)>0));if(!valid)throw new Error('formato');if(!confirm('Esto reemplazará todos los datos guardados en este dispositivo. ¿Continuar?'))return;const next={version:1,currency:'MXN',sellers:parsed.sellers,products:parsed.products,records:parsed.records.map(r=>({...r,payments:r.payments.map(p=>({...p,amount:Number(p.amount)}))}))};const old=data;data=next;if(!saveShared()){data=old;return}render();showToast('Respaldo restaurado correctamente.');}catch{showToast('El archivo no es un respaldo válido de Comisión Clara.');}});
  document.addEventListener('click',e=>{if(e.target.matches('dialog')){const rect=e.target.getBoundingClientRect();if(e.clientX<rect.left||e.clientX>rect.right||e.clientY<rect.top||e.clientY>rect.bottom)e.target.close();}});
  $('#loginForm').addEventListener('submit',async event=>{event.preventDefault();if(!supabaseClient){$('#loginError').textContent='No se pudo cargar la conexión a Supabase.';return}const button=$('#loginButton');button.disabled=true;button.textContent='Conectando…';$('#loginError').textContent='';const {data:result,error}=await supabaseClient.auth.signInWithPassword({email:$('#loginEmail').value.trim(),password:$('#loginPassword').value});button.disabled=false;button.textContent='Entrar';if(error){$('#loginError').textContent='No se pudo iniciar sesión. Revisa el correo, la contraseña y que la cuenta esté autorizada.';return}await activateSession(result.session);});
  $('#logoutButton').addEventListener('click',async()=>{if(syncBusy){showToast('Espera a que termine la sincronización para cerrar sesión.');return}await supabaseClient?.auth.signOut();});
  async function startApp(){
    if(!window.SUPABASE_CONFIG?.url||!window.SUPABASE_CONFIG?.publishableKey||!window.supabase?.createClient){showAuth('Falta cargar la configuración o la biblioteca de Supabase. Revisa la conexión a internet.');return;}
    supabaseClient=window.supabase.createClient(window.SUPABASE_CONFIG.url,window.SUPABASE_CONFIG.publishableKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
    supabaseClient.auth.onAuthStateChange((_event,session)=>{setTimeout(()=>{void activateSession(session);},0);});
    try{const {data:sessionData,error}=await supabaseClient.auth.getSession();if(error)throw error;await activateSession(sessionData.session);}catch(error){showAuth(`No se pudo iniciar la aplicación: ${dbError(error)}`);}
  }
  void startApp();
  if('serviceWorker'in navigator&&location.protocol!=='file:')window.addEventListener('load',()=>navigator.serviceWorker.register('./service-worker.js').catch(()=>{}));
  let installPrompt=null;window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installPrompt=e;$('#installButton').classList.remove('hidden')});$('#installButton').addEventListener('click',async()=>{if(!installPrompt)return;installPrompt.prompt();await installPrompt.userChoice;installPrompt=null;$('#installButton').classList.add('hidden')});
})();
