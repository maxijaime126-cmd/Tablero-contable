/* ============================================================
   TABLERO DE CONTROL CONTABLE — app.js
   ============================================================
   Estructura de datos principal (objeto `data`, se guarda entero
   en Supabase, tabla "tablero", columna jsonb "data"):

   data.empresas         -> array de nombres de empresa (indice = id de empresa)
   data.tareas_nombres   -> array de nombres de tareas rutinarias (catalogo global)
   data.tareasEmpresa    -> { [empresaIdx]: [indices de tareas que le aplican] }
                            si una empresa no tiene entrada aca, se asume que
                            le aplican TODAS las tareas del catalogo (default).
   data.anos[anio]       -> { tareas: {"mes_emp_tarea": estado}, tiempos: [...] }
                            estado en {Hecho, Pendiente, "Esperando Cliente", "No Corresponde"}
                            tiempos: [{mes, emp, tarea, mins, tipo, origen, fecha}]
                            tipo en {rutinaria, cierre, periodica} — el indice
                            "tarea" apunta a un catalogo distinto segun el tipo:
                              rutinaria -> data.tareas_nombres
                              cierre    -> ejercicio.tareascierre
                              periodica -> data.periodicas
   data.ejercicios       -> array de ejercicios contables:
                            { emp, numero, inicio, cierre, obs, cerrado,
                              tareascierre:[{nombre,desc}], estadoscierre:[estado] }
   data.periodicas       -> tareas no mensuales (Ganancias, Bienes Personales...):
                            { emp, nombre, periodicidad, vencimiento, obs, estado }
   data.plantillasCierre -> plantillas reutilizables de tareas de cierre:
                            { nombre, tareas:[{nombre}] }

   Guardado: saveNow() sube `data` entero a Supabase (upsert). loadData() lo
   trae al iniciar. suscribirCambiosRemotos() escucha cambios de otras PCs
   via Supabase Realtime y muestra el banner "otra PC guardo cambios".
   ============================================================ */

const MESES=["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
const ESTADOS_CICLO=["Hecho","Pendiente","No Corresponde"];
const HOY=new Date(); HOY.setHours(0,0,0,0);
const ANO_ACTUAL=HOY.getFullYear();
const MES_ACTUAL=HOY.getMonth();

let EMPRESAS=["STORAGE S.R.L","SINDICATO L","PROVIMED S.R.L","GOLOSINAS NATY","ILS S.R.L","MEDICINA FETAL S.R.L","COOPERATIVA MI BOLIVIA","COOPERATIVA AUREN","SUSTANSA S.R.L","Empresa 10","Empresa 11","Empresa 12","Empresa 13","Empresa 14","Empresa 15","Empresa 16","Empresa 17","Empresa 18","Empresa 19","Empresa 20","Empresa 21","Empresa 22","Empresa 23","Empresa 24","Empresa 25"];
let TAREAS=["Compras","Ventas","IVA","IIBB","Seg. e Hig.","Sueldos","Concil. Bco"];
let activePanel='dashboard';
let activeYear=ANO_ACTUAL;
let workEmpIdx=0, workEjIdx=null, workMes=MES_ACTUAL, workMesYear=ANO_ACTUAL;
let verCierreForzado=false;
let editingEjIdx=null, editingCierreEmpIdx=null, editingCierreIdx=null;
let hasUnsavedChanges=false;
let autoBackupTimer=null;
let saveDebounce=null;
let editTiempoRef=null;

let data={empresas:[],tareas_nombres:[],anos:{},ejercicios:[]};

// ═══ CONFIG SUPABASE ═══
const SUPABASE_URL = "https://ovmtacwcrxfxtxsggbxt.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_llgiKHW2EOOTiP4haWewFg_Vubpj01W";
const ROW_ID = "estudio"; // fila unica compartida por todo el estudio
const SESSION_ID = (crypto.randomUUID ? crypto.randomUUID() : ('sess_'+Math.random().toString(36).slice(2)+Date.now()));
let sb = null;
let lastKnownUpdatedAt = null;
let applyingRemote = false;
function sbReady(){
  if(sb)return true;
  if(!SUPABASE_URL||SUPABASE_URL.startsWith('PEGA_AQUI')){
    toast('Falta configurar Supabase (mira las lineas SUPABASE_URL/ANON_KEY en el codigo)',true);
    return false;
  }
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return true;
}

// ═══ GUARDADO ═══
function markUnsaved(){
  if(applyingRemote)return;
  hasUnsavedChanges=true;
  const btn=document.getElementById('save-btn');
  if(btn){btn.className='save-btn unsaved';document.getElementById('save-lbl').textContent='Guardar cambios';}
  clearTimeout(saveDebounce);
  saveDebounce=setTimeout(()=>saveNow(true),5000);
}
async function saveNow(silent=false){
  clearTimeout(saveDebounce);
  if(!sbReady())return;
  const btn=document.getElementById('save-btn');
  if(!silent&&btn){btn.className='save-btn saving';document.getElementById('save-lbl').textContent='Guardando...';}
  data.empresas=[...EMPRESAS];data.tareas_nombres=[...TAREAS];
  const nowIso=new Date().toISOString();
  const {error}=await sb.from('tablero').upsert({id:ROW_ID,data:data,updated_at:nowIso,last_editor:SESSION_ID});
  if(error){
    if(btn){btn.className='save-btn unsaved';document.getElementById('save-lbl').textContent='Error al guardar';}
    toast('No se pudo guardar en la nube: '+error.message,true);
    return;
  }
  lastKnownUpdatedAt=nowIso;
  hasUnsavedChanges=false;
  const ahora=new Date();
  const hora=`${String(ahora.getHours()).padStart(2,'0')}:${String(ahora.getMinutes()).padStart(2,'0')}`;
  if(btn){btn.className='save-btn saved';document.getElementById('save-lbl').textContent='Guardado';}
  document.getElementById('last-save-lbl').textContent=`Guardado: ${hora}`;
  if(!silent)showSaveIndicator(`Guardado a las ${hora}`);
}
function showSaveIndicator(msg){const el=document.getElementById('save-indicator');el.textContent='✓ '+msg;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),2000);}
function startAutoBackup(){clearInterval(autoBackupTimer);autoBackupTimer=setInterval(()=>{if(hasUnsavedChanges)saveNow(true);},2*60*1000);}

// ═══ CARGA DESDE SUPABASE ═══
async function loadData(){
  let loaded=null;
  if(sbReady()){
    const {data:rows,error}=await sb.from('tablero').select('data,updated_at').eq('id',ROW_ID).maybeSingle();
    if(error){
      toast('No se pudo conectar a Supabase: '+error.message,true);
    } else if(rows){
      loaded=rows.data;
      lastKnownUpdatedAt=rows.updated_at;
    }
  }
  if(loaded)data=loaded;
  if(data.empresas&&data.empresas.length)EMPRESAS=data.empresas;
  if(data.tareas_nombres&&data.tareas_nombres.length)TAREAS=data.tareas_nombres;
  if(!data.ejercicios)data.ejercicios=[];
  if(!data.anos)data.anos={};
  if(!data.anos[ANO_ACTUAL])data.anos[ANO_ACTUAL]={tareas:{},tiempos:[]};
  if(!data.tareasEmpresa)data.tareasEmpresa={};
  if(!data.periodicas)data.periodicas=[];
  if(!data.plantillasCierre)data.plantillasCierre=[];
  data.ejercicios.forEach(ej=>{
    if(!ej.tareascierre)ej.tareascierre=[];
    if(!ej.estadoscierre)ej.estadoscierre=[];
    if(ej.cerrado===undefined)ej.cerrado=false;
  });
  if(!loaded){
    await saveNow(true);
  }
}

function getYD(y){if(!data.anos[y])data.anos[y]={tareas:{},tiempos:[]};return data.anos[y];}
function getYears(){return Object.keys(data.anos).map(Number).sort();}

// ═══ SINCRONIZAR CON OTRAS PCs ═══
async function syncNow(){
  if(!sbReady())return;
  document.getElementById('remote-banner').style.display='none';
  applyingRemote=true;
  await loadData();
  init();renderAll();renderConfig();
  applyingRemote=false;
  toast('Datos actualizados');
}
function suscribirCambiosRemotos(){
  if(!sbReady())return;
  sb.channel('tablero-cambios')
    .on('postgres_changes',{event:'UPDATE',schema:'public',table:'tablero',filter:`id=eq.${ROW_ID}`},(payload)=>{
      const nuevo=payload.new && payload.new.updated_at;
      const editor=payload.new && payload.new.last_editor;
      if(editor && editor===SESSION_ID)return; // fue este mismo dispositivo, ignorar
      if(nuevo && nuevo!==lastKnownUpdatedAt){
        document.getElementById('remote-banner').style.display='flex';
      }
    })
    .subscribe();
}

// ═══ BACKUP MANUAL (archivo .json, ademas de la nube) ═══
function exportData(){
  data.empresas=[...EMPRESAS];data.tareas_nombres=[...TAREAS];
  const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;a.download=`tablero_backup_${new Date().toISOString().slice(0,10)}.json`;
  document.body.appendChild(a);a.click();a.remove();
  URL.revokeObjectURL(url);
  toast('Backup descargado');
}
function importData(){
  const inp=document.createElement('input');
  inp.type='file';inp.accept='application/json';
  inp.onchange=async ()=>{
    const file=inp.files[0];if(!file)return;
    try{
      const text=await file.text();
      const imp=JSON.parse(text);
      const src=imp.anos||imp.años;
      if(src){data=imp;if(!data.anos&&data.años){data.anos={};Object.entries(data.años).forEach(([y,v])=>data.anos[y]=v);}}
      else throw 0;
      if(!data.ejercicios)data.ejercicios=[];
      if(!data.tareasEmpresa)data.tareasEmpresa={};
      if(!data.periodicas)data.periodicas=[];
      if(!data.plantillasCierre)data.plantillasCierre=[];
      data.ejercicios.forEach(ej=>{if(!ej.tareascierre)ej.tareascierre=[];if(!ej.estadoscierre)ej.estadoscierre=[];if(ej.cerrado===undefined)ej.cerrado=false;});
      if(data.empresas&&data.empresas.length)EMPRESAS=data.empresas;
      if(data.tareas_nombres&&data.tareas_nombres.length)TAREAS=data.tareas_nombres;
      await saveNow();init();renderAll();renderConfig();toast('Datos importados y guardados en la nube');
    }catch{toast('Archivo invalido',true);}
  };
  inp.click();
}
window.addEventListener('beforeunload',e=>{if(hasUnsavedChanges){e.preventDefault();e.returnValue='';}});

// ═══ AÑOS ═══
function buildYearSel(){const s=document.getElementById('year-sel');s.innerHTML='';getYears().forEach(y=>{const o=document.createElement('option');o.value=y;o.textContent=y;if(y===activeYear)o.selected=true;s.appendChild(o);});}
function changeYear(y){activeYear=parseInt(y);renderAll();}
function addYearManual(){const inp=document.getElementById('new-year');const y=parseInt(inp.value);if(!y||y<2000||y>2100){toast('Ano invalido',true);return;}if(data.anos[y]){toast(`El ano ${y} ya existe`);return;}data.anos[y]={tareas:{},tiempos:[]};markUnsaved();activeYear=y;buildYearSel();renderAll();renderConfig();inp.value='';toast(`Ano ${y} agregado`);}
function deleteYear(y){if(getYears().length<=1){toast('No podes eliminar el unico ano',true);return;}if(!confirm(`Eliminar el ano ${y} y todos sus datos?`))return;delete data.anos[y];if(activeYear===parseInt(y))activeYear=Math.max(...getYears());markUnsaved();saveNow();buildYearSel();document.getElementById('year-sel').value=activeYear;renderAll();renderConfig();toast(`Ano ${y} eliminado`);}

