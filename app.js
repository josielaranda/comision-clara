(() => {
  'use strict';
  const STORAGE_KEY = 'comision-clara-data-v1';
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const today = () => { const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
  const uid = () => globalThis.crypto?.randomUUID?.() || `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const blankData = () => ({ version: 1, currency: 'GTQ', sellers: [], products: [], records: [] });
  let data = loadData();
  let toastTimer;

  function loadData() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (!saved) return blankData();
      const parsed = JSON.parse(saved);
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.sellers) || !Array.isArray(parsed.products) || !Array.isArray(parsed.records)) return blankData();
      parsed.currency = typeof parsed.currency === 'string' ? parsed.currency : 'GTQ';
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
  function esc(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function money(value) {
    try { return new Intl.NumberFormat('es-GT', {style:'currency', currency:data.currency||'GTQ', minimumFractionDigits:2, maximumFractionDigits:2}).format(Number(value)||0); }
    catch { return `Q ${(Number(value)||0).toFixed(2)}`; }
  }
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
    return `<div class="table-wrap"><table><thead><tr><th>Vendedor / producto</th><th>Fecha</th><th>Total</th><th>Pagado</th><th>Saldo</th><th>Estado</th>${withActions?'<th></th>':''}</tr></thead><tbody>${records.map(r=>{const paid=r.payments.reduce((s,p)=>s+Number(p.amount),0),left=balance(r),paidAll=left<.005;return `<tr><td><span class="cell-main">${esc(r.sellerName)}</span><span class="cell-sub">${esc(r.productName)} · ${Number(r.quantity)} unidad${Number(r.quantity)===1?'':'es'}${r.note?` · ${esc(r.note)}`:''}</span></td><td>${esc(r.date||'')}</td><td class="money">${money(r.total)}</td><td>${money(paid)}</td><td class="money">${money(left)}</td><td><span class="status ${paidAll?'status-paid':'status-pending'}">${paidAll?'Pagada':'Pendiente'}</span></td>${withActions?`<td><div class="row-actions">${left>=.005?`<button class="small-action" data-action="pay" data-id="${esc(r.id)}">＋ Pago</button>`:''}<button class="small-action" data-action="edit-record" data-id="${esc(r.id)}" aria-label="Editar">Editar</button><button class="small-action danger" data-action="delete-record" data-id="${esc(r.id)}" aria-label="Eliminar">Eliminar</button></div></td>`:''}</tr>`}).join('')}</tbody></table></div>`;
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
  function render() { renderDashboard();renderRecords();renderCatalogs();$('#currencySelect').value=data.currency||'GTQ'; }
  function openRecord(id='') {
    renderCatalogs(); const r=data.records.find(x=>x.id===id);$('#recordForm').reset();$('#recordId').value=r?.id||'';$('#recordDialogTitle').textContent=r?'Editar comisión':'Nueva comisión';if(r){if(![...$('#recordSeller').options].some(o=>o.value===r.sellerId))$('#recordSeller').add(new Option(`${r.sellerName} (archivado)`,r.sellerId));if(![...$('#recordProduct').options].some(o=>o.value===r.productId))$('#recordProduct').add(new Option(`${r.productName} (archivado)`,r.productId));}$('#recordSeller').value=r?.sellerId||'';$('#recordProduct').value=r?.productId||'';$('#recordQuantity').value=r?.quantity||1;$('#recordDate').value=r?.date||today();$('#recordNote').value=r?.note||'';$('#recordFormError').textContent='';updateCalculation();$('#recordDialog').showModal();
  }
  function updateCalculation() {const p=data.products.find(x=>x.id===$('#recordProduct').value);const qty=Number($('#recordQuantity').value);const unit=p?Number(p.commission):0;$('#calculatedTotal').textContent=money(unit*(Number.isFinite(qty)&&qty>0?qty:0));$('#unitCommission').textContent=`Comisión por unidad: ${money(unit)}`;}
  function openPayment(id) {const r=data.records.find(x=>x.id===id);if(!r)return;$('#paymentForm').reset();$('#paymentRecordId').value=id;$('#paymentAmount').max=balance(r).toFixed(2);$('#paymentAmount').value=balance(r).toFixed(2);$('#paymentDate').value=today();$('#paymentFormError').textContent='';$('#paymentContext').innerHTML=`<strong>${esc(r.sellerName)} · ${esc(r.productName)}</strong><br>Saldo pendiente: <strong>${money(balance(r))}</strong>`;$('#paymentDialog').showModal();}
  function openItem(type,id='') {const arr=type==='seller'?data.sellers:data.products;const item=arr.find(x=>x.id===id);$('#itemForm').reset();$('#itemType').value=type;$('#itemId').value=item?.id||'';$('#itemDialogEyebrow').textContent=type==='seller'?'VENDEDORES':'PRODUCTOS';$('#itemDialogTitle').textContent=item?'Editar':type==='seller'?'Agregar vendedor':'Agregar producto';$('#itemName').value=item?.name||'';$('#commissionField').classList.toggle('hidden',type==='seller');$('#itemCommission').required=type==='product';$('#itemCommission').value=item?.commission??'';$('#itemFormError').textContent='';$('#itemDialog').showModal();}
  function csvCell(v){return `"${String(v??'').replace(/"/g,'""')}"`}
  function download(name,content,type) {const blob=new Blob([content],{type});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  function exportJson() {download(`comision-clara-respaldo-${today()}.json`,JSON.stringify({...data,exportedAt:new Date().toISOString()},null,2),'application/json');showToast('Respaldo descargado. Guárdalo en un lugar seguro.');}
  function exportCsv() {const header=['Vendedor','Producto','Cantidad','Comisión por unidad','Comisión total','Total pagado','Saldo pendiente','Estado','Fecha','Nota','Pagos'];const rows=data.records.map(r=>[r.sellerName,r.productName,r.quantity,r.unitCommission,r.total,r.payments.reduce((a,p)=>a+Number(p.amount),0),balance(r),balance(r)<.005?'Pagada':'Pendiente',r.date,r.note,r.payments.map(p=>`${p.date}: ${Number(p.amount).toFixed(2)}${p.note?` (${p.note})`:''}`).join(' | ')]);download(`comisiones-${today()}.csv`,'\uFEFF'+[header,...rows].map(row=>row.map(csvCell).join(',')).join('\r\n'),'text/csv;charset=utf-8');showToast('Archivo CSV descargado.');}
  function handleAction(button) {
    const action=button.dataset.action,id=button.dataset.id;
    if(action==='new-record'){if(!data.sellers.some(x=>!x.archived)||!data.products.some(x=>!x.archived)){setView('catalogos');showToast('Primero agrega al menos un vendedor y un producto.');return}openRecord()}
    if(action==='edit-record')openRecord(id);if(action==='pay')openPayment(id);
    if(action==='delete-record'){const r=data.records.find(x=>x.id===id);if(r&&confirm(`¿Eliminar la comisión de ${r.sellerName} para ${r.productName}, incluyendo su historial de pagos?`)){data.records=data.records.filter(x=>x.id!==id);save();render();showToast('Comisión eliminada.')}}
    if(action==='new-seller')openItem('seller');if(action==='new-product')openItem('product');
    if(action==='rename-seller')openItem('seller',id);if(action==='rename-product')openItem('product',id);
    if(action==='toggle-seller'||action==='toggle-product'){const arr=action==='toggle-seller'?data.sellers:data.products;const x=arr.find(y=>y.id===id);if(x){x.archived=!x.archived;save();render();showToast(x.archived?'Elemento archivado.':'Elemento reactivado.')}}
    if(action==='export-json')exportJson();if(action==='export-csv')exportCsv();
    if(action==='clear-data'&&confirm('¿Borrar todos los vendedores, productos, comisiones y pagos guardados en este dispositivo? Esta acción no se puede deshacer.')){localStorage.removeItem(STORAGE_KEY);data=blankData();save();render();showToast('Se borraron los datos de este dispositivo.');}
  }
  document.addEventListener('click',event=>{const view=event.target.closest('[data-view],[data-view-link]');if(view){setView(view.dataset.view||view.dataset.viewLink);return}const action=event.target.closest('[data-action]');if(action){handleAction(action);return}const close=event.target.closest('[data-close]');if(close)$('#'+close.dataset.close).close();});
  $('#recordProduct').addEventListener('change',updateCalculation);$('#recordQuantity').addEventListener('input',updateCalculation);$('#recordSearch').addEventListener('input',renderRecords);$('#statusFilter').addEventListener('change',renderRecords);$('#currencySelect').addEventListener('change',e=>{data.currency=e.target.value;save();render();showToast('Moneda actualizada.');});
  $('#recordForm').addEventListener('submit',event=>{event.preventDefault();const error=$('#recordFormError'),id=$('#recordId').value,seller=data.sellers.find(x=>x.id===$('#recordSeller').value),product=data.products.find(x=>x.id===$('#recordProduct').value),quantity=Number($('#recordQuantity').value),date=$('#recordDate').value;error.textContent='';if(!seller||!product||seller.archived||product.archived){error.textContent='Selecciona un vendedor y un producto activos.';return}if(!Number.isSafeInteger(quantity)||quantity<1){error.textContent='La cantidad debe ser un número entero mayor que cero.';return}if(!date){error.textContent='Selecciona la fecha de la comisión.';return}const existing=data.records.find(r=>r.id===id);const unit=Number(product.commission),total=Number((unit*quantity).toFixed(2)),paid=existing?existing.payments.reduce((s,p)=>s+Number(p.amount),0):0;if(total+0.001<paid){error.textContent=`El total no puede ser menor a lo ya pagado (${money(paid)}).`;return}const record={id:id||uid(),sellerId:seller.id,productId:product.id,sellerName:seller.name,productName:product.name,quantity,unitCommission:unit,total,date,note:$('#recordNote').value.trim(),payments:existing?.payments||[]};if(existing)data.records=data.records.map(r=>r.id===id?record:r);else data.records.push(record);if(save()){ $('#recordDialog').close();render();showToast(existing?'Comisión actualizada.':'Comisión guardada.');}});
  $('#paymentForm').addEventListener('submit',event=>{event.preventDefault();const id=$('#paymentRecordId').value,r=data.records.find(x=>x.id===id),rawAmount=Number($('#paymentAmount').value),amount=Math.round(rawAmount*100)/100,date=$('#paymentDate').value,error=$('#paymentFormError');error.textContent='';if(!r){error.textContent='No se encontró la comisión.';return}if(!Number.isFinite(rawAmount)||amount<=0){error.textContent='El monto debe ser al menos 0.01.';return}if(amount>balance(r)+0.001){error.textContent=`El pago supera el saldo pendiente de ${money(balance(r))}.`;return}if(!date){error.textContent='Selecciona la fecha del pago.';return}r.payments.push({id:uid(),amount,date,note:$('#paymentNote').value.trim()});if(save()){$('#paymentDialog').close();render();showToast('Pago registrado.');}});
  $('#itemForm').addEventListener('submit',event=>{event.preventDefault();const type=$('#itemType').value,id=$('#itemId').value,name=$('#itemName').value.trim(),commission=Number($('#itemCommission').value),arr=type==='seller'?data.sellers:data.products,error=$('#itemFormError');error.textContent='';if(!name){error.textContent='Escribe un nombre.';return}if(arr.some(x=>x.id!==id&&!x.archived&&x.name.toLocaleLowerCase('es')===name.toLocaleLowerCase('es'))){error.textContent='Ya existe un elemento activo con ese nombre.';return}if(type==='product'&&(!Number.isFinite(commission)||commission<=0)){error.textContent='La comisión por unidad debe ser mayor que cero.';return}const item=arr.find(x=>x.id===id);if(item){const oldName=item.name;item.name=name;if(type==='product')item.commission=Number(commission.toFixed(2));else data.records.filter(r=>r.sellerId===id).forEach(r=>{if(r.sellerName===oldName)r.sellerName=name})}else arr.push({id:uid(),name,...(type==='product'?{commission:Number(commission.toFixed(2))}:{})});if(save()){$('#itemDialog').close();render();showToast(type==='seller'?'Vendedor guardado.':'Producto guardado.');}});
  $('#importFile').addEventListener('change',async event=>{const file=event.target.files?.[0];event.target.value='';if(!file)return;try{const parsed=JSON.parse(await file.text());const valid=parsed&&parsed.version===1&&Array.isArray(parsed.sellers)&&Array.isArray(parsed.products)&&Array.isArray(parsed.records)&&parsed.records.every(r=>r&&typeof r.id==='string'&&typeof r.sellerName==='string'&&typeof r.productName==='string'&&Number.isFinite(Number(r.total))&&Array.isArray(r.payments)&&r.payments.every(p=>Number.isFinite(Number(p.amount))&&Number(p.amount)>0));if(!valid)throw new Error('formato');if(!confirm('Esto reemplazará todos los datos guardados en este dispositivo. ¿Continuar?'))return;const next={version:1,currency:typeof parsed.currency==='string'?parsed.currency:'GTQ',sellers:parsed.sellers,products:parsed.products,records:parsed.records.map(r=>({...r,payments:r.payments.map(p=>({...p,amount:Number(p.amount)}))}))};const old=data;data=next;if(!save()){data=old;return}render();showToast('Respaldo restaurado correctamente.');}catch{showToast('El archivo no es un respaldo válido de Comisión Clara.');}});
  document.addEventListener('click',e=>{if(e.target.matches('dialog')){const rect=e.target.getBoundingClientRect();if(e.clientX<rect.left||e.clientX>rect.right||e.clientY<rect.top||e.clientY>rect.bottom)e.target.close();}});
  render();
  if('serviceWorker'in navigator&&location.protocol!=='file:')window.addEventListener('load',()=>navigator.serviceWorker.register('./service-worker.js').catch(()=>{}));
  let installPrompt=null;window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installPrompt=e;$('#installButton').classList.remove('hidden')});$('#installButton').addEventListener('click',async()=>{if(!installPrompt)return;installPrompt.prompt();await installPrompt.userChoice;installPrompt=null;$('#installButton').classList.add('hidden')});
})();