// ═══ HELPERS ═══
function key(m,e,t){return`${m}_${e}_${t}`;}
function getE(m,e,t,yr){return(getYD(yr||activeYear).tareas[key(m,e,t)])||'';}
function setE(m,e,t,v,yr){getYD(yr||activeYear).tareas[key(m,e,t)]=v;markUnsaved();}
function getCierreE(ejIdx,ci){return data.ejercicios[ejIdx]?.estadoscierre?.[ci]||'';}
function setCierreE(ejIdx,ci,v){if(!data.ejercicios[ejIdx].estadoscierre)data.ejercicios[ejIdx].estadoscierre=[];data.ejercicios[ejIdx].estadoscierre[ci]=v;markUnsaved();}
function ejsDeEmpresa(empIdx){return data.ejercicios.map((e,i)=>({...e,_idx:i})).filter(e=>e.emp===empIdx);}
function ejActivoDeEmpresa(empIdx){const ejs=ejsDeEmpresa(empIdx);return ejs.find(e=>!e.cerrado)||ejs[ejs.length-1]||null;}
// tareas rutinarias que aplican a una empresa: si no tiene lista propia, aplican todas (compatibilidad)
function tareasDeEmpresa(empIdx){
  const lista=data.tareasEmpresa&&data.tareasEmpresa[empIdx];
  if(!lista)return TAREAS.map((_,i)=>i);
  return lista.filter(i=>i<TAREAS.length);
}
function pctEmpMesYr(m,e,yr){const idxs=tareasDeEmpresa(e);let d=0,nc=0;for(const t of idxs){const s=getE(m,e,t,yr);if(s==='Hecho')d++;else if(s==='No Corresponde')nc++;}const den=idxs.length-nc;return den<=0?1:d/den;}
function pctMes(m){let s=0;for(let e=0;e<EMPRESAS.length;e++)s+=pctEmpMesYr(m,e,activeYear);return s/EMPRESAS.length;}
function countMes(m,est){let c=0;for(let e=0;e<EMPRESAS.length;e++)for(const t of tareasDeEmpresa(e))if(getE(m,e,t)===est)c++;return c;}
function tiemposYr(yr){return getYD(yr||activeYear).tiempos||[];}
function totalMinsEmpMesYr(e,m,yr){return tiemposYr(yr).filter(r=>r.emp===e&&r.mes===m).reduce((a,r)=>a+r.mins,0);}
function totalMinsEmpYr(e,yr){return tiemposYr(yr).filter(r=>r.emp===e).reduce((a,r)=>a+r.mins,0);}
function totalMinsMesYr(m,yr){return tiemposYr(yr).filter(r=>r.mes===m).reduce((a,r)=>a+r.mins,0);}
function totalMinsTareaYr(t,yr){return tiemposYr(yr).filter(r=>r.tarea===t&&r.tipo==='rutinaria').reduce((a,r)=>a+r.mins,0);}
function totalMinsCierreYr(yr){return tiemposYr(yr).filter(r=>r.tipo==='cierre').reduce((a,r)=>a+r.mins,0);}
function totalMinsRutinariaYr(yr){return tiemposYr(yr).filter(r=>r.tipo==='rutinaria').reduce((a,r)=>a+r.mins,0);}
function totalMinsPeriodicaYr(yr){return tiemposYr(yr).filter(r=>r.tipo==='periodica').reduce((a,r)=>a+r.mins,0);}
function totalMinsAll(yr){return tiemposYr(yr).reduce((a,r)=>a+r.mins,0);}
function totalMinsEjercicio(ej){
  if(!ej)return 0;
  const meses=getMesesEj(ej)||[];
  return meses.reduce((acc,{mes,anio})=>acc+tiemposYr(anio).filter(r=>r.emp===ej.emp&&r.mes===mes).reduce((a,r)=>a+r.mins,0),0);
}
// Cuanto llevas hecho de lo que YA deberia estar hecho segun el calendario (meses ya transcurridos)
function avanceHastaHoy(ej){
  const meses=getMesesEj(ej)||[];
  if(!meses.length)return null;
  const idxTareas=tareasDeEmpresa(ej.emp);
  if(!idxTareas.length)return null;
  let transcurridos=0,hechas=0,esperadas=0;
  meses.forEach(({mes,anio})=>{
    const esPasado=anio<HOY.getFullYear()||(anio===HOY.getFullYear()&&mes<=HOY.getMonth());
    if(!esPasado)return;
    transcurridos++;
    idxTareas.forEach(ti=>{
      const est=getE(mes,ej.emp,ti,anio);
      if(est==='No Corresponde')return;
      esperadas++;
      if(est==='Hecho')hechas++;
    });
  });
  if(!transcurridos)return{transcurridos:0,totalMeses:meses.length,pct:null};
  return{transcurridos,totalMeses:meses.length,hechas,esperadas,pct:esperadas>0?Math.round(hechas/esperadas*100):100};
}
function fmtMin(m){if(!m||m===0)return'--';if(m<60)return m+'m';const h=Math.floor(m/60),mn=m%60;return mn?`${h}h ${mn}m`:`${h}h`;}
function parseDate(iso){if(!iso)return null;const[y,m,d]=iso.split('-').map(Number);return new Date(y,m-1,d);}
function fmtDate(iso){if(!iso)return'';return parseDate(iso).toLocaleDateString('es-AR',{day:'2-digit',month:'2-digit',year:'numeric'});}
function diasRestantes(iso){if(!iso)return null;return Math.round((parseDate(iso)-HOY)/864e5);}
function getMesesEj(ej){
  if(!ej||!ej.inicio||!ej.cierre)return null;
  const ini=parseDate(ej.inicio),cie=parseDate(ej.cierre);
  const res=[];let cur=new Date(ini.getFullYear(),ini.getMonth(),1);
  const fin=new Date(cie.getFullYear(),cie.getMonth(),1);
  while(cur<=fin&&res.length<=24){res.push({mes:cur.getMonth(),anio:cur.getFullYear()});cur=new Date(cur.getFullYear(),cur.getMonth()+1,1);}
  return res;
}
// ═══ TAREAS PERIODICAS (no mensuales, ej: Ganancias, Bienes Personales) ═══
function periodicasDeEmpresa(empIdx){return data.periodicas.map((p,i)=>({...p,_idx:i})).filter(p=>p.emp===empIdx);}
function sumarPeriodo(fechaIso,periodicidad){
  const d=parseDate(fechaIso);
  if(periodicidad==='trimestral')d.setMonth(d.getMonth()+3);
  else if(periodicidad==='semestral')d.setMonth(d.getMonth()+6);
  else d.setFullYear(d.getFullYear()+1); // anual por defecto
  return d.toISOString().slice(0,10);
}
function renovarPeriodica(idx){
  const p=data.periodicas[idx];if(!p)return;
  p.estado='Pendiente';
  p.vencimiento=sumarPeriodo(p.vencimiento,p.periodicidad);
  markUnsaved();saveNow();renderTrabajoContent();toast('Tarea periodica renovada para el proximo vencimiento');
}
function toast(msg,err=false){const t=document.getElementById('toast');t.textContent=msg;t.style.background=err?'#742A2A':'#1A202C';t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2500);}
function badgeCls(p){return p>=1?'b100':p>=.75?'b75':p>.05?'b50':'b0';}
function estadoClass(est){return est==='Hecho'?'tr-hecho':est==='Pendiente'?'tr-pendiente':est==='Esperando Cliente'?'tr-espera':est==='No Corresponde'?'tr-nc':'';}

// ═══ DASHBOARD ═══
function buildDashMesSel(){const s=document.getElementById('dash-mes-sel');s.innerHTML='';MESES.forEach((m,i)=>{const o=document.createElement('option');o.value=i;o.textContent=m;s.appendChild(o);});s.value=MES_ACTUAL;}
function renderDashboard(){
  const mes=parseInt(document.getElementById('dash-mes-sel').value);
  document.getElementById('dash-mes-lbl').textContent=`${MESES[mes]} ${activeYear}`;
  const h=countMes(mes,'Hecho'),p=countMes(mes,'Pendiente');
  const pct=pctMes(mes),mins=totalMinsMesYr(mes,activeYear),totalAnio=totalMinsAll(activeYear);
  const comp=EMPRESAS.filter((_,ei)=>Math.round(pctEmpMesYr(mes,ei,activeYear)*100)===100).length;
  const urg=data.ejercicios.filter(ej=>!ej.cerrado&&diasRestantes(ej.cierre)!==null&&diasRestantes(ej.cierre)>=0&&diasRestantes(ej.cierre)<=30).length;
  const urgPer=data.periodicas.filter(p=>p.estado!=='Hecho'&&diasRestantes(p.vencimiento)!==null&&diasRestantes(p.vencimiento)<=30).length;
  document.getElementById('kpi-dash').innerHTML=`
    <div class="kpi"><div class="kpi-label">Empresas</div><div class="kpi-val">${EMPRESAS.length}</div><div class="kpi-sub">${comp} completadas</div></div>
    <div class="kpi"><div class="kpi-label">Hechas</div><div class="kpi-val" style="color:var(--green2)">${h}</div><div class="kpi-sub">${MESES[mes]}</div></div>
    <div class="kpi"><div class="kpi-label">Pendientes</div><div class="kpi-val" style="color:var(--red)">${p}</div></div>
    <div class="kpi"><div class="kpi-label">Avance mes</div><div class="kpi-val" style="color:var(--accent)">${Math.round(pct*100)}%</div><div class="prog-wrap"><div class="prog-bar" style="width:${Math.round(pct*100)}%"></div></div></div>
    <div class="kpi"><div class="kpi-label">Tiempo este mes</div><div class="kpi-val">${fmtMin(mins)}</div></div>
    <div class="kpi"><div class="kpi-label">Tiempo total ${activeYear}</div><div class="kpi-val" style="color:var(--purple)">${fmtMin(totalAnio)}</div></div>
    ${urg?`<div class="kpi" style="border-color:#FC8181"><div class="kpi-label" style="color:var(--red)">Ejercicios urgentes</div><div class="kpi-val" style="color:var(--red)">${urg}</div><div class="kpi-sub">cierre en 30 dias</div></div>`:''}
    ${urgPer?`<div class="kpi" style="border-color:#F6AD55"><div class="kpi-label" style="color:var(--orange)">Periodicas urgentes</div><div class="kpi-val" style="color:var(--orange)">${urgPer}</div><div class="kpi-sub">vencen en 30 dias</div></div>`:''}
  `;
  const grid=document.getElementById('emp-grid');grid.innerHTML='';
  EMPRESAS.forEach((emp,ei)=>{
    const pctE=pctEmpMesYr(mes,ei,activeYear),w=Math.round(pctE*100);
    const minsM=totalMinsEmpMesYr(ei,mes,activeYear);
    const ej=ejActivoDeEmpresa(ei);
    const minsEj=totalMinsEjercicio(ej);
    const diasC=ej?diasRestantes(ej.cierre):null;
    const dots=tareasDeEmpresa(ei).map(t=>{const est=getE(mes,ei,t);const cls=est==='Hecho'?'d-hecho':est==='Pendiente'?'d-pendiente':est==='Esperando Cliente'?'d-espera':est==='No Corresponde'?'d-nc':'d-empty';return`<div class="dot ${cls}" title="${TAREAS[t]}: ${est||'Sin registrar'}"></div>`;}).join('');
    let ejHtml='';
    if(ej){
      const numEjs=ejsDeEmpresa(ei).length;
      if(ej.cerrado){ejHtml=`<div style="font-size:10px;color:var(--gray);font-weight:600;margin-top:2px">${ej.numero} · Cerrado ${numEjs>1?'· '+numEjs+' ejercicios':''}</div>`;}
      else if(diasC!==null){const ec=diasC<0?'color:var(--red)':diasC<=30?'color:var(--orange)':'color:var(--green)';const et=diasC<0?`Vencido hace ${Math.abs(diasC)}d`:diasC===0?'Vence hoy':`${diasC}d para cierre`;ejHtml=`<div style="font-size:10px;${ec};font-weight:600;margin-top:2px">${ej.numero} · ${et}${numEjs>1?' · '+numEjs+' ejs':''}</div>`;}
    }
    const card=document.createElement('div');card.className='emp-card'+(w===100?' complete':'');
    card.innerHTML=`
      <div class="emp-card-top"><div><div class="emp-name">${emp}</div>${ejHtml}</div><span class="emp-badge ${badgeCls(pctE)}">${w}%</span></div>
      <div class="tarea-dots">${dots}</div>
      <div class="prog-wrap"><div class="prog-bar" style="width:${w}%"></div></div>
      <div class="emp-footer"><span>Mes: <strong>${fmtMin(minsM)}</strong></span><span>${ej?'Ejercicio':'Ano'}: <strong>${ej?fmtMin(minsEj):fmtMin(totalMinsEmpYr(ei,activeYear))}</strong></span></div>`;
    card.addEventListener('click',()=>openTrabajo(ei,mes,activeYear));
    grid.appendChild(card);
  });
}

// ═══ CARGAR TRABAJO ═══
function buildWorkEmpSel(){const s=document.getElementById('work-emp');s.innerHTML='';EMPRESAS.forEach((e,i)=>{const o=document.createElement('option');o.value=i;o.textContent=e;s.appendChild(o);});s.value=workEmpIdx;}

function buildEjSelector(){
  const div=document.getElementById('ej-selector');div.innerHTML='';
  const ejs=ejsDeEmpresa(workEmpIdx);
  if(!ejs.length){div.innerHTML='<span style="font-size:12px;color:#A0AEC0">Sin ejercicios. <span style="color:var(--accent);cursor:pointer" onclick="showPanel(\'ejercicios\',document.querySelectorAll(\'.tab\')[2])">Agregar →</span></span>';return;}
  ejs.forEach(ej=>{
    const btn=document.createElement('button');
    btn.className='ej-sel-btn'+(ej.cerrado?' cerrado':'')+(workEjIdx===ej._idx?' active':'');
    btn.innerHTML=`${ej.cerrado?'🔒':'📂'} ${ej.numero}${ej.cerrado?' <span style="font-size:9px">(cerrado)</span>':''}`;
    btn.onclick=()=>{workEjIdx=ej._idx;verCierreForzado=false;buildEjSelector();renderTrabajoContent();};
    div.appendChild(btn);
  });
}

function openTrabajo(empIdx,mes,anio){
  workEmpIdx=empIdx;workMes=mes;workMesYear=anio||activeYear;
  verCierreForzado=false;
  const ejActivo=ejActivoDeEmpresa(empIdx);
  workEjIdx=ejActivo?ejActivo._idx:null;
  showPanel('trabajo',document.querySelectorAll('.tab')[1]);
  document.getElementById('work-emp').value=empIdx;
  renderTrabajo();
}

function onChangeWorkEmp(){
  workEmpIdx=parseInt(document.getElementById('work-emp').value);
  verCierreForzado=false;
  const ejActivo=ejActivoDeEmpresa(workEmpIdx);
  workEjIdx=ejActivo?ejActivo._idx:null;
  const ej=workEjIdx!==null?data.ejercicios[workEjIdx]:null;
  const meses=getMesesEj(ej)||[{mes:MES_ACTUAL,anio:activeYear}];
  workMes=meses[0].mes;workMesYear=meses[0].anio;
  renderTrabajo();
}

function renderTrabajo(){
  workEmpIdx=parseInt(document.getElementById('work-emp').value);
  buildEjSelector();
  renderTrabajoContent();
}

function renderTrabajoContent(){
  const ej=workEjIdx!==null?data.ejercicios[workEjIdx]:null;
  const mesesList=getMesesEj(ej)||MESES.map((_,i)=>({mes:i,anio:activeYear}));
  if(!mesesList.some(x=>x.mes===workMes&&x.anio===workMesYear)){
    workMes=mesesList[0].mes;workMesYear=mesesList[0].anio;
  }
  const pillsDiv=document.getElementById('mes-pills');pillsDiv.innerHTML='';
  mesesList.forEach(({mes,anio})=>{
    const pct=pctEmpMesYr(mes,workEmpIdx,anio);
    const cls=pct>=1?'mp-ok':pct>0?'mp-wip':'mp-empty';
    const isActive=mes===workMes&&anio===workMesYear;
    const pill=document.createElement('span');
    pill.className='mes-pill '+cls+(isActive?' active':'');
    const yrSuffix=anio!==activeYear?` '${String(anio).slice(2)}`:'';
    pill.textContent=MESES[mes].slice(0,3)+yrSuffix;
    pill.title=`${MESES[mes]} ${anio}`;
    pill.onclick=()=>{workMes=mes;workMesYear=anio;renderTrabajoContent();};
    pillsDiv.appendChild(pill);
  });
  document.getElementById('work-mes-lbl').textContent=`${MESES[workMes]} ${workMesYear}`;
  const ejDiv=document.getElementById('ej-info-bar');
  if(ej){
    const d=diasRestantes(ej.cierre);
    const cls=ej.cerrado?'ej-cerrado':d<0?'ej-danger':d<=30?'ej-warn':'ej-ok';
    const estado=ej.cerrado?'🔒 CERRADO':d<0?`Vencido hace ${Math.abs(d)} dias`:d===0?'Vence hoy':`Faltan ${d} dias`;
    ejDiv.innerHTML=`<div class="ej-info-bar ${cls}">${ej.numero} | ${fmtDate(ej.inicio)} → ${fmtDate(ej.cierre)} | ${estado}</div>`;
  } else {
    ejDiv.innerHTML=`<div style="font-size:11px;color:#A0AEC0;margin-bottom:.6rem">Sin ejercicio. <span style="color:var(--accent);cursor:pointer" onclick="showPanel('ejercicios',document.querySelectorAll('.tab')[2])">Agregar →</span></div>`;
  }
  renderTareaRows();
  renderCierreRows(ej,workEjIdx);
  renderPeriodicaRows();
  renderWorkStats();
  buildTareaSels(ej,workEjIdx);
  renderHistorial();
}

function renderTareaRows(){
  const div=document.getElementById('tarea-rows');div.innerHTML='';
  const idxs=tareasDeEmpresa(workEmpIdx);
  if(!idxs.length){div.innerHTML='<div style="font-size:12px;color:#A0AEC0;padding:.4rem 0">Esta empresa no tiene tareas rutinarias asignadas. Configuralas en Config → Empresas.</div>';return;}
  idxs.forEach(ti=>{
    const tarea=TAREAS[ti];
    const est=getE(workMes,workEmpIdx,ti,workMesYear);
    const minsM=tiemposYr(workMesYear).filter(r=>r.emp===workEmpIdx&&r.mes===workMes&&r.tarea===ti&&r.tipo==='rutinaria').reduce((a,r)=>a+r.mins,0);
    const ej=workEjIdx!==null?data.ejercicios[workEjIdx]:null;
    const mesesEj=getMesesEj(ej)||[];
    const minsEj=mesesEj.reduce((acc,{mes,anio})=>acc+tiemposYr(anio).filter(r=>r.emp===workEmpIdx&&r.mes===mes&&r.tarea===ti&&r.tipo==='rutinaria').reduce((a,r)=>a+r.mins,0),0);
    const row=document.createElement('div');row.className=`tarea-row ${estadoClass(est)}`;
    row.innerHTML=`
      <span class="tarea-name">${tarea}</span>
      <div class="estado-btns">
        <button class="ebtn ebtn-hecho${est==='Hecho'?' active':''}" onclick="setEstadoWork(${ti},'Hecho')">✅ Hecho</button>
        <button class="ebtn ebtn-pendiente${est==='Pendiente'?' active':''}" onclick="setEstadoWork(${ti},'Pendiente')">⏳ Pendiente</button>
        <button class="ebtn ebtn-espera${est==='Esperando Cliente'?' active':''}" onclick="setEstadoWork(${ti},'Esperando Cliente')">🕓 Espera cliente</button>
        <button class="ebtn ebtn-nc${est==='No Corresponde'?' active':''}" onclick="setEstadoWork(${ti},'No Corresponde')">— N/C</button>
      </div>
      <div class="tarea-time-area">
        <input type="number" class="mins-inp" id="mins-r-${ti}" placeholder="min" min="1" max="999" onkeydown="if(event.key==='Enter'){addMinsRow('rutinaria',${ti});this.value='';}">
        <button class="btn-success btn-sm" onclick="addMinsRow('rutinaria',${ti})"><i class="ti ti-plus"></i></button>
        <span class="tarea-acum">Mes:<b>${fmtMin(minsM)}</b>${mesesEj.length?` Ej:<b>${fmtMin(minsEj)}</b>`:''}</span>
      </div>`;
    div.appendChild(row);
  });
}

function renderCierreRows(ej,ejIdx){
  const div=document.getElementById('cierre-rows');div.innerHTML='';
  if(!ej||!ej.tareascierre||!ej.tareascierre.length){
    div.innerHTML='<div style="font-size:12px;color:#A0AEC0;padding:.4rem 0">No hay tareas de cierre. Agrega las que correspondan a esta empresa.</div>';return;
  }
  const mesesEj=getMesesEj(ej)||[];
  const ultimoMes=mesesEj.length?mesesEj[mesesEj.length-1]:null;
  const esUltimoMes=ultimoMes&&ultimoMes.mes===workMes&&ultimoMes.anio===workMesYear;
  if(!esUltimoMes&&!verCierreForzado){
    const lbl=ultimoMes?`${MESES[ultimoMes.mes]} ${ultimoMes.anio}`:'el ultimo mes del ejercicio';
    div.innerHTML=`<div style="font-size:12px;color:var(--gray);padding:.5rem 0">Estas tareas se habilitan en <b>${lbl}</b> (cierre del ejercicio). <span style="color:var(--accent);cursor:pointer" onclick="mostrarCierreForzado()">Mostrar de todas formas →</span></div>`;
    return;
  }
  ej.tareascierre.forEach((tc,ci)=>{
    const est=getCierreE(ejIdx,ci);
    const minsCiTotal=mesesEj.reduce((acc,{mes,anio})=>acc+tiemposYr(anio).filter(r=>r.emp===ej.emp&&r.mes===mes&&r.tipo==='cierre'&&r.tarea===ci).reduce((a,r)=>a+r.mins,0),0);
    const row=document.createElement('div');row.className=`tarea-row tr-cierre ${estadoClass(est)}`;
    row.innerHTML=`
      <span class="tarea-name">${tc.nombre}<span class="tarea-type tt-cierre">CIERRE</span></span>
      <div class="estado-btns">
        <button class="ebtn ebtn-hecho${est==='Hecho'?' active':''}" onclick="setEstadoCierre(${ejIdx},${ci},'Hecho')">✅ Hecho</button>
        <button class="ebtn ebtn-pendiente${est==='Pendiente'?' active':''}" onclick="setEstadoCierre(${ejIdx},${ci},'Pendiente')">⏳ Pendiente</button>
        <button class="ebtn ebtn-espera${est==='Esperando Cliente'?' active':''}" onclick="setEstadoCierre(${ejIdx},${ci},'Esperando Cliente')">🕓 Espera cliente</button>
        <button class="ebtn ebtn-nc${est==='No Corresponde'?' active':''}" onclick="setEstadoCierre(${ejIdx},${ci},'No Corresponde')">— N/C</button>
      </div>
      <div class="tarea-time-area">
        <input type="number" class="mins-inp" id="mins-c-${ci}" placeholder="min" min="1" max="999" onkeydown="if(event.key==='Enter'){addMinsRow('cierre',${ci});this.value='';}">
        <button class="btn-success btn-sm" onclick="addMinsRow('cierre',${ci})"><i class="ti ti-plus"></i></button>
        <button class="btn-ghost btn-sm" onclick="openCierreModal(${ejIdx},${ci})" title="Editar o eliminar esta tarea de cierre"><i class="ti ti-pencil"></i> Editar</button>
        <span class="tarea-acum">Ejercicio:<b>${fmtMin(minsCiTotal)}</b></span>
      </div>`;
    div.appendChild(row);
  });
}

function mostrarCierreForzado(){verCierreForzado=true;renderTrabajoContent();}

function renderPeriodicaRows(){
  const div=document.getElementById('periodica-rows');if(!div)return;div.innerHTML='';
  const items=periodicasDeEmpresa(workEmpIdx);
  if(!items.length){
    div.innerHTML='<div style="font-size:12px;color:#A0AEC0;padding:.4rem 0">No hay tareas periodicas cargadas para esta empresa (ej: Ganancias, Bienes Personales).</div>';return;
  }
  items.sort((a,b)=>(a.vencimiento||'').localeCompare(b.vencimiento||''));
  items.forEach(p=>{
    const idx=p._idx;
    const est=p.estado||'';
    const d=diasRestantes(p.vencimiento);
    const mins=tiemposYr(activeYear).filter(r=>r.emp===workEmpIdx&&r.tipo==='periodica'&&r.tarea===idx).reduce((a,r)=>a+r.mins,0);
    let vencHtml='';
    if(p.vencimiento){
      const ec=d<0?'color:var(--red)':d<=30?'color:var(--orange)':'color:var(--gray)';
      const et=d<0?`Vencido hace ${Math.abs(d)}d`:d===0?'Vence hoy':`Vence en ${d}d`;
      vencHtml=`<span style="font-size:10px;${ec};font-weight:600;margin-left:6px">${fmtDate(p.vencimiento)} · ${et}</span>`;
    }
    const row=document.createElement('div');row.className=`tarea-row tr-periodica ${estadoClass(est)}`;
    row.innerHTML=`
      <span class="tarea-name">${p.nombre}<span class="tarea-type tt-periodica">${(p.periodicidad||'anual').toUpperCase()}</span>${vencHtml}</span>
      <div class="estado-btns">
        <button class="ebtn ebtn-hecho${est==='Hecho'?' active':''}" onclick="setEstadoPeriodica(${idx},'Hecho')">✅ Hecho</button>
        <button class="ebtn ebtn-pendiente${est==='Pendiente'?' active':''}" onclick="setEstadoPeriodica(${idx},'Pendiente')">⏳ Pendiente</button>
        <button class="ebtn ebtn-espera${est==='Esperando Cliente'?' active':''}" onclick="setEstadoPeriodica(${idx},'Esperando Cliente')">🕓 Espera cliente</button>
        <button class="ebtn ebtn-nc${est==='No Corresponde'?' active':''}" onclick="setEstadoPeriodica(${idx},'No Corresponde')">— N/C</button>
      </div>
      <div class="tarea-time-area">
        <input type="number" class="mins-inp" id="mins-p-${idx}" placeholder="min" min="1" max="999" onkeydown="if(event.key==='Enter'){addMinsRow('periodica',${idx});this.value='';}">
        <button class="btn-success btn-sm" onclick="addMinsRow('periodica',${idx})"><i class="ti ti-plus"></i></button>
        <button class="btn-ghost btn-sm" onclick="openPeriodicaModal(${idx})" title="Editar o eliminar esta tarea periodica"><i class="ti ti-pencil"></i> Editar</button>
        ${est==='Hecho'?`<button class="btn-ghost btn-sm" onclick="renovarPeriodica(${idx})" title="Renovar para el proximo vencimiento"><i class="ti ti-repeat"></i></button>`:''}
        <span class="tarea-acum">Acumulado:<b>${fmtMin(mins)}</b></span>
      </div>`;
    div.appendChild(row);
  });
}

function setEstadoWork(ti,estado){
  const actual=getE(workMes,workEmpIdx,ti,workMesYear);
  setE(workMes,workEmpIdx,ti,actual===estado?'':estado,workMesYear);
  renderTareaRows();renderWorkStats();refreshActivePill();
}
function setEstadoCierre(ejIdx,ci,estado){
  const actual=getCierreE(ejIdx,ci);
  setCierreE(ejIdx,ci,actual===estado?'':estado);
  const ej=data.ejercicios[ejIdx];renderCierreRows(ej,ejIdx);renderWorkStats();
}
function setEstadoPeriodica(idx,estado){
  const actual=data.periodicas[idx].estado;
  data.periodicas[idx].estado=actual===estado?'':estado;
  markUnsaved();renderPeriodicaRows();renderWorkStats();
}
function refreshActivePill(){
  document.querySelectorAll('.mes-pill').forEach(p=>{
    if(p.classList.contains('active')){const pct=pctEmpMesYr(workMes,workEmpIdx,workMesYear);p.className='mes-pill active '+(pct>=1?'mp-ok':pct>0?'mp-wip':'mp-empty');}
  });
}
function marcarTodas(estado){
  tareasDeEmpresa(workEmpIdx).forEach(t=>setE(workMes,workEmpIdx,t,estado,workMesYear));
  const ej=workEjIdx!==null?data.ejercicios[workEjIdx]:null;
  if(ej&&ej.tareascierre){if(!ej.estadoscierre)ej.estadoscierre=[];ej.tareascierre.forEach((_,ci)=>{ej.estadoscierre[ci]=estado;});}
  markUnsaved();renderTareaRows();renderCierreRows(ej,workEjIdx);renderWorkStats();toast(`Todas marcadas: ${estado}`);
}
function addMinsRow(tipo,idx){
  const inp=document.getElementById(tipo==='cierre'?`mins-c-${idx}`:tipo==='periodica'?`mins-p-${idx}`:`mins-r-${idx}`);
  const mins=parseInt(inp.value);
  if(!mins||mins<1){toast('Ingresa minutos validos',true);return;}
  saveTimeRec(mins,'manual',workEmpIdx,idx,workMes,workMesYear,tipo);inp.value='';
}
function buildTareaSels(ej,ejIdx){
  const ops=[
    ...tareasDeEmpresa(workEmpIdx).map(i=>({label:TAREAS[i],tipo:'rutinaria',idx:i})),
    ...(ej&&ej.tareascierre?ej.tareascierre.map((tc,i)=>({label:`[CIERRE] ${tc.nombre}`,tipo:'cierre',idx:i})):[]),
    ...periodicasDeEmpresa(workEmpIdx).map(p=>({label:`[PERIODICA] ${p.nombre}`,tipo:'periodica',idx:p._idx}))
  ];
  ['timer-tarea','manual-tarea'].forEach(id=>{const s=document.getElementById(id);s.innerHTML='';ops.forEach(op=>{const o=document.createElement('option');o.value=JSON.stringify({tipo:op.tipo,idx:op.idx});o.textContent=op.label;s.appendChild(o);});});
}
function renderWorkStats(){
  const ej=workEjIdx!==null?data.ejercicios[workEjIdx]:null;
  const minsEj=totalMinsEjercicio(ej);
  const minsM=totalMinsEmpMesYr(workEmpIdx,workMes,workMesYear);
  const mesesEj=getMesesEj(ej);
  let minsRut=0,minsCie=0,rutLbl;
  if(mesesEj){
    // acotado a los meses del ejercicio actual, para no mezclar con otro ejercicio de la misma empresa
    mesesEj.forEach(({mes,anio})=>{
      tiemposYr(anio).filter(r=>r.emp===workEmpIdx&&r.mes===mes).forEach(r=>{
        if(r.tipo==='rutinaria')minsRut+=r.mins;
        else if(r.tipo==='cierre')minsCie+=r.mins;
      });
    });
    rutLbl='Rutinarias (este ejercicio)';
  } else {
    // sin ejercicio cargado: no hay otro alcance posible, mostramos el ano calendario
    minsRut=tiemposYr(workMesYear).filter(r=>r.emp===workEmpIdx&&r.tipo==='rutinaria').reduce((a,r)=>a+r.mins,0);
    minsCie=tiemposYr(workMesYear).filter(r=>r.emp===workEmpIdx&&r.tipo==='cierre').reduce((a,r)=>a+r.mins,0);
    rutLbl=`Rutinarias ${workMesYear}`;
  }
  const minsPer=tiemposYr(workMesYear).filter(r=>r.emp===workEmpIdx&&r.tipo==='periodica').reduce((a,r)=>a+r.mins,0);
  document.getElementById('work-stats').innerHTML=`
    <div class="scard-title"><i class="ti ti-chart-bar"></i> Tiempos — ${EMPRESAS[workEmpIdx]}</div>
    <div class="stat-row"><span>Este mes (${MESES[workMes]})</span><span class="stat-val">${fmtMin(minsM)}</span></div>
    ${ej?`<div class="stat-row"><span>Total ejercicio</span><span class="stat-val" style="color:var(--purple)">${fmtMin(minsEj)}</span></div>`:''}
    <div class="stat-row"><span>${rutLbl}</span><span class="stat-val">${fmtMin(minsRut)}</span></div>
    <div class="stat-row"><span>Tareas de cierre</span><span class="stat-val" style="color:var(--purple)">${fmtMin(minsCie)}</span></div>
    <div class="stat-row"><span>Tareas periodicas</span><span class="stat-val" style="color:var(--orange)">${fmtMin(minsPer)}</span></div>
  `;
}

// ═══ HISTORIAL ═══
function toggleHistorial(){const w=document.getElementById('historial-wrap');w.style.display=w.style.display==='none'?'block':'none';if(w.style.display==='block')renderHistorial();}
function renderHistorial(){
  const div=document.getElementById('historial-list');div.innerHTML='';
  const regs=[];
  getYears().forEach(yr=>{(getYD(yr).tiempos||[]).forEach((r,i)=>{if(r.emp===workEmpIdx&&r.mes===workMes)regs.push({...r,yr,idx:i});});});
  if(!regs.length){div.innerHTML='<div style="font-size:12px;color:#A0AEC0">Sin registros en este mes.</div>';return;}
  const ej=workEjIdx!==null?data.ejercicios[workEjIdx]:null;
  regs.sort((a,b)=>(b.fecha||'').localeCompare(a.fecha||'')).forEach(r=>{
    const label=r.tipo==='cierre'?(ej?.tareascierre?.[r.tarea]?.nombre||'Cierre'):r.tipo==='periodica'?(data.periodicas[r.tarea]?.nombre||'Periodica'):(TAREAS[r.tarea]||'Tarea');
    const tipoLbl=r.tipo==='cierre'?'cierre':r.tipo==='periodica'?'periodica':'rutinaria';
    const row=document.createElement('div');row.className='hist-row';
    row.innerHTML=`<span class="hist-mins">${fmtMin(r.mins)}</span><span class="hist-label">${label} <span style="font-size:10px;background:var(--grayl);padding:1px 5px;border-radius:99px">${tipoLbl}</span></span><span class="hist-fecha">${r.fecha||''}</span><button class="btn-ghost btn-sm" style="padding:2px 6px;font-size:11px" onclick="openEditTiempo('${r.yr}',${r.idx},'${label}',${r.mins})"><i class="ti ti-pencil"></i></button>`;
    div.appendChild(row);
  });
}

// ═══ MODAL EDITAR TIEMPO ═══
function openEditTiempo(yr,idx,label,mins){editTiempoRef={yr:parseInt(yr),idx};document.getElementById('edit-tiempo-label').textContent=label;document.getElementById('edit-tiempo-mins').value=mins;document.getElementById('modal-edit-tiempo').classList.add('open');}
function closeEditTiempo(){document.getElementById('modal-edit-tiempo').classList.remove('open');editTiempoRef=null;}
function saveEditTiempo(){
  const mins=parseInt(document.getElementById('edit-tiempo-mins').value);
  if(!mins||mins<1){toast('Minutos invalidos',true);return;}
  getYD(editTiempoRef.yr).tiempos[editTiempoRef.idx].mins=mins;
  markUnsaved();saveNow();closeEditTiempo();renderTareaRows();
  const ej=workEjIdx!==null?data.ejercicios[workEjIdx]:null;
  renderCierreRows(ej,workEjIdx);renderPeriodicaRows();renderWorkStats();renderHistorial();toast('Tiempo actualizado');
}
function deleteEditTiempo(){
  if(!confirm('Eliminar este registro?'))return;
  getYD(editTiempoRef.yr).tiempos.splice(editTiempoRef.idx,1);
  markUnsaved();saveNow();closeEditTiempo();renderTareaRows();
  const ej=workEjIdx!==null?data.ejercicios[workEjIdx]:null;
  renderCierreRows(ej,workEjIdx);renderPeriodicaRows();renderWorkStats();renderHistorial();toast('Registro eliminado');
}

// ═══ CRONOMETRO ═══
let timerInt=null,timerSec=0,timerOn=false;
function tickTimer(){timerSec++;updTimer();}
function updTimer(){const h=Math.floor(timerSec/3600),mn=Math.floor((timerSec%3600)/60),s=timerSec%60;document.getElementById('timer-disp').textContent=`${String(h).padStart(2,'0')}:${String(mn).padStart(2,'0')}:${String(s).padStart(2,'0')}`;document.getElementById('timer-prog').style.width=Math.min((timerSec/3600)*100,100)+'%';}
function timerStart(){if(timerOn)return;timerOn=true;timerInt=setInterval(tickTimer,1000);document.getElementById('btn-start').disabled=true;document.getElementById('btn-pause').disabled=false;document.getElementById('btn-stop').disabled=false;}
function timerPause(){if(!timerOn)return;clearInterval(timerInt);timerOn=false;document.getElementById('btn-start').disabled=false;document.getElementById('btn-pause').disabled=true;}
function timerStop(){clearInterval(timerInt);timerOn=false;const mins=Math.max(1,Math.round(timerSec/60));const val=JSON.parse(document.getElementById('timer-tarea').value||'{"tipo":"rutinaria","idx":0}');saveTimeRec(mins,'cronometro',workEmpIdx,val.idx,workMes,workMesYear,val.tipo);timerSec=0;updTimer();document.getElementById('btn-start').disabled=false;document.getElementById('btn-pause').disabled=true;document.getElementById('btn-stop').disabled=true;}
function timerReset(){clearInterval(timerInt);timerOn=false;timerSec=0;updTimer();document.getElementById('btn-start').disabled=false;document.getElementById('btn-pause').disabled=true;document.getElementById('btn-stop').disabled=true;}
function saveManual(){const mins=parseInt(document.getElementById('manual-mins').value);if(!mins||mins<1){toast('Cantidad invalida',true);return;}const val=JSON.parse(document.getElementById('manual-tarea').value||'{"tipo":"rutinaria","idx":0}');saveTimeRec(mins,'manual',workEmpIdx,val.idx,workMes,workMesYear,val.tipo);document.getElementById('manual-mins').value='';}
function saveTimeRec(mins,origen,empIdx,tareaIdx,mes,anio,tipo){
  const yr=anio||activeYear;const yd=getYD(yr);if(!yd.tiempos)yd.tiempos=[];
  yd.tiempos.push({mes,emp:empIdx,tarea:tareaIdx,mins,tipo:tipo||'rutinaria',origen,fecha:new Date().toISOString().slice(0,10)});
  markUnsaved();toast(`${fmtMin(mins)} guardados`);
  if(activePanel==='trabajo'){const ej=workEjIdx!==null?data.ejercicios[workEjIdx]:null;renderTareaRows();renderCierreRows(ej,workEjIdx);renderPeriodicaRows();renderWorkStats();renderHistorial();}
}

// ═══ MODAL TAREAS CIERRE ═══
function openCierreModal(ejIdx=null,ci=null){
  const idx=ejIdx!==null?ejIdx:workEjIdx;
  const ej=idx!==null?data.ejercicios[idx]:null;
  if(!ej){toast('Esta empresa no tiene ejercicio. Agrega uno primero.',true);return;}
  editingCierreEmpIdx=idx;editingCierreIdx=ci;
  document.getElementById('modal-cierre-title').textContent=ci!==null?'Editar tarea de cierre':'Nueva tarea de cierre';
  document.getElementById('modal-cierre-emp').textContent=`${EMPRESAS[ej.emp]} · ${ej.numero}`;
  document.getElementById('cierre-del-btn').style.display=ci!==null?'inline-flex':'none';
  document.getElementById('cierre-nombre').value=ci!==null?ej.tareascierre[ci].nombre:'';
  document.getElementById('cierre-desc').value=ci!==null?(ej.tareascierre[ci].desc||''):'';
  document.getElementById('modal-cierre').classList.add('open');
}
function closeCierreModal(){document.getElementById('modal-cierre').classList.remove('open');editingCierreEmpIdx=null;editingCierreIdx=null;}
function saveCierre(){
  const nombre=document.getElementById('cierre-nombre').value.trim();const desc=document.getElementById('cierre-desc').value.trim();
  if(!nombre){toast('Ingresa un nombre',true);return;}
  const ej=data.ejercicios[editingCierreEmpIdx];if(!ej.tareascierre)ej.tareascierre=[];
  if(editingCierreIdx!==null){ej.tareascierre[editingCierreIdx].nombre=nombre;ej.tareascierre[editingCierreIdx].desc=desc;}
  else ej.tareascierre.push({nombre,desc});
  markUnsaved();saveNow();closeCierreModal();renderTrabajoContent();toast('Tarea de cierre guardada');
}
function deleteCierre(){
  if(!confirm('Eliminar esta tarea de cierre?'))return;
  data.ejercicios[editingCierreEmpIdx].tareascierre.splice(editingCierreIdx,1);
  if(data.ejercicios[editingCierreEmpIdx].estadoscierre)data.ejercicios[editingCierreEmpIdx].estadoscierre.splice(editingCierreIdx,1);
  markUnsaved();saveNow();closeCierreModal();renderTrabajoContent();toast('Eliminada');
}

// ═══ MODAL TAREAS PERIODICAS ═══
let editingPeriodicaIdx=null;
function openPeriodicaModal(idx=null){
  editingPeriodicaIdx=idx;
  const p=idx!==null?data.periodicas[idx]:null;
  document.getElementById('modal-periodica-title').textContent=idx!==null?'Editar tarea periodica':'Nueva tarea periodica';
  document.getElementById('modal-periodica-emp').textContent=EMPRESAS[workEmpIdx];
  document.getElementById('periodica-del-btn').style.display=idx!==null?'inline-flex':'none';
  document.getElementById('periodica-nombre').value=p?p.nombre:'';
  document.getElementById('periodica-periodicidad').value=p?p.periodicidad:'anual';
  document.getElementById('periodica-vencimiento').value=p?p.vencimiento:'';
  document.getElementById('periodica-obs').value=p?(p.obs||''):'';
  document.getElementById('modal-periodica').classList.add('open');
}
function closePeriodicaModal(){document.getElementById('modal-periodica').classList.remove('open');editingPeriodicaIdx=null;}
function savePeriodica(){
  const nombre=document.getElementById('periodica-nombre').value.trim();
  const periodicidad=document.getElementById('periodica-periodicidad').value;
  const vencimiento=document.getElementById('periodica-vencimiento').value;
  const obs=document.getElementById('periodica-obs').value.trim();
  if(!nombre){toast('Ingresa un nombre',true);return;}
  if(editingPeriodicaIdx!==null){
    const p=data.periodicas[editingPeriodicaIdx];
    p.nombre=nombre;p.periodicidad=periodicidad;p.vencimiento=vencimiento;p.obs=obs;
  } else {
    data.periodicas.push({emp:workEmpIdx,nombre,periodicidad,vencimiento,obs,estado:''});
  }
  markUnsaved();saveNow();closePeriodicaModal();renderTrabajoContent();toast('Tarea periodica guardada');
}
function deletePeriodica(){
  if(!confirm('Eliminar esta tarea periodica?'))return;
  const idx=editingPeriodicaIdx;
  data.periodicas.splice(idx,1);
  Object.keys(data.anos).forEach(y=>{
    const a=data.anos[y];
    a.tiempos=(a.tiempos||[]).filter(r=>!(r.tipo==='periodica'&&r.tarea===idx)).map(r=>r.tipo==='periodica'&&r.tarea>idx?{...r,tarea:r.tarea-1}:r);
  });
  markUnsaved();saveNow();closePeriodicaModal();renderTrabajoContent();toast('Eliminada');
}

// ═══ EJERCICIOS ═══
function openEjModal(idx=null){
  editingEjIdx=idx;
  document.getElementById('modal-ej-title').textContent=idx===null?'Nuevo ejercicio':'Editar ejercicio';
  document.getElementById('ej-del-btn').style.display=idx!==null?'inline-flex':'none';
  document.getElementById('ej-cerrar-btn').style.display=idx!==null?'inline-flex':'none';
  const sel=document.getElementById('ej-emp-sel');sel.innerHTML='';EMPRESAS.forEach((e,i)=>{const o=document.createElement('option');o.value=i;o.textContent=e;sel.appendChild(o);});
  if(idx!==null){
    const ej=data.ejercicios[idx];sel.value=ej.emp;
    document.getElementById('ej-numero').value=ej.numero||'';
    document.getElementById('ej-inicio').value=ej.inicio||'';
    document.getElementById('ej-cierre').value=ej.cierre||'';
    document.getElementById('ej-obs').value=ej.obs||'';
    const lbl=document.getElementById('ej-cerrar-lbl');
    lbl.textContent=ej.cerrado?'Reabrir ejercicio':'Cerrar ejercicio';
    document.getElementById('ej-cerrar-btn').className=ej.cerrado?'btn-success':'btn-warn';
  } else {
    sel.value=0;['ej-numero','ej-inicio','ej-cierre','ej-obs'].forEach(id=>document.getElementById(id).value='');
  }
  document.getElementById('modal-ej').classList.add('open');
}
function closeEjModal(){document.getElementById('modal-ej').classList.remove('open');editingEjIdx=null;}
function toggleCierreEj(){
  if(editingEjIdx===null)return;
  const ej=data.ejercicios[editingEjIdx];
  ej.cerrado=!ej.cerrado;
  const lbl=document.getElementById('ej-cerrar-lbl');
  lbl.textContent=ej.cerrado?'Reabrir ejercicio':'Cerrar ejercicio';
  document.getElementById('ej-cerrar-btn').className=ej.cerrado?'btn-success':'btn-warn';
  toast(ej.cerrado?'Ejercicio cerrado':'Ejercicio reabierto');
}
function saveEj(){
  const emp=parseInt(document.getElementById('ej-emp-sel').value);
  const numero=document.getElementById('ej-numero').value.trim();
  const inicio=document.getElementById('ej-inicio').value;
  const cierre=document.getElementById('ej-cierre').value;
  const obs=document.getElementById('ej-obs').value.trim();
  if(!numero){toast('Ingresa un nombre',true);return;}
  if(!inicio||!cierre){toast('Ingresa fechas',true);return;}
  if(inicio>=cierre){toast('El cierre debe ser posterior al inicio',true);return;}
  if(editingEjIdx!==null){
    const ej=data.ejercicios[editingEjIdx];
    ej.emp=emp;ej.numero=numero;ej.inicio=inicio;ej.cierre=cierre;ej.obs=obs;
  } else {
    data.ejercicios.push({emp,numero,inicio,cierre,obs,cerrado:false,tareascierre:[],estadoscierre:[]});
  }
  markUnsaved();saveNow();closeEjModal();renderEjercicios();toast('Ejercicio guardado');
}
function deleteEj(){
  if(editingEjIdx===null)return;
  if(!confirm('Eliminar este ejercicio y todos sus datos?'))return;
  data.ejercicios.splice(editingEjIdx,1);
  markUnsaved();saveNow();closeEjModal();renderEjercicios();toast('Eliminado');
}
function renderEjercicios(){
  const filtro=document.getElementById('ej-filtro').value;
  const grid=document.getElementById('ej-grid');grid.innerHTML='';
  const empConEj=new Set();
  data.ejercicios.forEach((ej,idx)=>{
    const d=diasRestantes(ej.cierre);
    const venc=d!==null&&d<0,urg=d!==null&&d>=0&&d<=30;
    if(filtro==='abiertos'&&ej.cerrado)return;
    if(filtro==='cerrados'&&!ej.cerrado)return;
    if(filtro==='urgente'&&(ej.cerrado||(!venc&&!urg)))return;
    if(filtro==='sin')return;
    empConEj.add(ej.emp);
    const cls=ej.cerrado?'ec-cerrado':venc||urg?'ec-danger':d!==null&&d<=90?'ec-warn':'ec-ok';
    const mesesEj=getMesesEj(ej)||[];
    let hh=0,tot=0;
    mesesEj.forEach(({mes,anio})=>{for(let t=0;t<TAREAS.length;t++){const est=getE(mes,ej.emp,t,anio);if(est!==''&&est!=='No Corresponde'){tot++;if(est==='Hecho')hh++;}}});
    const pct=tot?Math.round(hh/tot*100):0;
    const pend=[];
    mesesEj.forEach(({mes,anio})=>{for(let t=0;t<TAREAS.length;t++){if(getE(mes,ej.emp,t,anio)==='Pendiente')pend.push(`${MESES[mes].slice(0,3)}·${TAREAS[t]}`);}});
    const cierrePend=(ej.tareascierre||[]).filter((_,ci)=>getCierreE(idx,ci)==='Pendiente');
    const minsTotal=totalMinsEjercicio(ej);
    const alDia=avanceHastaHoy(ej);
    const diasHtml=!ej.cerrado&&d!==null?`<div style="font-size:11px;font-weight:700;color:${venc||urg?'var(--red)':d<=90?'var(--orange)':'var(--green)'};margin-top:.3rem">${venc?`Vencio hace ${Math.abs(d)} dias`:d===0?'Vence hoy':`Vence en ${d} dias`}</div>`:'';
    grid.innerHTML+=`<div class="ej-card ${cls}">
      <div style="position:absolute;top:7px;right:7px;display:flex;gap:4px">
        <button class="btn-ghost btn-sm" style="padding:3px 7px;color:var(--accent)" onclick="openEjModal();setTimeout(()=>document.getElementById('ej-emp-sel').value=${ej.emp},50)" title="Nuevo ejercicio para esta empresa"><i class="ti ti-plus"></i></button>
        <button class="btn-ghost btn-sm" style="padding:3px 7px;color:var(--red)" onclick="generarPDF(${idx})" title="PDF"><i class="ti ti-file-type-pdf"></i></button>
        <button class="btn-ghost btn-sm" style="padding:3px 7px" onclick="openEjModal(${idx})" title="Editar este ejercicio"><i class="ti ti-pencil"></i></button>
      </div>
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:.25rem">
        <div class="ej-emp">${EMPRESAS[ej.emp]||'?'}</div>
        <span class="${ej.cerrado?'badge-cerrado':'badge-abierto'}">${ej.cerrado?'🔒 Cerrado':'📂 Abierto'}</span>
      </div>
      <div class="ej-num">${ej.numero}</div>
      <div class="ej-dates">Inicio: <strong>${fmtDate(ej.inicio)}</strong> &nbsp; Cierre: <strong>${fmtDate(ej.cierre)}</strong></div>
      ${diasHtml}
      ${tot?`<div style="margin:.5rem 0"><div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:3px"><span style="color:var(--gray)">Avance rutinarias</span><span style="font-weight:700">${pct}%</span></div><div class="prog-wrap"><div class="prog-bar" style="width:${pct}%;background:${pct===100?'var(--green2)':pct>60?'var(--accent)':'var(--orange)'}"></div></div></div>`:''}
      ${alDia&&alDia.pct!==null?`<div style="margin:.4rem 0;padding:.4rem .6rem;border-radius:var(--radius);background:${alDia.pct>=90?'#F0FFF4':alDia.pct>=60?'#FFFAF0':'#FFF5F5'}"><div style="display:flex;justify-content:space-between;font-size:11px"><span style="color:var(--gray)">Al dia (mes ${alDia.transcurridos} de ${alDia.totalMeses})</span><span style="font-weight:700;color:${alDia.pct>=90?'var(--green)':alDia.pct>=60?'var(--orange)':'var(--red)'}">${alDia.pct}%</span></div></div>`:''}
      ${pend.length?`<div style="margin-top:.3rem">${pend.map(p=>`<span class="ej-tag">${p}</span>`).join('')}</div>`:''}
      ${cierrePend.length?`<div style="margin-top:.3rem">${cierrePend.map(tc=>`<span class="ej-tag" style="background:var(--purplel);color:var(--purple)">${tc.nombre}</span>`).join('')}</div>`:''}
      ${!pend.length&&!cierrePend.length&&tot?`<div style="font-size:11px;color:var(--green);margin-top:.3rem">✅ Sin pendientes</div>`:''}
      <div style="font-size:11px;color:var(--gray);margin-top:.4rem">Tiempo total: <strong style="color:var(--purple)">${fmtMin(minsTotal)||'--'}</strong></div>
      ${ej.tareascierre&&ej.tareascierre.length?`<div style="font-size:10px;color:var(--purple);margin-top:.2rem">${ej.tareascierre.length} tarea(s) de cierre</div>`:''}
      ${ej.obs?`<div style="font-size:11px;color:var(--gray);margin-top:.3rem;font-style:italic">${ej.obs}</div>`:''}
      <div style="margin-top:.6rem">
        <button class="btn-ghost btn-sm" style="font-size:11px;width:100%;justify-content:center" onclick="openTrabajo(${ej.emp},${MES_ACTUAL},${activeYear});workEjIdx=${idx};buildEjSelector();renderTrabajoContent()">
          <i class="ti ti-pencil"></i> Cargar trabajo en este ejercicio
        </button>
      </div>
    </div>`;
  });
  if(filtro==='todos'||filtro==='sin'){
    EMPRESAS.forEach((emp,ei)=>{
      if(empConEj.has(ei)&&filtro!=='sin')return;
      if(!ejsDeEmpresa(ei).length){
        grid.innerHTML+=`<div class="ej-card ec-nuevo" onclick="openEjModal();setTimeout(()=>document.getElementById('ej-emp-sel').value=${ei},50)"><div class="ej-emp" style="color:var(--gray)">${emp}</div><div style="font-size:12px;color:#A0AEC0;margin-top:.2rem">Sin ejercicio</div><div style="font-size:12px;color:var(--accent);margin-top:.5rem"><i class="ti ti-plus"></i> Agregar</div></div>`;
      }
    });
  }
  if(!grid.innerHTML)grid.innerHTML='<div style="color:var(--gray);font-size:13px;padding:.5rem">No hay ejercicios con ese filtro.</div>';
}

// ═══ TIEMPOS ═══
function buildTiempoEmpFiltro(){const s=document.getElementById('tiempo-filtro-emp');s.innerHTML='<option value="todos">Todas las empresas</option>';EMPRESAS.forEach((e,i)=>{const o=document.createElement('option');o.value=i;o.textContent=e;s.appendChild(o);});}
function renderTiempos(){
  const filtroEmp=document.getElementById('tiempo-filtro-emp').value;
  const sort=document.getElementById('tiempo-sort').value;
  const yr=activeYear;
  const totalRut=totalMinsRutinariaYr(yr),totalCie=totalMinsCierreYr(yr),totalPer=totalMinsPeriodicaYr(yr),totalTodo=totalMinsAll(yr);
  document.getElementById('kpi-tiempos').innerHTML=`
    <div class="kpi"><div class="kpi-label">Tiempo total ${yr}</div><div class="kpi-val" style="color:var(--navy)">${fmtMin(totalTodo)}</div></div>
    <div class="kpi"><div class="kpi-label">Rutinarias</div><div class="kpi-val" style="color:var(--accent)">${fmtMin(totalRut)}</div></div>
    <div class="kpi"><div class="kpi-label">Cierre de balance</div><div class="kpi-val" style="color:var(--purple)">${fmtMin(totalCie)}</div></div>
    <div class="kpi"><div class="kpi-label">Periodicas</div><div class="kpi-val" style="color:var(--orange)">${fmtMin(totalPer)}</div></div>
    <div class="kpi"><div class="kpi-label">Empresas con tiempo</div><div class="kpi-val">${EMPRESAS.filter((_,i)=>totalMinsEmpYr(i,yr)>0).length}</div></div>
  `;
  let emps=EMPRESAS.map((emp,ei)=>{
    const ej=ejActivoDeEmpresa(ei);
    let totalM,rut,cie,per,porTarea,porCierre;
    if(sort==='ejercicio'&&ej){
      const mesesEj=getMesesEj(ej)||[];
      const tiempos=mesesEj.flatMap(({mes,anio})=>tiemposYr(anio).filter(r=>r.emp===ei&&r.mes===mes));
      totalM=tiempos.reduce((a,r)=>a+r.mins,0);
      rut=tiempos.filter(r=>r.tipo==='rutinaria').reduce((a,r)=>a+r.mins,0);
      cie=tiempos.filter(r=>r.tipo==='cierre').reduce((a,r)=>a+r.mins,0);
      per=tiempos.filter(r=>r.tipo==='periodica').reduce((a,r)=>a+r.mins,0);
      porTarea=TAREAS.map((t,ti)=>({t,m:tiempos.filter(r=>r.tarea===ti&&r.tipo==='rutinaria').reduce((a,r)=>a+r.mins,0)})).filter(x=>x.m>0);
      porCierre=ej.tareascierre?ej.tareascierre.map((tc,ci)=>({t:tc.nombre,m:tiempos.filter(r=>r.tarea===ci&&r.tipo==='cierre').reduce((a,r)=>a+r.mins,0)})).filter(x=>x.m>0):[];
    } else {
      const tiempos=tiemposYr(yr).filter(r=>r.emp===ei);
      totalM=tiempos.reduce((a,r)=>a+r.mins,0);
      rut=tiempos.filter(r=>r.tipo==='rutinaria').reduce((a,r)=>a+r.mins,0);
      cie=tiempos.filter(r=>r.tipo==='cierre').reduce((a,r)=>a+r.mins,0);
      per=tiempos.filter(r=>r.tipo==='periodica').reduce((a,r)=>a+r.mins,0);
      porTarea=TAREAS.map((t,ti)=>({t,m:tiempos.filter(r=>r.tarea===ti&&r.tipo==='rutinaria').reduce((a,r)=>a+r.mins,0)})).filter(x=>x.m>0);
      porCierre=ej&&ej.tareascierre?ej.tareascierre.map((tc,ci)=>({t:tc.nombre,m:tiempos.filter(r=>r.tarea===ci&&r.tipo==='cierre').reduce((a,r)=>a+r.mins,0)})).filter(x=>x.m>0):[];
    }
    return{emp,ei,totalM,rut,cie,per,porTarea,porCierre,ej};
  }).filter(x=>x.totalM>0&&(filtroEmp==='todos'||x.ei===parseInt(filtroEmp)));
  if(sort==='total')emps.sort((a,b)=>b.totalM-a.totalM);
  else if(sort==='nombre')emps.sort((a,b)=>a.emp.localeCompare(b.emp));
  const grid=document.getElementById('tiempo-grid');grid.innerHTML='';
  if(!emps.length){grid.innerHTML='<div style="color:var(--gray);font-size:13px">Sin registros de tiempo.</div>';return;}
  emps.forEach(({emp,ei,totalM,rut,cie,per,porTarea,porCierre,ej})=>{
    const card=document.createElement('div');card.className='tiempo-card';
    const ejIdx=ej?data.ejercicios.indexOf(ej):-1;
    const sublabel=sort==='ejercicio'&&ej?`Ejercicio: ${ej.numero}`:yr;
    const tareasHtml=porTarea.map(x=>`<div class="stat-row"><span>${x.t}</span><span class="stat-val">${fmtMin(x.m)}</span></div>`).join('');
    const cierreHtml=porCierre.map(x=>`<div class="stat-row"><span style="color:var(--purple)">${x.t}</span><span class="stat-val" style="color:var(--purple)">${fmtMin(x.m)}</span></div>`).join('');
    card.innerHTML=`
      <div class="tiempo-card-header">
        <div><div class="tiempo-emp-name">${emp}</div><div style="font-size:11px;color:var(--gray);margin-top:2px">${sublabel}</div></div>
        <span class="tiempo-total-badge">${fmtMin(totalM)}</span>
      </div>
      <div class="tiempo-sub">
        <div class="tiempo-sub-item"><div class="tiempo-sub-label">Rutinarias</div><div class="tiempo-sub-val">${fmtMin(rut)}</div></div>
        <div class="tiempo-sub-item"><div class="tiempo-sub-label">Cierre</div><div class="tiempo-sub-val" style="color:var(--purple)">${fmtMin(cie)}</div></div>
        ${per?`<div class="tiempo-sub-item"><div class="tiempo-sub-label">Periodicas</div><div class="tiempo-sub-val" style="color:var(--orange)">${fmtMin(per)}</div></div>`:''}
      </div>
      ${tareasHtml||cierreHtml?`<div style="border-top:0.5px solid var(--border);padding-top:.5rem">${tareasHtml}${cierreHtml?`<div style="font-size:10px;font-weight:700;color:var(--purple);text-transform:uppercase;padding:4px 0 2px">Tareas de cierre</div>${cierreHtml}`:''}</div>`:''}
      <div style="margin-top:.5rem;display:flex;gap:6px;flex-wrap:wrap">
        <button class="btn-ghost btn-sm" onclick="openTrabajo(${ei},${MES_ACTUAL},${yr})" style="font-size:11px"><i class="ti ti-pencil"></i> Cargar trabajo</button>
        ${ejIdx>=0?`<button class="btn-ghost btn-sm" onclick="generarPDF(${ejIdx})" style="font-size:11px;color:var(--red)"><i class="ti ti-file-type-pdf"></i> PDF</button>`:''}
      </div>`;
    grid.appendChild(card);
  });
}

// ═══ RESUMEN ANUAL ═══
// ═══ PENDIENTES (atrasado / este mes, cruzando todas las empresas) ═══
function renderPendientes(){
  const atrasado=[],esteMes=[];
  const mesAct=MES_ACTUAL,anioAct=ANO_ACTUAL;
  EMPRESAS.forEach((emp,ei)=>{
    tareasDeEmpresa(ei).forEach(ti=>{
      for(let m=0;m<mesAct;m++){
        const est=getE(m,ei,ti,anioAct);
        if(est==='Pendiente'||est==='Esperando Cliente')atrasado.push({emp,ei,texto:`${TAREAS[ti]} — ${MESES[m]}`,tipo:'rutinaria',estado:est,mes:m,anio:anioAct});
      }
      const estM=getE(mesAct,ei,ti,anioAct);
      if(estM==='Pendiente'||estM==='Esperando Cliente')esteMes.push({emp,ei,texto:`${TAREAS[ti]} — ${MESES[mesAct]}`,tipo:'rutinaria',estado:estM,mes:mesAct,anio:anioAct});
    });
  });
  data.ejercicios.forEach((ej,idx)=>{
    if(ej.cerrado)return;
    const d=diasRestantes(ej.cierre);
    if(d!==null){
      const item={emp:EMPRESAS[ej.emp],ei:ej.emp,texto:`Cierre ${ej.numero}`,tipo:'ejercicio',dias:d,ejIdx:idx};
      if(d<0)atrasado.push(item);else if(d<=31)esteMes.push(item);
    }
    (ej.tareascierre||[]).forEach((tc,ci)=>{
      const est=getCierreE(idx,ci);
      if(est==='Pendiente'||est==='Esperando Cliente'){
        const item={emp:EMPRESAS[ej.emp],ei:ej.emp,texto:`${tc.nombre} (${ej.numero})`,tipo:'cierre',estado:est,dias:d,mes:mesAct,anio:anioAct};
        if(d!==null&&d<0)atrasado.push(item);else esteMes.push(item);
      }
    });
  });
  data.periodicas.forEach(p=>{
    if(p.estado==='Hecho'||p.estado==='No Corresponde')return;
    const d=diasRestantes(p.vencimiento);
    if(d===null)return;
    const item={emp:EMPRESAS[p.emp],ei:p.emp,texto:p.nombre,tipo:'periodica',estado:p.estado,dias:d};
    if(d<0)atrasado.push(item);else if(d<=31)esteMes.push(item);
  });
  const enEspera=[...atrasado,...esteMes].filter(x=>x.estado==='Esperando Cliente').length;
  document.getElementById('kpi-pendientes').innerHTML=`
    <div class="kpi"><div class="kpi-label">Atrasado</div><div class="kpi-val" style="color:var(--red)">${atrasado.length}</div></div>
    <div class="kpi"><div class="kpi-label">Este mes (${MESES[mesAct]})</div><div class="kpi-val" style="color:var(--accent)">${esteMes.length}</div></div>
    <div class="kpi"><div class="kpi-label">Esperando al cliente</div><div class="kpi-val" style="color:#9F7AEA">${enEspera}</div></div>
  `;
  document.getElementById('pend-mes-titulo').textContent=`Este mes (${MESES[mesAct]} ${anioAct})`;
  const renderList=(list,elId,esAtrasado)=>{
    const el=document.getElementById(elId);el.innerHTML='';
    if(!list.length){el.innerHTML='<div style="font-size:12px;color:#A0AEC0;padding:.5rem 0">Nada por aca 🎉</div>';return;}
    list.sort((a,b)=>(a.dias??0)-(b.dias??0));
    list.forEach(it=>{
      const badgeTipo=it.tipo==='ejercicio'?'pb-ejercicio':it.tipo==='cierre'?'pb-cierre':it.tipo==='periodica'?'pb-periodica':'pb-rutinaria';
      const tipoLbl=it.tipo==='ejercicio'?'EJERCICIO':it.tipo==='periodica'?'PERIODICA':it.tipo==='cierre'?'CIERRE':'RUTINARIA';
      const diasTxt=it.dias!==undefined&&it.dias!==null?(it.dias<0?`Vencido ${Math.abs(it.dias)}d`:it.dias===0?'Hoy':`En ${it.dias}d`):'';
      const esperaTxt=it.estado==='Esperando Cliente'?`<span class="pend-badge pb-espera">Espera cliente</span>`:'';
      const div=document.createElement('div');
      div.className='pend-item'+(esAtrasado?' pi-atrasado':'')+(it.estado==='Esperando Cliente'?' pi-espera':'');
      div.innerHTML=`<div style="flex:1"><div class="pend-emp">${it.emp}</div><div class="pend-detalle">${it.texto}${diasTxt?' · '+diasTxt:''}</div></div><span class="pend-badge ${badgeTipo}">${tipoLbl}</span>${esperaTxt}`;
      div.onclick=()=>{
        if(it.tipo==='ejercicio'){showPanel('ejercicios',document.querySelectorAll('.tab')[2]);}
        else{openTrabajo(it.ei,it.mes!==undefined?it.mes:MES_ACTUAL,it.anio||ANO_ACTUAL);}
      };
      el.appendChild(div);
    });
  };
  renderList(atrasado,'pend-atrasado',true);
  renderList(esteMes,'pend-mes',false);
}

// ═══ PLANIFICACION (tiempo por empresa y tarea, promedios historicos, hoja de trabajo en PDF) ═══
function buildPlanMesSel(){
  const s=document.getElementById('plan-mes-sel');if(!s)return;s.innerHTML='';
  MESES.forEach((m,i)=>{const o=document.createElement('option');o.value=i;o.textContent=m;s.appendChild(o);});
  s.value=MES_ACTUAL;
}
// promedio historico de una tarea, juntando todas las empresas/meses/anios (una muestra por mes trabajado, no por registro individual)
function historicoPorTarea(){
  const acc={};
  TAREAS.forEach((_,ti)=>acc[ti]={sum:0,grupos:new Set()});
  getYears().forEach(yr=>{
    (getYD(yr).tiempos||[]).forEach(r=>{
      if(r.tipo!=='rutinaria'||!acc[r.tarea])return;
      acc[r.tarea].sum+=r.mins;
      acc[r.tarea].grupos.add(`${r.emp}_${r.mes}_${yr}`);
    });
  });
  const res={};
  TAREAS.forEach((_,ti)=>{const n=acc[ti].grupos.size;res[ti]={promedio:n?Math.round(acc[ti].sum/n):null,n};});
  return res;
}
// promedio historico de una tarea puntual para UNA empresa (para la hoja de trabajo)
function historicoEmpTarea(empIdx,tareaIdx){
  let sum=0;const grupos=new Set();
  getYears().forEach(yr=>{
    (getYD(yr).tiempos||[]).forEach(r=>{
      if(r.tipo!=='rutinaria'||r.emp!==empIdx||r.tarea!==tareaIdx)return;
      sum+=r.mins;grupos.add(`${r.mes}_${yr}`);
    });
  });
  const n=grupos.size;
  return n?Math.round(sum/n):null;
}
function renderPlanificacion(){
  const mesSel=document.getElementById('plan-mes-sel');
  const mes=parseInt(mesSel.value);
  document.getElementById('plan-mes-lbl').textContent=`${MESES[mes]} ${activeYear}`;
  // promedios historicos por tarea
  const hist=historicoPorTarea();
  const kpiEl=document.getElementById('plan-promedios');kpiEl.innerHTML='';
  TAREAS.forEach((t,ti)=>{
    const h=hist[ti];
    kpiEl.innerHTML+=`<div class="kpi"><div class="kpi-label">${t}</div><div class="kpi-val" style="font-size:16px">${h.promedio!==null?fmtMin(h.promedio):'--'}</div><div class="kpi-sub">${h.n} mes(es) con datos</div></div>`;
  });
  // tabla empresa x tarea
  const tabla=document.getElementById('plan-tabla');
  const thead=`<thead><tr><th>Empresa</th>${TAREAS.map(t=>`<th>${t}</th>`).join('')}<th>Total</th></tr></thead>`;
  const totalesCol=TAREAS.map(()=>0);
  let totalGeneral=0,cuerpo='';
  EMPRESAS.forEach((emp,ei)=>{
    const activos=tareasDeEmpresa(ei);
    let totalFila=0,celdas='';
    TAREAS.forEach((_,ti)=>{
      if(!activos.includes(ti)){celdas+='<td class="pt-na">—</td>';return;}
      const mins=tiemposYr(activeYear).filter(r=>r.emp===ei&&r.mes===mes&&r.tarea===ti&&r.tipo==='rutinaria').reduce((a,r)=>a+r.mins,0);
      totalFila+=mins;totalesCol[ti]+=mins;
      celdas+=mins?`<td class="pt-val">${fmtMin(mins)}</td>`:'<td class="pt-empty">--</td>';
    });
    totalGeneral+=totalFila;
    cuerpo+=`<tr><td class="pt-emp">${emp}</td>${celdas}<td class="pt-val" style="color:var(--accent)">${totalFila?fmtMin(totalFila):'--'}</td></tr>`;
  });
  cuerpo+=`<tr class="pt-total-row"><td class="pt-emp">TOTAL</td>${totalesCol.map(m=>`<td class="pt-val">${m?fmtMin(m):'--'}</td>`).join('')}<td class="pt-val">${totalGeneral?fmtMin(totalGeneral):'--'}</td></tr>`;
  tabla.innerHTML=thead+'<tbody>'+cuerpo+'</tbody>';
  renderPlanControl();
}

// ═══ CONTROL DE TAREAS POR EJERCICIO (vista tipo semaforo, todo el ejercicio de un vistazo) ═══
function buildPlanEmpSel(){
  const s=document.getElementById('plan-emp-sel');if(!s)return;
  const prev=s.value;
  s.innerHTML='';
  EMPRESAS.forEach((e,i)=>{const o=document.createElement('option');o.value=i;o.textContent=e;s.appendChild(o);});
  s.value=prev&&EMPRESAS[prev]?prev:0;
}
function celdaEstado(est){
  const map={
    'Hecho':{cls:'pc-hecho',lbl:'✓'},
    'Pendiente':{cls:'pc-pendiente',lbl:'!'},
    'Esperando Cliente':{cls:'pc-espera',lbl:'⏳'},
    'No Corresponde':{cls:'pc-nc',lbl:'—'}
  };
  const m=map[est];
  if(!m)return '<td class="pc-vacio" title="Sin registrar"></td>';
  return `<td class="${m.cls}" title="${est}">${m.lbl}</td>`;
}
function renderPlanControl(){
  buildPlanEmpSel();
  const empIdx=parseInt(document.getElementById('plan-emp-sel').value);
  const ej=ejActivoDeEmpresa(empIdx);
  const wrap=document.getElementById('plan-control-wrap');
  if(!ej){
    document.getElementById('plan-control-lbl').textContent='';
    wrap.innerHTML='<div style="font-size:12px;color:#A0AEC0;padding:1rem">Esta empresa no tiene un ejercicio abierto.</div>';
    return;
  }
  const mesesEj=getMesesEj(ej)||[];
  const idxTareas=tareasDeEmpresa(empIdx);
  document.getElementById('plan-control-lbl').textContent=`${EMPRESAS[empIdx]} · Ejercicio ${ej.numero} (${fmtDate(ej.inicio)} → ${fmtDate(ej.cierre)})`;
  const anioBase=mesesEj.length?mesesEj[0].anio:null;
  const thead=`<thead><tr><th>Tarea</th>${mesesEj.map(({mes,anio})=>`<th>${MESES[mes].slice(0,3)}${anio!==anioBase?" '"+String(anio).slice(2):''}</th>`).join('')}</tr></thead>`;
  let cuerpo='';
  idxTareas.forEach(ti=>{
    const celdas=mesesEj.map(({mes,anio})=>celdaEstado(getE(mes,empIdx,ti,anio))).join('');
    cuerpo+=`<tr><td class="pc-tarea">${TAREAS[ti]}</td>${celdas}</tr>`;
  });
  if(ej.tareascierre&&ej.tareascierre.length){
    const ultimoIdx=mesesEj.length-1;
    ej.tareascierre.forEach((tc,ci)=>{
      const est=getCierreE(ej._idx,ci);
      const celdas=mesesEj.map((_,i)=>i===ultimoIdx?celdaEstado(est):'<td class="pc-na"></td>').join('');
      cuerpo+=`<tr><td class="pc-tarea pc-tarea-cierre">${tc.nombre} <span class="tarea-type tt-cierre">CIERRE</span></td>${celdas}</tr>`;
    });
  }
  wrap.innerHTML=`<table id="plan-control-tabla">${thead}<tbody>${cuerpo}</tbody></table>`;
}

// ═══ HOJA DE TRABAJO EN PDF (para delegar tareas a una persona) ═══
function openHojaTrabajoModal(){
  const list=document.getElementById('hoja-trabajo-list');list.innerHTML='';
  EMPRESAS.forEach((e,i)=>{
    const row=document.createElement('label');row.className='cfg-row';row.style.cursor='pointer';
    row.innerHTML=`<input type="checkbox" data-idx="${i}" style="margin-right:4px"> <span style="flex:1">${e}</span>`;
    list.appendChild(row);
  });
  document.getElementById('modal-hoja-trabajo').classList.add('open');
}
function closeHojaTrabajoModal(){document.getElementById('modal-hoja-trabajo').classList.remove('open');}
function marcarTodasHojaTrabajo(valor){
  document.querySelectorAll('#hoja-trabajo-list input[type=checkbox]').forEach(c=>c.checked=valor);
}
function generarHojaTrabajo(){
  const elegidas=[...document.querySelectorAll('#hoja-trabajo-list input[type=checkbox]')].filter(c=>c.checked).map(c=>parseInt(c.dataset.idx));
  if(!elegidas.length){toast('Elegi al menos una empresa',true);return;}
  const fechaHoy=new Date().toLocaleDateString('es-AR',{day:'2-digit',month:'2-digit',year:'numeric'});
  let bloques='';
  elegidas.forEach(ei=>{
    const activos=tareasDeEmpresa(ei);
    const filas=activos.map(ti=>{
      const prom=historicoEmpTarea(ei,ti);
      return `<tr><td style="width:22px"><div style="width:14px;height:14px;border:1.5px solid #718096;border-radius:3px"></div></td><td>${TAREAS[ti]}</td><td style="text-align:right;font-weight:600">${prom!==null?fmtMin(prom):'sin datos previos'}</td><td style="width:35%"></td></tr>`;
    }).join('');
    bloques+=`
    <div style="margin-bottom:22px;page-break-inside:avoid">
      <div style="font-size:14px;font-weight:700;color:#1B2A4A;border-bottom:2px solid #1B2A4A;padding-bottom:4px;margin-bottom:6px">${EMPRESAS[ei]}</div>
      <table style="width:100%;border-collapse:collapse;font-size:11px">
        <thead><tr style="background:#EDF2F7"><th style="padding:5px;text-align:left;width:22px"></th><th style="padding:5px;text-align:left">Tarea</th><th style="padding:5px;text-align:right">Tiempo estimado</th><th style="padding:5px;text-align:left">Notas</th></tr></thead>
        <tbody>${filas}</tbody>
      </table>
    </div>`;
  });
  const html=`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Hoja de trabajo</title>
  <style>body{font-family:Arial,sans-serif;color:#1a202c;margin:0;padding:24px}.logo{font-size:20px;font-weight:700;color:#1B2A4A}.logo span{color:#4299E1}.header{border-bottom:2px solid #1B2A4A;padding-bottom:10px;margin-bottom:20px;display:flex;justify-content:space-between;align-items:flex-end}td,th{border-bottom:1px solid #E2E8F0}.footer{margin-top:20px;font-size:10px;color:#A0AEC0;text-align:center}@media print{body{padding:10px}}</style></head><body>
  <div class="header"><div><div class="logo">Grupo <span>Pressacco</span></div><div style="font-size:10px;color:#718096">Estudio Contable</div></div><div style="text-align:right"><div style="font-weight:700">Hoja de trabajo</div><div style="font-size:11px;color:#718096">Generado el ${fechaHoy}</div></div></div>
  ${bloques}
  <div class="footer">El tiempo estimado es un promedio historico de lo que llevo esta tarea en esta empresa. Puede variar segun el mes.</div>
  <script>window.onload=()=>window.print();<\/script></body></html>`;
  const blob=new Blob([html],{type:'text/html'});const url=URL.createObjectURL(blob);window.open(url,'_blank');setTimeout(()=>URL.revokeObjectURL(url),10000);
  closeHojaTrabajoModal();
  toast(`Hoja generada para ${elegidas.length} empresa(s)`);
}

function renderAnual(){
  document.getElementById('anual-yr').textContent=activeYear;
  let totalH=0,totalP=0;for(let m=0;m<12;m++){totalH+=countMes(m,'Hecho');totalP+=countMes(m,'Pendiente');}
  const mC=MESES.filter((_,m)=>countMes(m,'Hecho')>0||countMes(m,'Pendiente')>0).length;
  const avg=Math.round(MESES.reduce((a,_,m)=>a+pctMes(m),0)/12*100);
  const totalMins=totalMinsAll(activeYear);
  document.getElementById('kpi-anual').innerHTML=`
    <div class="kpi"><div class="kpi-label">Tareas hechas</div><div class="kpi-val" style="color:var(--green2)">${totalH}</div></div>
    <div class="kpi"><div class="kpi-label">Pendientes</div><div class="kpi-val" style="color:var(--red)">${totalP}</div></div>
    <div class="kpi"><div class="kpi-label">Meses trabajados</div><div class="kpi-val">${mC}/12</div></div>
    <div class="kpi"><div class="kpi-label">Promedio anual</div><div class="kpi-val" style="color:var(--accent)">${avg}%</div></div>
    <div class="kpi"><div class="kpi-label">Tiempo total</div><div class="kpi-val" style="color:var(--purple)">${fmtMin(totalMins)}</div></div>
  `;
  const bars=document.getElementById('anual-bars');bars.innerHTML='';
  MESES.forEach((mes,m)=>{
    const pct=pctMes(m),w=Math.round(pct*100);const has=countMes(m,'Hecho')>0||countMes(m,'Pendiente')>0;
    const esHoy=m===MES_ACTUAL&&activeYear===ANO_ACTUAL;
    bars.innerHTML+=`<div class="anual-row">
      <span class="anual-mes">${mes}${esHoy?'<span style="font-size:9px;background:var(--accent);color:white;padding:1px 5px;border-radius:99px;margin-left:4px">hoy</span>':''}</span>
      <div class="anual-bar-wrap"><div class="anual-bar" style="width:${w}%"></div></div>
      <span class="anual-pct">${w}%</span>
      <span class="ab ${has&&w>=100?'ab-ok':has&&w>0?'ab-wip':'ab-no'}">${has&&w>=100?'Completo':has&&w>0?w+'% av.':'Sin datos'}</span>
      <span style="font-size:11px;color:#A0AEC0;margin-left:6px">${fmtMin(totalMinsMesYr(m,activeYear))}</span>
    </div>`;
  });
  const empEl=document.getElementById('anual-emp');
  const empMins=EMPRESAS.map((e,i)=>({e,m:totalMinsEmpYr(i,activeYear)})).sort((a,b)=>b.m-a.m).filter(x=>x.m>0);
  empEl.innerHTML=empMins.length?empMins.map(x=>`<div class="stat-row"><span style="font-size:12px">${x.e}</span><span class="stat-val">${fmtMin(x.m)}</span></div>`).join(''):'<div style="font-size:12px;color:#A0AEC0">Sin registros</div>';
  const td=document.getElementById('anual-tareas');td.innerHTML='';
  const rutTotal=totalMinsRutinariaYr(activeYear),cieTotal=totalMinsCierreYr(activeYear),perTotal=totalMinsPeriodicaYr(activeYear);
  td.innerHTML+=`<div class="card" style="padding:.75rem;grid-column:span 2"><div style="font-size:10px;font-weight:700;color:var(--gray);text-transform:uppercase;margin-bottom:.4rem">Totales</div><div style="display:flex;gap:16px;flex-wrap:wrap"><div><div style="font-size:11px;color:var(--gray)">Rutinarias</div><div style="font-size:17px;font-weight:700;color:var(--accent)">${fmtMin(rutTotal)}</div></div><div><div style="font-size:11px;color:var(--purple)">Cierre de balance</div><div style="font-size:17px;font-weight:700;color:var(--purple)">${fmtMin(cieTotal)}</div></div><div><div style="font-size:11px;color:var(--orange)">Periodicas</div><div style="font-size:17px;font-weight:700;color:var(--orange)">${fmtMin(perTotal)}</div></div></div></div>`;
  TAREAS.forEach((tarea,ti)=>{
    const mins=totalMinsTareaYr(ti,activeYear);const hec=MESES.reduce((a,_,m)=>a+EMPRESAS.reduce((b,_,e)=>b+(getE(m,e,ti)==='Hecho'?1:0),0),0);
    td.innerHTML+=`<div class="card" style="padding:.75rem"><div style="font-size:10px;font-weight:700;color:var(--gray);text-transform:uppercase;letter-spacing:.05em;margin-bottom:.3rem">${tarea}</div><div style="font-size:15px;font-weight:700">${fmtMin(mins)}</div><div style="font-size:11px;color:var(--gray);margin-top:3px">${hec} realizadas${mins&&hec?` · ${Math.round(mins/hec)}m prom`:''}</div></div>`;
  });
}

// ═══ CONFIG ═══
function renderConfig(){
  document.getElementById('emp-count').textContent=`(${EMPRESAS.length})`;
  const el=document.getElementById('emp-list');el.innerHTML='';
  EMPRESAS.forEach((emp,i)=>{const row=document.createElement('div');row.className='cfg-row';row.innerHTML=`<span class="cfg-num">${i+1}</span><input class="cfg-inp" type="text" value="${emp.replace(/"/g,'&quot;')}" onfocus="this.style.borderColor='var(--accent)';this.style.background='white'" onblur="renombrar('empresa',this,${i})" onkeydown="if(event.key==='Enter')this.blur()"><button class="btn-ghost btn-sm" style="font-size:11px" onclick="openTareasEmpModal(${i})" title="Elegir que tareas rutinarias aplican"><i class="ti ti-list-check"></i> Tareas</button><button class="btn-danger btn-sm" onclick="eliminarEmpresa(${i})"><i class="ti ti-trash"></i></button>`;el.appendChild(row);});
  const tl=document.getElementById('tarea-list');tl.innerHTML='';
  TAREAS.forEach((t,i)=>{const row=document.createElement('div');row.className='cfg-row';row.innerHTML=`<span class="cfg-num">${i+1}</span><input class="cfg-inp" type="text" value="${t.replace(/"/g,'&quot;')}" onfocus="this.style.borderColor='var(--accent)';this.style.background='white'" onblur="renombrar('tarea',this,${i})" onkeydown="if(event.key==='Enter')this.blur()"><button class="btn-danger btn-sm" onclick="eliminarTarea(${i})"><i class="ti ti-trash"></i></button>`;tl.appendChild(row);});
  const yg=document.getElementById('year-grid');yg.innerHTML='';
  getYears().forEach(y=>{const h=Object.values(data.anos[y].tareas||{}).filter(v=>v==='Hecho').length;const div=document.createElement('div');div.className='year-card'+(y===activeYear?' ay':'');div.innerHTML=`<button class="btn-danger btn-sm" style="position:absolute;top:5px;right:5px;padding:2px 5px" onclick="event.stopPropagation();deleteYear(${y})"><i class="ti ti-trash"></i></button><div class="year-num">${y}</div><div class="year-sub">${h} hechas</div>`;div.addEventListener('click',()=>{activeYear=y;document.getElementById('year-sel').value=y;renderAll();renderConfig();});yg.appendChild(div);});
  renderPlantillas();
}
function renderPlantillas(){
  const el=document.getElementById('plantilla-list');if(!el)return;el.innerHTML='';
  if(!data.plantillasCierre.length){el.innerHTML='<div style="font-size:12px;color:#A0AEC0;padding:.6rem 1rem">No hay plantillas creadas todavia.</div>';return;}
  data.plantillasCierre.forEach((pl,i)=>{
    const row=document.createElement('div');row.className='cfg-row';
    row.innerHTML=`<span style="flex:1;font-size:13px;font-weight:600">${pl.nombre}</span><span style="font-size:11px;color:var(--gray);margin-right:6px">${pl.tareas.length} tarea(s)</span><button class="btn-ghost btn-sm" onclick="openPlantillaModal(${i})"><i class="ti ti-pencil"></i></button><button class="btn-danger btn-sm" onclick="editingPlantillaIdx=${i};deletePlantilla()"><i class="ti ti-trash"></i></button>`;
    el.appendChild(row);
  });
}
function renombrar(tipo,input,idx){
  input.style.borderColor='transparent';input.style.background='transparent';
  const val=input.value.trim();if(!val){input.value=tipo==='empresa'?EMPRESAS[idx]:TAREAS[idx];return;}
  if(tipo==='empresa'){if(EMPRESAS[idx]===val)return;EMPRESAS[idx]=val;}else{if(TAREAS[idx]===val)return;TAREAS[idx]=val;}
  markUnsaved();buildWorkEmpSel();toast('Actualizado');
}
let editingTareasEmpIdx=null;
function openTareasEmpModal(empIdx){
  editingTareasEmpIdx=empIdx;
  document.getElementById('tareasemp-emp').textContent=EMPRESAS[empIdx];
  const activas=tareasDeEmpresa(empIdx);
  const cont=document.getElementById('tareasemp-list');cont.innerHTML='';
  TAREAS.forEach((t,i)=>{
    const row=document.createElement('label');row.className='cfg-row';row.style.cursor='pointer';
    row.innerHTML=`<input type="checkbox" ${activas.includes(i)?'checked':''} data-idx="${i}" style="margin-right:4px"> <span style="flex:1">${t}</span>`;
    cont.appendChild(row);
  });
  document.getElementById('modal-tareasemp').classList.add('open');
}
function closeTareasEmpModal(){document.getElementById('modal-tareasemp').classList.remove('open');editingTareasEmpIdx=null;}
function saveTareasEmpModal(){
  const checks=document.querySelectorAll('#tareasemp-list input[type=checkbox]');
  const activas=[...checks].filter(c=>c.checked).map(c=>parseInt(c.dataset.idx));
  if(!data.tareasEmpresa)data.tareasEmpresa={};
  data.tareasEmpresa[editingTareasEmpIdx]=activas;
  markUnsaved();saveNow();closeTareasEmpModal();renderAll();toast('Tareas de la empresa actualizadas');
}
function marcarTodasTareasEmpModal(valor){
  document.querySelectorAll('#tareasemp-list input[type=checkbox]').forEach(c=>c.checked=valor);
}

// ═══ PLANTILLAS DE TAREAS DE CIERRE ═══
let editingPlantillaIdx=null;
function openPlantillaModal(idx=null){
  editingPlantillaIdx=idx;
  const pl=idx!==null?data.plantillasCierre[idx]:null;
  document.getElementById('modal-plantilla-title').textContent=idx!==null?'Editar plantilla':'Nueva plantilla';
  document.getElementById('plantilla-del-btn').style.display=idx!==null?'inline-flex':'none';
  document.getElementById('plantilla-nombre').value=pl?pl.nombre:'';
  const list=document.getElementById('plantilla-tareas-list');list.innerHTML='';
  if(pl&&pl.tareas.length)pl.tareas.forEach(t=>addPlantillaTareaRow(t.nombre));
  else addPlantillaTareaRow('');
  document.getElementById('modal-plantilla').classList.add('open');
}
function closePlantillaModal(){document.getElementById('modal-plantilla').classList.remove('open');editingPlantillaIdx=null;}
function addPlantillaTareaRow(valor=''){
  const list=document.getElementById('plantilla-tareas-list');
  const row=document.createElement('div');row.className='row-gap';row.style.marginBottom='6px';
  row.innerHTML=`<input type="text" class="plantilla-tarea-inp" value="${valor.replace(/"/g,'&quot;')}" placeholder="Ej: Ajuste por inflacion" style="flex:1;font-size:13px;padding:6px 9px;border-radius:var(--radius);border:0.5px solid var(--border);font-family:inherit"><button class="btn-ghost btn-sm" onclick="this.parentElement.remove()"><i class="ti ti-x"></i></button>`;
  list.appendChild(row);
}
function savePlantilla(){
  const nombre=document.getElementById('plantilla-nombre').value.trim();
  if(!nombre){toast('Ingresa un nombre para la plantilla',true);return;}
  const tareas=[...document.querySelectorAll('.plantilla-tarea-inp')].map(i=>i.value.trim()).filter(Boolean).map(nombre=>({nombre}));
  if(!tareas.length){toast('Agrega al menos una tarea',true);return;}
  if(editingPlantillaIdx!==null){
    data.plantillasCierre[editingPlantillaIdx].nombre=nombre;
    data.plantillasCierre[editingPlantillaIdx].tareas=tareas;
  } else {
    data.plantillasCierre.push({nombre,tareas});
  }
  markUnsaved();saveNow();closePlantillaModal();renderPlantillas();toast('Plantilla guardada');
}
function deletePlantilla(){
  if(editingPlantillaIdx===null)return;
  if(!confirm('Eliminar esta plantilla?'))return;
  data.plantillasCierre.splice(editingPlantillaIdx,1);
  markUnsaved();saveNow();closePlantillaModal();renderPlantillas();toast('Plantilla eliminada');
}
function openAplicarPlantillaModal(){
  if(workEjIdx===null){toast('Esta empresa no tiene ejercicio abierto. Agrega uno primero.',true);return;}
  if(!data.plantillasCierre.length){toast('Todavia no hay plantillas creadas. Andá a Config para crear una.',true);return;}
  document.getElementById('aplicar-plantilla-emp').textContent=`${EMPRESAS[workEmpIdx]} · ${data.ejercicios[workEjIdx].numero}`;
  const list=document.getElementById('aplicar-plantilla-list');list.innerHTML='';
  data.plantillasCierre.forEach((pl,i)=>{
    const row=document.createElement('div');row.className='cfg-row';
    row.innerHTML=`<span style="flex:1;font-size:13px;font-weight:600">${pl.nombre}</span><span style="font-size:11px;color:var(--gray);margin-right:6px">${pl.tareas.length} tarea(s)</span><button class="btn-primary btn-sm" onclick="aplicarPlantilla(${i})">Aplicar</button>`;
    list.appendChild(row);
  });
  document.getElementById('modal-aplicar-plantilla').classList.add('open');
}
function closeAplicarPlantillaModal(){document.getElementById('modal-aplicar-plantilla').classList.remove('open');}
function aplicarPlantilla(idx){
  const pl=data.plantillasCierre[idx];
  const ej=data.ejercicios[workEjIdx];
  if(!ej.tareascierre)ej.tareascierre=[];
  const existentes=ej.tareascierre.map(t=>t.nombre.toLowerCase());
  let agregadas=0;
  pl.tareas.forEach(t=>{
    if(!existentes.includes(t.nombre.toLowerCase())){ej.tareascierre.push({nombre:t.nombre,desc:''});agregadas++;}
  });
  markUnsaved();saveNow();closeAplicarPlantillaModal();renderTrabajoContent();
  toast(agregadas?`Se agregaron ${agregadas} tarea(s) de la plantilla`:'Esas tareas ya estaban cargadas');
}
function addEmpresa(){const inp=document.getElementById('new-emp'),val=inp.value.trim();if(!val){toast('Escribe un nombre',true);return;}EMPRESAS.push(val);markUnsaved();inp.value='';renderConfig();buildWorkEmpSel();toast(`"${val}" agregada`);}
function eliminarEmpresa(i){
  if(!confirm(`Eliminar "${EMPRESAS[i]}"?`))return;const n=EMPRESAS[i];EMPRESAS.splice(i,1);
  Object.keys(data.anos).forEach(y=>{const a=data.anos[y];const nt={};Object.entries(a.tareas||{}).forEach(([k,v])=>{const[m,e,t]=k.split('_').map(Number);if(e===i)return;nt[`${m}_${e>i?e-1:e}_${t}`]=v;});a.tareas=nt;a.tiempos=(a.tiempos||[]).filter(r=>r.emp!==i).map(r=>({...r,emp:r.emp>i?r.emp-1:r.emp}));});
  data.ejercicios=data.ejercicios.filter(e=>e.emp!==i).map(e=>({...e,emp:e.emp>i?e.emp-1:e.emp}));
  data.periodicas=data.periodicas.filter(p=>p.emp!==i).map(p=>({...p,emp:p.emp>i?p.emp-1:p.emp}));
  const nte={};Object.entries(data.tareasEmpresa||{}).forEach(([k,v])=>{const e=Number(k);if(e===i)return;nte[e>i?e-1:e]=v;});data.tareasEmpresa=nte;
  markUnsaved();saveNow();renderConfig();buildWorkEmpSel();toast(`"${n}" eliminada`);
}
function openNuevaTareaModal(){
  document.getElementById('nuevatarea-nombre').value='';
  document.getElementById('nuevatarea-alcance').value='todas';
  const list=document.getElementById('nuevatarea-empresas-list');list.innerHTML='';
  EMPRESAS.forEach((e,i)=>{
    const row=document.createElement('label');row.className='cfg-row';row.style.cursor='pointer';
    row.innerHTML=`<input type="checkbox" data-idx="${i}" style="margin-right:4px"> <span style="flex:1">${e}</span>`;
    list.appendChild(row);
  });
  toggleNuevaTareaEmpresas();
  document.getElementById('modal-nueva-tarea').classList.add('open');
}
function closeNuevaTareaModal(){document.getElementById('modal-nueva-tarea').classList.remove('open');}
function toggleNuevaTareaEmpresas(){
  const esp=document.getElementById('nuevatarea-alcance').value==='especificas';
  document.getElementById('nuevatarea-empresas-wrap').style.display=esp?'block':'none';
}
function marcarTodasNuevaTareaEmp(valor){
  document.querySelectorAll('#nuevatarea-empresas-list input[type=checkbox]').forEach(c=>c.checked=valor);
}
function saveNuevaTarea(){
  const nombre=document.getElementById('nuevatarea-nombre').value.trim();
  if(!nombre){toast('Escribe un nombre',true);return;}
  const alcance=document.getElementById('nuevatarea-alcance').value;
  let elegidas=null;
  if(alcance==='especificas'){
    elegidas=[...document.querySelectorAll('#nuevatarea-empresas-list input[type=checkbox]')].filter(c=>c.checked).map(c=>parseInt(c.dataset.idx));
    if(!elegidas.length){toast('Elegi al menos una empresa',true);return;}
  }
  if(!data.tareasEmpresa)data.tareasEmpresa={};
  // materializar la lista de cada empresa ANTES de agregar la tarea nueva, para que
  // las que no fueron elegidas no la reciban por defecto
  EMPRESAS.forEach((_,e)=>{ if(!data.tareasEmpresa[e]) data.tareasEmpresa[e]=TAREAS.map((_,i)=>i); });
  const newIdx=TAREAS.length;
  TAREAS.push(nombre);
  if(alcance==='todas'){
    EMPRESAS.forEach((_,e)=>{ data.tareasEmpresa[e].push(newIdx); });
  } else {
    elegidas.forEach(e=>{ data.tareasEmpresa[e].push(newIdx); });
  }
  markUnsaved();saveNow();closeNuevaTareaModal();renderConfig();buildWorkEmpSel();
  toast(alcance==='todas'?`"${nombre}" agregada para todas las empresas`:`"${nombre}" agregada solo para ${elegidas.length} empresa(s)`);
}
function eliminarTarea(i){
  if(!confirm(`Eliminar "${TAREAS[i]}"?`))return;const n=TAREAS[i];TAREAS.splice(i,1);
  Object.keys(data.anos).forEach(y=>{const a=data.anos[y];const nt={};Object.entries(a.tareas||{}).forEach(([k,v])=>{const[m,e,t]=k.split('_').map(Number);if(t===i)return;nt[`${m}_${e}_${t>i?t-1:t}`]=v;});a.tareas=nt;a.tiempos=(a.tiempos||[]).filter(r=>!(r.tipo==='rutinaria'&&r.tarea===i)).map(r=>r.tipo==='rutinaria'&&r.tarea>i?{...r,tarea:r.tarea-1}:r);});
  Object.entries(data.tareasEmpresa||{}).forEach(([e,lista])=>{data.tareasEmpresa[e]=lista.filter(t=>t!==i).map(t=>t>i?t-1:t);});
  markUnsaved();saveNow();renderConfig();toast(`"${n}" eliminada`);
}

// ═══ GENERAR PDF ═══
function generarPDF(ejIdx){
  const ej=data.ejercicios[ejIdx];if(!ej){toast('Ejercicio no encontrado',true);return;}
  const empNombre=EMPRESAS[ej.emp]||'Empresa';
  const mesesEj=getMesesEj(ej)||[];
  const minsEj=totalMinsEjercicio(ej);
  const tiemposTareas=TAREAS.map((t,ti)=>{
    const mins=mesesEj.reduce((acc,{mes,anio})=>acc+tiemposYr(anio).filter(r=>r.emp===ej.emp&&r.mes===mes&&r.tarea===ti&&r.tipo!=='cierre').reduce((a,r)=>a+r.mins,0),0);
    const estados=mesesEj.map(({mes,anio})=>getE(mes,ej.emp,ti,anio)).filter(Boolean);
    const estado=estados.includes('Hecho')?'Hecho':estados.includes('Pendiente')?'Pendiente':estados[0]||'—';
    return{nombre:t,mins,estado};
  });
  const tiemposCierre=(ej.tareascierre||[]).map((tc,ci)=>{
    const mins=mesesEj.reduce((acc,{mes,anio})=>acc+tiemposYr(anio).filter(r=>r.emp===ej.emp&&r.mes===mes&&r.tarea===ci&&r.tipo==='cierre').reduce((a,r)=>a+r.mins,0),0);
    return{nombre:tc.nombre,mins,estado:getCierreE(ejIdx,ci)||'—'};
  });
  const fechaHoy=new Date().toLocaleDateString('es-AR',{day:'2-digit',month:'2-digit',year:'numeric'});
  const filaRut=tiemposTareas.map(t=>`<tr><td>${t.nombre}</td><td style="text-align:center">${t.estado==='Hecho'?'✅':t.estado==='No Corresponde'?'—':t.estado}</td><td style="text-align:right;font-weight:600">${fmtMin(t.mins)||'--'}</td></tr>`).join('');
  const filaCierre=tiemposCierre.map(t=>`<tr style="background:#f9f0ff"><td>${t.nombre}</td><td style="text-align:center">${t.estado==='Hecho'?'✅':t.estado==='No Corresponde'?'—':t.estado}</td><td style="text-align:right;font-weight:600">${fmtMin(t.mins)||'--'}</td></tr>`).join('');
  const avanceMeses=mesesEj.map(({mes,anio})=>{const pct=Math.round(pctEmpMesYr(mes,ej.emp,anio)*100);const mins=tiemposYr(anio).filter(r=>r.emp===ej.emp&&r.mes===mes).reduce((a,r)=>a+r.mins,0);return`<tr><td>${MESES[mes]} ${anio}</td><td style="text-align:center">${pct}%</td><td style="text-align:right">${fmtMin(mins)||'--'}</td></tr>`;}).join('');
  const estadoBadge=ej.cerrado?'<span style="background:#EDF2F7;color:#718096;padding:2px 10px;border-radius:99px;font-size:11px">🔒 Cerrado</span>':'<span style="background:#C6F6D5;color:#276749;padding:2px 10px;border-radius:99px;font-size:11px">📂 Abierto</span>';
  const html=`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Informe ${empNombre}</title>
  <style>body{font-family:Arial,sans-serif;font-size:12px;color:#1a202c;margin:0;padding:20px}.logo{font-size:22px;font-weight:700;color:#1B2A4A;letter-spacing:-.5px}.logo span{color:#4299E1}.header{border-bottom:2px solid #1B2A4A;padding-bottom:12px;margin-bottom:18px;display:flex;justify-content:space-between;align-items:flex-end}.titulo{font-size:16px;font-weight:700;color:#1B2A4A;margin-bottom:2px}.subtitulo{font-size:11px;color:#718096}.kpis{display:flex;gap:12px;margin-bottom:18px}.kpi{flex:1;border:1px solid #E2E8F0;border-radius:8px;padding:10px 14px;text-align:center}.kpi-lbl{font-size:9px;text-transform:uppercase;color:#718096;font-weight:700;letter-spacing:.05em}.kpi-v{font-size:20px;font-weight:700;color:#1B2A4A;margin-top:2px}table{width:100%;border-collapse:collapse;margin-bottom:18px}th{background:#1B2A4A;color:white;padding:7px 10px;text-align:left;font-size:11px}td{padding:6px 10px;border-bottom:1px solid #E2E8F0;font-size:11px}tr:last-child td{border-bottom:none}.sec-title{font-size:12px;font-weight:700;color:#1B2A4A;margin:16px 0 6px;text-transform:uppercase;letter-spacing:.05em;border-left:3px solid #4299E1;padding-left:8px}.footer{margin-top:24px;border-top:1px solid #E2E8F0;padding-top:8px;font-size:10px;color:#A0AEC0;text-align:center}@media print{body{padding:10px}}</style></head><body>
  <div class="header"><div><div class="logo">Grupo <span>Pressacco</span></div><div style="font-size:10px;color:#718096;margin-top:2px">Estudio Contable</div></div>
  <div style="text-align:right"><div class="titulo">${empNombre} &nbsp; ${estadoBadge}</div><div class="subtitulo">${ej.numero}</div><div class="subtitulo">Inicio: ${fmtDate(ej.inicio)} — Cierre: ${fmtDate(ej.cierre)}</div></div></div>
  <div class="kpis">
    <div class="kpi"><div class="kpi-lbl">Tiempo total ejercicio</div><div class="kpi-v">${fmtMin(minsEj)||'--'}</div></div>
    <div class="kpi"><div class="kpi-lbl">Meses del ejercicio</div><div class="kpi-v">${mesesEj.length}</div></div>
    <div class="kpi"><div class="kpi-lbl">Tareas de cierre</div><div class="kpi-v">${(ej.tareascierre||[]).length}</div></div>
    <div class="kpi"><div class="kpi-lbl">Fecha de informe</div><div class="kpi-v" style="font-size:13px">${fechaHoy}</div></div>
  </div>
  <div class="sec-title">Tareas rutinarias</div>
  <table><thead><tr><th>Tarea</th><th style="text-align:center">Estado</th><th style="text-align:right">Tiempo total ejercicio</th></tr></thead><tbody>${filaRut}</tbody></table>
  ${tiemposCierre.length?`<div class="sec-title">Tareas de cierre de balance</div><table><thead><tr><th>Tarea</th><th style="text-align:center">Estado</th><th style="text-align:right">Tiempo total</th></tr></thead><tbody>${filaCierre}</tbody></table>`:''}
  <div class="sec-title">Detalle por mes</div>
  <table><thead><tr><th>Mes</th><th style="text-align:center">Avance</th><th style="text-align:right">Tiempo</th></tr></thead><tbody>${avanceMeses}</tbody></table>
  ${ej.obs?`<div class="sec-title">Observaciones</div><p style="font-size:11px;color:#4A5568;font-style:italic">${ej.obs}</p>`:''}
  <div class="footer">Generado el ${fechaHoy} · Grupo Pressacco — Estudio Contable · Uso interno</div>
  <script>window.onload=()=>window.print();<\/script></body></html>`;
  const blob=new Blob([html],{type:'text/html'});const url=URL.createObjectURL(blob);window.open(url,'_blank');setTimeout(()=>URL.revokeObjectURL(url),10000);toast(`PDF generado para ${empNombre}`);
}

// ═══ NAVEGACION ═══
function renderAll(){
  if(activePanel==='dashboard')renderDashboard();
  else if(activePanel==='trabajo')renderTrabajo();
  else if(activePanel==='ejercicios')renderEjercicios();
  else if(activePanel==='tiempos')renderTiempos();
  else if(activePanel==='anual')renderAnual();
  else if(activePanel==='planificacion')renderPlanificacion();
  else if(activePanel==='pendientes')renderPendientes();
  else if(activePanel==='config')renderConfig();
}
function showPanel(name,btn){
  document.querySelectorAll('.panel').forEach(p=>{p.classList.remove('active');p.style.display='none';});
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  const target=document.getElementById('panel-'+name);
  target.classList.add('active');target.style.display='block';
  if(btn)btn.classList.add('active');
  activePanel=name;renderAll();
}
['modal-ej','modal-cierre','modal-edit-tiempo','modal-periodica','modal-tareasemp','modal-plantilla','modal-aplicar-plantilla','modal-nueva-tarea','modal-hoja-trabajo'].forEach(id=>document.getElementById(id).addEventListener('click',function(e){if(e.target===this)this.classList.remove('open');}));

// ═══ INIT ═══
function init(){buildYearSel();buildDashMesSel();buildWorkEmpSel();buildTiempoEmpFiltro();buildPlanMesSel();}
loadData().then(()=>{
  document.getElementById('hdate').textContent=HOY.toLocaleDateString('es-AR',{weekday:'long',year:'numeric',month:'long',day:'numeric'});
  init();renderDashboard();startAutoBackup();suscribirCambiosRemotos();
});
