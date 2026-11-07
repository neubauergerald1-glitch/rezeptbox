/* Geralds Rezeptbox – eigenständige Web-App (PWA)
 * Daten liegen lokal im Browser (IndexedDB). Beim ersten Start werden die
 * Rezepte aus data/recipes.json übernommen. Fotos werden ebenfalls lokal gespeichert.
 */
(() => {
"use strict";

/* ---------- Vokabular (wie in der ursprünglichen Rezeptbox) ---------- */
const VOCAB = {
  kueche:     {label:"Küche",       items:["Österreichisch","Italienisch","Französisch","Asiatisch","Tex-Mex","Orientalisch","Mediterran","Sonstige"]},
  ernaehrung: {label:"Ernährung",   items:["Vegetarisch","Vegan","High Protein","Low Carb","Glutenfrei","Leicht"]},
  gang:       {label:"Gang",        items:["Frühstück","Vorspeise","Suppe","Salat","Hauptgericht","Beilage","Dessert","Snack","Gebäck","Getränk"]},
  sport:      {label:"Sport & Aufwand", items:["Vor dem Training","Nach dem Training","Meal Prep","Schnell (<30 Min)","Soulfood","Regeneration"]}
};
const EXTRA = {label:"Meine", items:["Favoriten ★ 4+","Gekocht","Noch nicht gekocht","Mit Foto"]};
const SOURCES = {web:"Web",instagram:"Instagram",cookidoo:"Cookidoo",buch:"Kochbuch",eigen:"Eigenes"};
const PAGE = 60;

/* ---------- Zustand ---------- */
const S = {
  recipes:[], images:new Set(), loaded:false, q:"", sort:"new", shown:PAGE, seed:Math.random(),
  sel:{kueche:new Set(),ernaehrung:new Set(),gang:new Set(),sport:new Set(),extra:new Set()},
  openId:null, portions:null, cook:false, wakeLock:null, doneSteps:new Set()
};
const urlCache = new Map();

/* ---------- Helfer ---------- */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const total = r => r.totalMin || ((r.prepMin||0)+(r.cookMin||0)) || null;
const tagsOf = r => r.tags || {};
const uid = () => "r" + Date.now().toString(36) + Math.random().toString(36).slice(2,8);
function toast(msg){ const t=document.createElement("div"); t.className="toast"; t.textContent=msg; document.body.appendChild(t); setTimeout(()=>t.remove(),2600); }
const ls = {
  get(k,d){ try{ const v=localStorage.getItem("rb."+k); return v==null?d:JSON.parse(v); }catch(e){ return d; } },
  set(k,v){ try{ localStorage.setItem("rb."+k, JSON.stringify(v)); }catch(e){} }
};

/* ---------- IndexedDB ---------- */
const idb = (() => {
  let dbp;
  function open(){
    if(dbp) return dbp;
    dbp = new Promise((res,rej)=>{
      const r = indexedDB.open("rezeptbox", 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        db.createObjectStore("recipes", {keyPath:"id"});
        db.createObjectStore("images");
        db.createObjectStore("meta");
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function tx(store, mode, fn){
    const db = await open();
    return new Promise((res,rej)=>{
      const t = db.transaction(store, mode); const s = t.objectStore(store);
      let out; const r = fn(s); if(r && "onsuccess" in r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  }
  return {
    all:   store => tx(store,"readonly",s=>s.getAll()),
    keys:  store => tx(store,"readonly",s=>s.getAllKeys()),
    get:   (store,k) => tx(store,"readonly",s=>s.get(k)),
    put:   (store,v,k) => tx(store,"readwrite",s=>k===undefined?s.put(v):s.put(v,k)),
    del:   (store,k) => tx(store,"readwrite",s=>s.delete(k)),
    clear: store => tx(store,"readwrite",s=>s.clear()),
    putMany: (store,list) => tx(store,"readwrite",s=>{ list.forEach(v=>s.put(v)); })
  };
})();

async function load(){
  try{
    const seeded = await idb.get("meta","seeded");
    if(!seeded){
      const res = await fetch("data/recipes.json");
      if(!res.ok) throw new Error("Rezeptdaten nicht gefunden");
      const list = await res.json();
      await idb.putMany("recipes", list);
      await idb.put("meta", new Date().toISOString(), "seeded");
    }
    S.recipes = (await idb.all("recipes")).map(fixRecipe);
    S.images = new Set(await idb.keys("images"));
  }catch(e){
    console.error(e);
    $("#count").textContent = "Fehler beim Laden: " + e.message;
  }
  S.loaded = true;
  render();
}

/* Daten absichern: Themen, Zutaten und Schritte müssen Listen sein (ältere Einträge haben teils einzelne Texte). */
function asList(v){ return Array.isArray(v) ? v.filter(x=>x!=null&&x!=="").map(String) : (v==null||v==="") ? [] : [String(v)]; }
function fixRecipe(r){
  const t = (r.tags && typeof r.tags==="object") ? r.tags : {};
  r.tags = {}; for(const g of Object.keys(VOCAB)) r.tags[g] = asList(t[g]);
  r.ingredients = asList(r.ingredients);
  r.steps = asList(r.steps);
  if(r.source && typeof r.source!=="object") r.source = {type:"web", url:String(r.source)};
  return r;
}
async function saveRecipe(r){
  r.updatedAt = new Date().toISOString();
  await idb.put("recipes", r);
  const i = S.recipes.findIndex(x=>x.id===r.id);
  if(i>=0) S.recipes[i]=r; else S.recipes.push(r);
}
async function patch(id, data){
  const r = S.recipes.find(x=>x.id===id); if(!r) return;
  Object.assign(r, data);
  try{ await saveRecipe(r); }catch(e){ toast("Speichern fehlgeschlagen"); }
  render();
}
async function setImage(id, blob){
  if(blob){ await idb.put("images", blob, id); S.images.add(id); }
  else { await idb.del("images", id); S.images.delete(id); }
  if(urlCache.has(id)){ URL.revokeObjectURL(urlCache.get(id)); urlCache.delete(id); }
}
/* Foto eines Rezepts: zuerst ein eigenes (lokal gespeichertes), sonst das aus dem Repository (images/…). */
const hasPhoto = r => !!r && (S.images.has(r.id) || !!r.img);
async function imageUrl(id){
  if(S.images.has(id)){
    if(urlCache.has(id)) return urlCache.get(id);
    const b = await idb.get("images", id);
    if(b){ const u = URL.createObjectURL(b); urlCache.set(id,u); return u; }
  }
  return S.recipes.find(x=>x.id===id)?.img || "";
}

/* ---------- Automatischer Abgleich mit dem Repository ----------
 * data/recipes.json wird täglich aus der Rezeptbox auf claude.ai erzeugt.
 * Ein Rezept wird nur ersetzt, wenn es sich dort seit dem letzten Abgleich geändert hat –
 * Bewertungen/Notizen, die nur in der App geändert wurden, bleiben bis dahin erhalten.
 * In der App neu angelegte Rezepte (origin "app") werden nie gelöscht. */
function sig(r){ const s=JSON.stringify(r); let h=2166136261; for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619); } return (h>>>0).toString(36)+"."+s.length; }
function withoutLocal(r){ const {_rs, ...rest}=r; return rest; }
let syncing=false;
async function syncRemote(){
  if(syncing || !navigator.onLine || location.protocol==="file:") return;
  syncing=true;
  try{
    const res = await fetch("data/recipes.json", {cache:"no-store"});
    if(!res.ok) return;
    const remote = await res.json();
    if(!Array.isArray(remote) || !remote.length) return;
    const local = new Map(S.recipes.map(r=>[r.id,r]));
    const put=[], del=[]; let added=0, updated=0;
    const seen = new Set();
    for(const raw of remote){
      const rr = fixRecipe({...raw, id:String(raw.id)}); seen.add(rr.id);
      const h = sig(rr), l = local.get(rr.id);
      if(!l){ put.push({...rr,_rs:h}); added++; }
      else if(l._rs !== h){
        /* Noch nie abgeglichen (Startdaten oder eingespielte Exportdatei): gleich oder neuer als das Repository → behalten */
        if(l._rs===undefined && (JSON.stringify(withoutLocal(l))===JSON.stringify(rr) || (l.updatedAt||"") > (rr.updatedAt||""))) put.push({...l,_rs:h});
        else { put.push({...rr,_rs:h}); updated++; }
      }
    }
    for(const l of S.recipes){ if(!seen.has(l.id) && l._rs!==undefined && l.origin!=="app") del.push(l.id); }
    if(!put.length && !del.length) return;
    await idb.putMany("recipes", put);
    for(const id of del){ await idb.del("recipes", id); }
    S.recipes = (await idb.all("recipes")).map(fixRecipe);
    if(!S.openId) render();
    if(added||updated||del.length) toast(`Rezeptbox aktualisiert: ${[added&&added+" neu", updated&&updated+" geändert", del.length&&del.length+" entfernt"].filter(Boolean).join(", ")}`);
  }catch(e){ console.warn("Abgleich fehlgeschlagen", e); }
  finally{ syncing=false; }
}
document.addEventListener("visibilitychange",()=>{ if(document.visibilityState==="visible" && S.loaded) syncRemote(); });
function fillImages(root=document){
  root.querySelectorAll("img[data-img]").forEach(async img=>{
    const u = await imageUrl(img.dataset.img); if(u){ img.src=u; img.hidden=false; img.nextElementSibling?.classList.contains("ph") && img.nextElementSibling.remove(); }
  });
}

/* ---------- Liste & Filter ---------- */
function extraHit(r,item){
  if(item==="Gekocht") return !!r.cooked;
  if(item==="Noch nicht gekocht") return !r.cooked;
  if(item==="Mit Foto") return hasPhoto(r);
  return (r.rating||0)>=4;
}
function matches(r, skipGroup){
  const t=tagsOf(r);
  for(const g of Object.keys(VOCAB)){ if(g===skipGroup) continue; const sel=S.sel[g]; if(sel.size && !(t[g]||[]).some(x=>sel.has(x))) return false; }
  if(skipGroup!=="extra"){ for(const it of S.sel.extra){ if(!extraHit(r,it)) return false; } }
  if(S.q){
    const hay=[r.title,r.description,(r.ingredients||[]).join(" "),Object.values(t).flat().join(" "),r.notes,r.source?.book,r.source?.author].join(" ").toLowerCase();
    if(!S.q.toLowerCase().split(/\s+/).filter(Boolean).every(w=>hay.includes(w))) return false;
  }
  return true;
}
function renderFilters(){
  const groups=[...Object.entries(VOCAB),["extra",EXTRA]];
  $("#filters").innerHTML = groups.map(([g,v])=>{
    const pool=S.recipes.filter(r=>matches(r,g));
    const chips=v.items.map(it=>{
      const n = g==="extra" ? pool.filter(r=>extraHit(r,it)).length : pool.filter(r=>(tagsOf(r)[g]||[]).includes(it)).length;
      const on=S.sel[g].has(it);
      return `<button type="button" class="chip" data-g="${g}" data-v="${esc(it)}" aria-pressed="${on}">${esc(it)}<span class="n">${n}</span></button>`;
    }).join("");
    return `<div class="frow"><div class="flabel">${esc(v.label)}</div><div class="chips">${chips}</div></div>`;
  }).join("");
  const n = Object.values(S.sel).reduce((a,s)=>a+s.size,0);
  $("#filterCount").textContent = n ? `(${n})` : "";
}
function hash(s){ let h=2166136261; for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619); } return h>>>0; }
function sorted(list){
  const a=[...list];
  const by={
    new:(x,y)=>(y.createdAt||"").localeCompare(x.createdAt||""),
    rating:(x,y)=>(y.rating||0)-(x.rating||0) || (x.title||"").localeCompare(y.title||"","de"),
    time:(x,y)=>(total(x)||999)-(total(y)||999),
    protein:(x,y)=>(y.nutrition?.protein||0)-(x.nutrition?.protein||0),
    az:(x,y)=>(x.title||"").localeCompare(y.title||"","de"),
    random:(x,y)=>hash(x.id+S.seed)-hash(y.id+S.seed)
  };
  return a.sort(by[S.sort]||by.new);
}
function stars(n){ n=n||0; return n? "★".repeat(n)+"<span style='opacity:.25'>"+"★".repeat(5-n)+"</span>" : ""; }
function card(r){
  const t=tagsOf(r), tt=total(r), p=r.nutrition?.protein, hasImg=hasPhoto(r);
  const tagHtml=[...(t.kueche||[]).filter(x=>x!=="Sonstige").map(x=>`<span class="tag k">${esc(x)}</span>`),...[...(t.ernaehrung||[]),...(t.sport||[])].slice(0,3).map(x=>`<span class="tag">${esc(x)}</span>`)].join("");
  return `<button type="button" class="card" data-id="${esc(r.id)}">
    <div class="thumb">${hasImg?`<img data-img="${esc(r.id)}" alt="" hidden>`:""}<span class="ph">${esc((r.title||"?").trim()[0]||"?")}</span>
      ${r.source?.type?`<span class="src">${esc(SOURCES[r.source.type]||r.source.type)}</span>`:""}${r.cooked?`<span class="done">Gekocht</span>`:""}</div>
    <div class="cbody">
      <h2 class="ctitle">${esc(r.title||"Ohne Titel")}</h2>
      <div class="meta">${tt?`<span><b>${tt}</b> Min</span>`:""}${p?`<span><b>${Math.round(p)} g</b> Protein</span>`:""}${r.nutrition?.kcal?`<span><b>${Math.round(r.nutrition.kcal)}</b> kcal</span>`:""}${r.rating?`<span class="stars">${stars(r.rating)}</span>`:""}</div>
      <div class="tags">${tagHtml}</div>
    </div></button>`;
}
function render(){
  renderFilters();
  const any=Object.values(S.sel).some(s=>s.size)||S.q;
  $("#reset").hidden=!any;
  if(!S.loaded){ $("#count").textContent="Lade Rezepte …"; return; }
  const list=sorted(S.recipes.filter(r=>matches(r)));
  $("#count").textContent = S.recipes.length ? `${list.length} von ${S.recipes.length} Rezepten` : "Noch keine Rezepte";
  if(!S.recipes.length){
    $("#list").innerHTML=`<div class="empty"><h2>Deine Rezeptbox ist noch leer</h2><p style="max-width:52ch;margin:0">Füge ein Rezept hinzu oder spiele eine Sicherung in den Einstellungen ein.</p><button class="btn primary" type="button" data-act="add">Erstes Rezept hinzufügen</button></div>`;
  } else if(!list.length){
    $("#list").innerHTML=`<div class="empty"><h2>Nichts gefunden</h2><p style="margin:0">Kein Rezept passt zu dieser Kombination.</p><button class="btn" type="button" data-act="reset">Filter zurücksetzen</button></div>`;
  } else {
    const vis=list.slice(0,S.shown);
    $("#list").innerHTML=`<div class="grid">${vis.map(card).join("")}</div>${list.length>vis.length?`<div class="more"><button class="btn" type="button" data-act="more">Weitere ${Math.min(PAGE,list.length-vis.length)} anzeigen</button></div>`:""}`;
    fillImages($("#list"));
  }
}
function resetFilters(){ Object.values(S.sel).forEach(s=>s.clear()); S.q=""; $("#q").value=""; S.shown=PAGE; render(); }

$("#filters").addEventListener("click",e=>{ const c=e.target.closest(".chip"); if(!c) return; const s=S.sel[c.dataset.g]; s.has(c.dataset.v)?s.delete(c.dataset.v):s.add(c.dataset.v); S.shown=PAGE; render(); });
let qTimer; $("#q").addEventListener("input",e=>{ clearTimeout(qTimer); qTimer=setTimeout(()=>{ S.q=e.target.value.trim(); S.shown=PAGE; render(); },120); });
S.sort = ls.get("sort","new"); $("#sort").value=S.sort;
$("#sort").addEventListener("change",e=>{ S.sort=e.target.value; S.seed=Math.random(); ls.set("sort",S.sort); S.shown=PAGE; render(); });
$("#filterToggle").addEventListener("click",()=>{
  const f=$("#filters"); f.hidden=!f.hidden; $("#filterToggle").setAttribute("aria-expanded", String(!f.hidden)); ls.set("filtersOpen", !f.hidden);
  if(!f.hidden) window.scrollTo({top:0, behavior:"smooth"}); /* Filterfeld sitzt oben auf der Seite – sonst öffnet es sich außer Sicht */
});
if(ls.get("filtersOpen", window.innerWidth>800)){ $("#filters").hidden=false; $("#filterToggle").setAttribute("aria-expanded","true"); }
$("#reset").addEventListener("click",resetFilters);
$("#list").addEventListener("click",e=>{
  const c=e.target.closest(".card"); if(c){ openDetail(c.dataset.id); return; }
  const a=e.target.closest("[data-act]"); if(!a) return;
  if(a.dataset.act==="add") openImport();
  if(a.dataset.act==="reset") resetFilters();
  if(a.dataset.act==="more"){ S.shown+=PAGE; render(); }
});
$("#addBtn").addEventListener("click",()=>openImport());
$("#settingsBtn").addEventListener("click",()=>openSettings());

/* ---------- Sheets ---------- */
function openSheet(html, cls=""){
  $("#layer").innerHTML=`<div class="scrim" id="scrim"><div class="sheet ${cls}" role="dialog" aria-modal="true">${html}</div></div>`;
  document.body.style.overflow="hidden";
  $("#scrim").addEventListener("click",e=>{ if(e.target.id==="scrim") closeSheet(); });
}
function closeSheet(){
  $("#layer").innerHTML=""; document.body.style.overflow=""; S.openId=null; S.cook=false; releaseWake();
  if(location.hash) history.replaceState(null,"",location.pathname+location.search);
}
document.addEventListener("keydown",e=>{ if(e.key==="Escape" && $("#layer").innerHTML) closeSheet(); });

/* ---------- Detail ---------- */
function fmtNum(v){ const out = v>=10?Math.round(v):Math.round(v*10)/10; return String(out).replace(".",","); }
function scaleLine(line, f){
  if(f===1) return esc(line);
  return esc(line).replace(/^(\s*)(\d+(?:[.,]\d+)?(?:\s*[-–]\s*\d+(?:[.,]\d+)?)?(?:\s*\/\s*\d+)?|½|¼|¾)(?=\s|[a-zA-ZäöüÄÖÜ])/, (m,sp,num)=>{
    const map={"½":.5,"¼":.25,"¾":.75};
    if(map[num]!=null) return sp+"<b>"+fmtNum(map[num]*f)+"</b>";
    const range=num.split(/\s*[-–]\s*/);
    if(range.length===2) return sp+"<b>"+fmtNum(parseFloat(range[0].replace(",","."))*f)+"–"+fmtNum(parseFloat(range[1].replace(",","."))*f)+"</b>";
    let v; if(num.includes("/")){ const [a,b]=num.split("/").map(x=>parseFloat(x)); v=a/b; } else v=parseFloat(num.replace(",","."));
    return sp+"<b>"+fmtNum(v*f)+"</b>";
  });
}
function openDetail(id){
  const r=S.recipes.find(x=>x.id===id); if(!r) return;
  S.openId=id; S.portions=r.servings||null; S.doneSteps=new Set(); S.cook=false;
  history.replaceState(null,"","#r="+encodeURIComponent(id));
  renderDetail();
}
async function requestWake(){ try{ if("wakeLock" in navigator) S.wakeLock = await navigator.wakeLock.request("screen"); }catch(e){} }
function releaseWake(){ try{ S.wakeLock?.release(); }catch(e){} S.wakeLock=null; }
document.addEventListener("visibilitychange",()=>{ if(S.cook && document.visibilityState==="visible") requestWake(); });

function renderDetail(){
  const r=S.recipes.find(x=>x.id===S.openId); if(!r) return;
  const scroll=$("#scrim")?.scrollTop||0;
  const checked = new Set($$("ul.ing input:checked").map(i=>i.id));
  const f = (r.servings && S.portions) ? S.portions/r.servings : 1;
  const n=r.nutrition||{}, t=tagsOf(r), hasImg=hasPhoto(r);
  const ing=(r.ingredients||[]).map((l,i)=> l.startsWith("## ") ? `<li class="grp">${esc(l.slice(3))}</li>` : `<li><input type="checkbox" id="ing${i}" ${checked.has("ing"+i)?"checked":""}><label for="ing${i}">${scaleLine(l,f)}</label></li>`).join("");
  const steps=(r.steps||[]).map((s,i)=>`<li data-s="${i}" class="${S.doneSteps.has(i)?"done":""}"><div>${esc(s)}</div></li>`).join("");
  const src=r.source||{};
  const srcTxt=[SOURCES[src.type]||"", src.book?esc(src.book)+(src.page?", S. "+esc(src.page):""):"", src.author?esc(src.author):""].filter(Boolean).join(" · ");
  const allTags=Object.keys(VOCAB).flatMap(g=>(t[g]||[]).map(x=>`<span class="tag ${g==="kueche"?"k":""}">${esc(x)}</span>`)).join("");
  openSheet(`
    <div class="sheethead"><div class="row">
      <button class="btn ${S.cook?"primary":""}" type="button" id="dCook" title="Bildschirm bleibt an, größere Schrift">${S.cook?"Kochmodus an":"Kochmodus"}</button>
      <button class="btn" type="button" id="dEdit">Bearbeiten</button>
      ${navigator.share?`<button class="btn ghost" type="button" id="dShare">Teilen</button>`:""}
      <button class="btn ghost danger" type="button" id="dDel">Löschen</button>
    </div><button class="x" type="button" aria-label="Schließen" id="dClose">×</button></div>
    <div id="delConfirm"></div>
    ${hasImg?`<div class="hero"><img data-img="${esc(r.id)}" alt="" hidden></div>`:""}
    <div class="dpad ${S.cook?"cook":""}">
      <div style="display:grid;gap:8px">
        <h2 class="dtitle">${esc(r.title||"Ohne Titel")}</h2>
        ${r.description?`<p class="desc">${esc(r.description)}</p>`:""}
        <div class="tags">${allTags}</div>
      </div>
      <div class="facts">
        <div class="fact"><div class="l">Gesamt</div><div class="v">${total(r)??"–"} <small>Min</small></div></div>
        <div class="fact"><div class="l">Vorbereitung</div><div class="v">${r.prepMin??"–"} <small>Min</small></div></div>
        <div class="fact"><div class="l">Kcal</div><div class="v">${n.kcal?Math.round(n.kcal):"–"} <small>/ Port.</small></div></div>
        <div class="fact"><div class="l">Protein</div><div class="v">${n.protein!=null?Math.round(n.protein):"–"} <small>g</small></div></div>
        <div class="fact"><div class="l">Kohlenhydrate</div><div class="v">${n.carbs!=null?Math.round(n.carbs):"–"} <small>g</small></div></div>
        <div class="fact"><div class="l">Fett</div><div class="v">${n.fat!=null?Math.round(n.fat):"–"} <small>g</small></div></div>
      </div>
      ${n.estimated?`<p class="est" style="margin:-10px 0 0">Nährwerte pro Portion geschätzt.</p>`:""}
      <div class="cols">
        <section>
          <h3>Zutaten</h3>
          ${r.servings?`<div class="portions"><button type="button" id="pMinus" aria-label="Weniger Portionen">−</button><span>${S.portions} Portion${S.portions==1?"":"en"}</span><button type="button" id="pPlus" aria-label="Mehr Portionen">+</button></div>`:""}
          <ul class="ing">${ing||"<li>Keine Zutaten erfasst</li>"}</ul>
        </section>
        <section><h3>Zubereitung</h3><ol class="steps" id="steps">${steps||"<li><div>Keine Schritte erfasst</div></li>"}</ol>${steps?`<p class="hint" style="margin-top:10px">Tipp: Schritt antippen, um ihn abzuhaken.</p>`:""}</section>
      </div>
      <section style="display:grid;gap:12px;border-top:1px solid var(--line);padding-top:16px">
        <div class="row" style="justify-content:space-between">
          <div class="row"><span style="font-weight:600">Bewertung</span><span class="rate" id="rate">${[1,2,3,4,5].map(i=>`<button type="button" data-r="${i}" class="${(r.rating||0)>=i?"on":""}" aria-label="${i} Sterne">★</button>`).join("")}</span></div>
          <label class="toggle"><input type="checkbox" id="cooked" ${r.cooked?"checked":""}> Schon gekocht</label>
        </div>
        <label class="field"><span>Meine Notizen & Anpassungen</span><textarea class="notes" id="notes" placeholder="z. B. weniger Zucker, mit Hühnerbrust statt Tofu …">${esc(r.notes||"")}</textarea></label>
        <div class="srcbox">Quelle: ${srcTxt||"–"}${src.url?` · <a href="${esc(src.url)}" target="_blank" rel="noopener">Original öffnen</a>`:""}</div>
      </section>
    </div>`);
  $("#scrim").scrollTop=scroll;
  fillImages($("#layer"));
  $("#dClose").onclick=closeSheet;
  $("#dEdit").onclick=()=>openEditor(r);
  $("#dCook").onclick=()=>{ S.cook=!S.cook; S.cook?requestWake():releaseWake(); renderDetail(); };
  if($("#dShare")) $("#dShare").onclick=()=>{
    const text=`${r.title}\n\nZutaten:\n${(r.ingredients||[]).map(l=>l.startsWith("## ")?"\n"+l.slice(3)+":":"• "+l).join("\n")}\n\nZubereitung:\n${(r.steps||[]).map((s,i)=>(i+1)+". "+s).join("\n")}${src.url?"\n\nQuelle: "+src.url:""}`;
    navigator.share({title:r.title, text}).catch(()=>{});
  };
  $("#dDel").onclick=()=>{
    $("#delConfirm").innerHTML=`<div class="confirm" style="margin:12px 16px 0"><span>„${esc(r.title)}“ endgültig löschen?</span><button class="btn danger" type="button" id="delYes">Löschen</button><button class="btn ghost" type="button" id="delNo">Abbrechen</button></div>`;
    $("#delNo").onclick=()=>$("#delConfirm").innerHTML="";
    $("#delYes").onclick=async()=>{
      try{ await idb.del("recipes", r.id); await setImage(r.id, null); S.recipes=S.recipes.filter(x=>x.id!==r.id); closeSheet(); render(); toast("Rezept gelöscht"); }
      catch(e){ toast("Löschen fehlgeschlagen"); }
    };
  };
  if(r.servings){ $("#pMinus").onclick=()=>{ if(S.portions>1){S.portions--; renderDetail();} }; $("#pPlus").onclick=()=>{ S.portions++; renderDetail(); }; }
  $("#steps").onclick=e=>{ const li=e.target.closest("li[data-s]"); if(!li) return; const i=+li.dataset.s; S.doneSteps.has(i)?S.doneSteps.delete(i):S.doneSteps.add(i); li.classList.toggle("done"); };
  $("#rate").onclick=async e=>{ const b=e.target.closest("[data-r]"); if(!b) return; const v=+b.dataset.r; await patch(r.id,{rating: r.rating===v?0:v}); renderDetail(); };
  $("#cooked").onchange=e=>patch(r.id,{cooked:e.target.checked});
  $("#notes").onchange=e=>{ patch(r.id,{notes:e.target.value}); toast("Notiz gespeichert"); };
}

/* ---------- Claude (optional, mit eigenem API-Schlüssel) ---------- */
const settings = () => ({ apiKey: ls.get("apiKey",""), model: ls.get("model","claude-sonnet-5-5") });
async function blobToB64(blob){ const buf=new Uint8Array(await blob.arrayBuffer()); let s=""; for(let i=0;i<buf.length;i+=0x8000) s+=String.fromCharCode.apply(null, buf.subarray(i,i+0x8000)); return btoa(s); }
async function askClaude(prompt, images=[], signal){
  const {apiKey, model} = settings();
  if(!apiKey) throw Object.assign(new Error("Kein API-Schlüssel hinterlegt (Einstellungen)."),{code:"no_key"});
  const content=[];
  for(const b of images) content.push({type:"image", source:{type:"base64", media_type:b.type||"image/jpeg", data:await blobToB64(b)}});
  content.push({type:"text", text:prompt});
  const res = await fetch("https://api.anthropic.com/v1/messages",{
    method:"POST", signal,
    headers:{"content-type":"application/json","x-api-key":apiKey,"anthropic-version":"2023-06-01","anthropic-dangerous-direct-browser-access":"true"},
    body:JSON.stringify({model, max_tokens:8000, messages:[{role:"user", content}]})
  });
  const data = await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(data?.error?.message || ("HTTP "+res.status));
  const text = (data.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("");
  const a=text.indexOf("{"), z=text.lastIndexOf("}");
  if(a<0||z<a) throw new Error("Antwort enthielt kein JSON");
  return JSON.parse(text.slice(a,z+1));
}
const PROMPT = `Du bist ein sorgfältiger Rezept-Redakteur. Extrahiere aus dem gelieferten Material genau EIN Rezept und gib NUR ein JSON-Objekt zurück, ohne Erklärungen.
Schreibe alles auf Deutsch (österreichische Begriffe sind willkommen, z. B. Topfen, Schlagobers, Paradeiser). Übersetze fremdsprachige Rezepte. Mengenangaben metrisch (g, ml, EL, TL, Stk).
Schema:
{"title":string,"description":string (1-2 Sätze, appetitlich, ohne Werbung),"servings":number|null,"prepMin":number|null,"cookMin":number|null,"totalMin":number|null,"difficulty":"leicht"|"mittel"|"anspruchsvoll"|null,
"ingredients":[string] (eine Zeile pro Zutat, Menge zuerst, z. B. "200 g Kichererbsen"; Zwischenüberschriften als "## Für die Sauce"),
"steps":[string] (klare, vollständige Arbeitsschritte),
"nutrition":{"kcal":number,"protein":number,"carbs":number,"fat":number,"estimated":boolean} (pro Portion in g; wenn nicht angegeben, realistisch aus den Zutaten schätzen und estimated=true),
"tags":{"kueche":[...],"ernaehrung":[...],"gang":[...],"sport":[...]},
"author":string|null}
Erlaubte Tags (nur diese Werte verwenden):
kueche: ${VOCAB.kueche.items.join(", ")}
ernaehrung: ${VOCAB.ernaehrung.items.join(", ")} (High Protein ab ca. 25 g Protein pro Portion)
gang: ${VOCAB.gang.items.join(", ")}
sport: ${VOCAB.sport.items.join(", ")} (Schnell = Gesamtzeit unter 30 Min; Nach dem Training = proteinreich mit Kohlenhydraten; Vor dem Training = leicht verdaulich, kohlenhydratbetont)
Wenn das Material kein Rezept enthält, antworte {"error":"kurze Begründung"}.`;

/* ---------- Hinzufügen ---------- */
let imp={tab:"text", files:[], busy:false, ctrl:null};
function openImport(){
  const hasKey=!!settings().apiKey;
  imp={tab: hasKey?"text":"manuell", files:[], busy:false, ctrl:null};
  openSheet(`
    <div class="sheethead"><h2>Rezept hinzufügen</h2><button class="x" type="button" aria-label="Schließen" id="iClose">×</button></div>
    <div class="tabs" role="tablist">
      <button class="tab" role="tab" data-t="text" type="button">Text einfügen</button>
      <button class="tab" role="tab" data-t="foto" type="button">Foto / Screenshot</button>
      <button class="tab" role="tab" data-t="manuell" type="button">Manuell</button>
    </div>
    <div class="ipad" id="ipad"></div>
    <div class="foot"><button class="btn ghost" type="button" id="iCancel">Abbrechen</button><button class="btn primary" type="button" id="iGo">Mit Claude erfassen</button></div>`, "narrow");
  $("#iClose").onclick=$("#iCancel").onclick=()=>{ imp.ctrl?.abort(); closeSheet(); };
  $$(".tab").forEach(b=>b.onclick=()=>{ if(!imp.busy){ imp.tab=b.dataset.t; renderImpTab(); } });
  $("#iGo").onclick=runImport;
  renderImpTab();
}
function renderImpTab(){
  $$(".tab").forEach(b=>b.setAttribute("aria-selected", String(b.dataset.t===imp.tab)));
  const p=$("#ipad"), go=$("#iGo"), hasKey=!!settings().apiKey;
  go.textContent = imp.tab==="manuell" ? "Weiter zum Formular" : "Mit Claude erfassen";
  const keyHint = hasKey ? "" : `<p class="hint" style="color:var(--danger)">Für die automatische Erfassung brauchst du einen Claude-API-Schlüssel – hinterlege ihn in den <button class="linkbtn" type="button" id="toSettings">Einstellungen</button>. Ohne Schlüssel nutze „Manuell“.</p>`;
  if(imp.tab==="text") p.innerHTML=`${keyHint}
    <label class="field"><span>Rezepttext</span><textarea id="iText" rows="10" placeholder="Rezept hier hineinkopieren – Instagram-Caption, Website, E-Mail, abgetippte Kochbuchseite …"></textarea></label>
    <label class="field"><span>Quelle (optional)</span><input id="iSrc" type="text" placeholder="Link oder Kochbuch"></label>
    <p class="hint">Tipp: Auf der Rezept-Website alles markieren, kopieren und hier einfügen.</p>
    <div class="status" id="iStatus"></div>`;
  else if(imp.tab==="foto"){ p.innerHTML=`${keyHint}
    <div class="drop" id="drop" tabindex="0"><strong style="color:var(--ink)">Fotos oder Screenshots wählen</strong><span>Kochbuchseite, Instagram-Screenshot, handgeschriebener Zettel – auch mehrere Seiten.</span><input id="iFiles" type="file" accept="image/*" multiple hidden></div>
    <div class="previews" id="prev"></div>
    <div class="f2"><label class="field"><span>Kochbuch (optional)</span><input id="iBook" type="text" placeholder="z. B. Plachutta – Die gute Küche"></label><label class="field"><span>Seite</span><input id="iPage" type="text" inputmode="numeric"></label></div>
    <label class="toggle" style="font-weight:500"><input type="checkbox" id="iUseImg" checked> Erstes Foto als Rezeptbild verwenden</label>
    <div class="status" id="iStatus"></div>`;
    const drop=$("#drop"), fi=$("#iFiles");
    drop.onclick=()=>fi.click(); drop.onkeydown=e=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); fi.click(); } };
    fi.onchange=()=>addFiles(fi.files);
    drop.ondragover=e=>{e.preventDefault(); drop.classList.add("over");}; drop.ondragleave=()=>drop.classList.remove("over");
    drop.ondrop=e=>{e.preventDefault(); drop.classList.remove("over"); addFiles(e.dataTransfer.files);};
    showPrev();
  }
  else p.innerHTML=`<p class="hint">Für eigene Rezepte und Familienrezepte: Du füllst das Formular selbst aus.</p>`;
  $("#toSettings")?.addEventListener("click",openSettings);
}
function addFiles(list){ for(const f of list){ if(f.type.startsWith("image/")) imp.files.push(f); } imp.files=imp.files.slice(0,5); showPrev(); }
function showPrev(){ const p=$("#prev"); if(!p) return; p.innerHTML=""; imp.files.forEach(f=>{ const i=document.createElement("img"); i.src=URL.createObjectURL(f); i.alt=""; p.appendChild(i); }); }
function setStatus(msg,err){ const s=$("#iStatus"); if(s){ s.className="status"+(err?" err":""); s.innerHTML=msg; } }
function busy(on){ imp.busy=on; const g=$("#iGo"); if(g) g.disabled=on; }
async function downscale(file, max=1600, q=.85){
  try{
    const bmp=await createImageBitmap(file); const k=Math.min(1,max/Math.max(bmp.width,bmp.height));
    const c=document.createElement("canvas"); c.width=Math.round(bmp.width*k); c.height=Math.round(bmp.height*k);
    c.getContext("2d").drawImage(bmp,0,0,c.width,c.height);
    return await new Promise(res=>c.toBlob(b=>res(b||file),"image/jpeg",q));
  }catch(e){ return file; }
}
function detectType(url){ const u=(url||"").toLowerCase(); return u.includes("instagram.")?"instagram":u.includes("cookidoo")?"cookidoo":"web"; }
async function runImport(){
  if(imp.tab==="manuell"){ openEditor({source:{type:"eigen"}, tags:{}}, true); return; }
  let material="", images=[], source={}, photoBlob=null;
  busy(true);
  try{
    if(imp.tab==="foto"){
      if(!imp.files.length){ setStatus("Bitte mindestens ein Foto auswählen.",true); busy(false); return; }
      setStatus(`<span class="spin"></span>Bereite Fotos vor …`);
      images=await Promise.all(imp.files.map(f=>downscale(f)));
      const book=$("#iBook").value.trim(), page=$("#iPage").value.trim();
      source={type: book?"buch":"web", book:book||null, page:page||null};
      if($("#iUseImg").checked) photoBlob=await downscale(imp.files[0], 1200, .82);
      material=`Die Bilder zeigen ein Rezept (Kochbuchseite, Screenshot oder Notiz${images.length>1?", mehrere Seiten in Reihenfolge":""}). Lies es vollständig ab.${book?" Kochbuch: "+book+(page?", Seite "+page:""):""}`;
    } else {
      const txt=$("#iText").value.trim(); if(!txt){ setStatus("Bitte zuerst Rezepttext einfügen.",true); busy(false); return; }
      const s=$("#iSrc").value.trim();
      source = /^https?:\/\//i.test(s) ? {type:detectType(s), url:s} : s ? {type:"buch", book:s} : {type:"web"};
      material="Rezepttext:\n"+txt.slice(0,100000);
    }
    setStatus(`<span class="spin"></span>Claude erfasst das Rezept …`);
    imp.ctrl=new AbortController();
    const out=await askClaude(PROMPT+"\n\n--- MATERIAL ---\n"+material, images, imp.ctrl.signal);
    if(!out || out.error){ setStatus("Kein Rezept gefunden"+(out?.error?": "+esc(out.error):"")+".",true); busy(false); return; }
    busy(false);
    openEditor(normalize(out, source), true, photoBlob);
  }catch(e){
    busy(false);
    if(e?.name==="AbortError") return;
    setStatus("Das hat nicht geklappt: "+esc(e?.message||"Unbekannter Fehler"),true);
  }
}
function normalize(o, source){
  const pick=(g,arr)=>(Array.isArray(arr)?arr:[]).filter(x=>VOCAB[g].items.includes(x));
  const num=v=>{ const n=Number(v); return Number.isFinite(n)&&n>0?Math.round(n):null; };
  const t=o.tags||{};
  return {
    title:String(o.title||"").trim(), description:String(o.description||"").trim(),
    servings:num(o.servings), prepMin:num(o.prepMin), cookMin:num(o.cookMin), totalMin:num(o.totalMin), difficulty:o.difficulty||null,
    ingredients:(o.ingredients||[]).map(String).filter(Boolean), steps:(o.steps||[]).map(String).filter(Boolean),
    nutrition:o.nutrition?{kcal:num(o.nutrition.kcal),protein:o.nutrition.protein!=null?Math.round(+o.nutrition.protein):null,carbs:o.nutrition.carbs!=null?Math.round(+o.nutrition.carbs):null,fat:o.nutrition.fat!=null?Math.round(+o.nutrition.fat):null,estimated:!!o.nutrition.estimated}:null,
    tags:{kueche:pick("kueche",t.kueche),ernaehrung:pick("ernaehrung",t.ernaehrung),gang:pick("gang",t.gang),sport:pick("sport",t.sport)},
    source:{...source, author:o.author||source.author||null},
    rating:0, cooked:false, notes:""
  };
}

/* ---------- Editor ---------- */
let ed={draft:null,isNew:false,photo:null,removeImg:false,estimatedNow:false};
function openEditor(r, isNew=false, photoBlob=null){
  ed={draft:JSON.parse(JSON.stringify(r)), isNew, photo:photoBlob, removeImg:false, estimatedNow:false};
  const d=ed.draft, t=d.tags||{}, n=d.nutrition||{}, src=d.source||{}, hasImg=!!d.id && hasPhoto(S.recipes.find(x=>x.id===d.id));
  const tagSets=Object.entries(VOCAB).map(([g,v])=>`<fieldset><legend>${esc(v.label)}</legend><div class="chips">${v.items.map(it=>`<button type="button" class="chip" data-eg="${g}" data-v="${esc(it)}" aria-pressed="${(t[g]||[]).includes(it)}">${esc(it)}</button>`).join("")}</div></fieldset>`).join("");
  openSheet(`
    <div class="sheethead"><h2>${isNew?"Rezept prüfen & speichern":"Rezept bearbeiten"}</h2><button class="x" type="button" aria-label="Schließen" id="eClose">×</button></div>
    <div class="ipad">
      ${isNew&&d.title?`<p class="hint">Claude hat das Rezept erfasst. Kurz prüfen, bei Bedarf anpassen, dann speichern.</p>`:""}
      <label class="field"><span>Titel</span><input id="eTitle" type="text" value="${esc(d.title||"")}"></label>
      <label class="field"><span>Kurzbeschreibung</span><textarea id="eDesc" rows="2">${esc(d.description||"")}</textarea></label>
      <div class="field"><span>Rezeptbild</span><div class="imgedit"><img id="eImgPrev" alt="" hidden ${hasImg&&!ed.photo?`data-img="${esc(d.id)}"`:""}><button class="btn" type="button" id="eImgBtn">Foto wählen</button><button class="btn ghost" type="button" id="eImgDel" ${ed.photo||hasImg?"":"hidden"}>Entfernen</button><input id="eImg" type="file" accept="image/*" hidden></div></div>
      <div class="f2">
        <label class="field"><span>Portionen</span><input id="eServ" type="number" min="1" inputmode="numeric" value="${d.servings??""}"></label>
        <label class="field"><span>Vorbereitung (Min)</span><input id="ePrep" type="number" min="0" inputmode="numeric" value="${d.prepMin??""}"></label>
        <label class="field"><span>Kochen (Min)</span><input id="eCook" type="number" min="0" inputmode="numeric" value="${d.cookMin??""}"></label>
        <label class="field"><span>Gesamt (Min)</span><input id="eTot" type="number" min="0" inputmode="numeric" value="${d.totalMin??""}"></label>
      </div>
      <label class="field"><span>Zutaten – eine pro Zeile, Zwischenüberschrift mit „## “</span><textarea id="eIng" rows="8">${esc((d.ingredients||[]).join("\n"))}</textarea></label>
      <label class="field"><span>Zubereitung – ein Schritt pro Absatz (Leerzeile dazwischen)</span><textarea id="eSteps" rows="8">${esc((d.steps||[]).join("\n\n"))}</textarea></label>
      <fieldset><legend>Nährwerte pro Portion</legend><div class="f2">
        <label class="field"><span>kcal</span><input id="nK" type="number" inputmode="numeric" value="${n.kcal??""}"></label>
        <label class="field"><span>Protein g</span><input id="nP" type="number" inputmode="numeric" value="${n.protein??""}"></label>
        <label class="field"><span>Kohlenhydrate g</span><input id="nC" type="number" inputmode="numeric" value="${n.carbs??""}"></label>
        <label class="field"><span>Fett g</span><input id="nF" type="number" inputmode="numeric" value="${n.fat??""}"></label></div>
        <div class="row" style="margin-top:8px;justify-content:space-between"><span class="hint" id="nHint">${n.estimated?"Geschätzt":""}</span><button class="btn" type="button" id="eAuto" ${settings().apiKey?"":"hidden"}>Nährwerte & Themen von Claude schätzen</button></div>
      </fieldset>
      ${tagSets}
      <fieldset><legend>Quelle</legend><div class="f2">
        <label class="field"><span>Art</span><select id="sType">${Object.entries(SOURCES).map(([k,v])=>`<option value="${k}" ${src.type===k?"selected":""}>${v}</option>`).join("")}</select></label>
        <label class="field" style="grid-column:span 2"><span>Link</span><input id="sUrl" type="url" value="${esc(src.url||"")}"></label></div>
        <div class="f2" style="margin-top:8px"><label class="field" style="grid-column:span 2"><span>Kochbuch</span><input id="sBook" type="text" value="${esc(src.book||"")}"></label><label class="field"><span>Seite</span><input id="sPage" type="text" value="${esc(src.page||"")}"></label></div>
      </fieldset>
      <div class="status" id="eStatus"></div>
    </div>
    <div class="foot"><button class="btn ghost" type="button" id="eCancel">Abbrechen</button><button class="btn primary" type="button" id="eSave">Speichern</button></div>`);
  if(ed.photo){ const p=$("#eImgPrev"); p.src=URL.createObjectURL(ed.photo); p.hidden=false; }
  fillImages($("#layer"));
  $("#eClose").onclick=$("#eCancel").onclick=()=>{ if(!isNew && d.id) openDetail(d.id); else closeSheet(); };
  $$("[data-eg]").forEach(b=>b.onclick=()=>b.setAttribute("aria-pressed", String(b.getAttribute("aria-pressed")!=="true")));
  $("#eImgBtn").onclick=()=>$("#eImg").click();
  $("#eImg").onchange=async e=>{ const f=e.target.files[0]; if(!f) return; ed.photo=await downscale(f,1200,.82); ed.removeImg=false; const p=$("#eImgPrev"); p.src=URL.createObjectURL(ed.photo); p.hidden=false; $("#eImgDel").hidden=false; };
  $("#eImgDel").onclick=()=>{ ed.photo=null; ed.removeImg=true; $("#eImgPrev").hidden=true; $("#eImgDel").hidden=true; };
  $("#eAuto").onclick=autoEnrich;
  $("#eSave").onclick=saveEditor;
}
function collect(){
  const v=id=>$("#"+id).value.trim(), nv=id=>{ const x=$("#"+id).value; return x===""?null:Number(x); };
  const tags={}; Object.keys(VOCAB).forEach(g=>tags[g]=$$(`[data-eg="${g}"][aria-pressed="true"]`).map(b=>b.dataset.v));
  const n={kcal:nv("nK"),protein:nv("nP"),carbs:nv("nC"),fat:nv("nF")};
  const old=ed.draft.nutrition||{};
  const same=["kcal","protein","carbs","fat"].every(k=>(old[k]??null)===n[k]);
  return {
    title:v("eTitle"), description:v("eDesc"),
    servings:nv("eServ"), prepMin:nv("ePrep"), cookMin:nv("eCook"), totalMin:nv("eTot"),
    ingredients:$("#eIng").value.split("\n").map(s=>s.trim()).filter(Boolean),
    steps:$("#eSteps").value.split(/\n\s*\n/).map(s=>s.replace(/\s*\n\s*/g," ").trim()).filter(Boolean),
    nutrition:Object.values(n).some(x=>x!=null)?{...n, estimated: same ? !!old.estimated : ed.estimatedNow}:null,
    tags,
    source:{...(ed.draft.source||{}), type:v("sType"), url:v("sUrl")||null, book:v("sBook")||null, page:v("sPage")||null}
  };
}
async function autoEnrich(){
  const c=collect(); const st=$("#eStatus"); const b=$("#eAuto");
  if(!c.ingredients.length){ st.className="status err"; st.textContent="Erst Zutaten eintragen."; return; }
  b.disabled=true; st.className="status"; st.innerHTML=`<span class="spin"></span>Claude schätzt …`;
  try{
    const out=await askClaude(`Schätze für dieses Rezept die Nährwerte PRO PORTION (Portionen: ${c.servings||"unbekannt – sinnvoll annehmen"}) und ordne Themen zu. Antworte nur mit JSON: {"nutrition":{"kcal":n,"protein":n,"carbs":n,"fat":n},"tags":{"kueche":[],"ernaehrung":[],"gang":[],"sport":[]}}.
Erlaubte Tags: kueche: ${VOCAB.kueche.items.join(", ")} | ernaehrung: ${VOCAB.ernaehrung.items.join(", ")} | gang: ${VOCAB.gang.items.join(", ")} | sport: ${VOCAB.sport.items.join(", ")}
Titel: ${c.title}
Zutaten:\n${c.ingredients.join("\n")}\nSchritte:\n${c.steps.join("\n")}`);
    const n=out.nutrition||{};
    [["nK","kcal"],["nP","protein"],["nC","carbs"],["nF","fat"]].forEach(([id,k])=>{ if(n[k]!=null) $("#"+id).value=Math.round(n[k]); });
    ed.estimatedNow=true; $("#nHint").textContent="Geschätzt von Claude";
    const t=out.tags||{};
    $$("[data-eg]").forEach(btn=>{ if((t[btn.dataset.eg]||[]).includes(btn.dataset.v)) btn.setAttribute("aria-pressed","true"); });
    st.textContent="Ergänzt. Bitte kurz prüfen.";
  }catch(e){ st.className="status err"; st.textContent="Schätzen fehlgeschlagen: "+e.message; }
  b.disabled=false;
}
async function saveEditor(){
  const c=collect(); const st=$("#eStatus"); const btn=$("#eSave");
  if(!c.title){ st.className="status err"; st.textContent="Bitte einen Titel eingeben."; $("#eTitle").focus(); return; }
  btn.disabled=true;
  try{
    const doc={...ed.draft, ...c};
    if(ed.isNew || !doc.id){ doc.id=uid(); doc.origin="app"; doc.createdAt=new Date().toISOString(); doc.rating=doc.rating||0; doc.cooked=!!doc.cooked; doc.notes=doc.notes||""; }
    if(ed.removeImg) delete doc.img;
    await saveRecipe(doc);
    if(ed.photo) await setImage(doc.id, ed.photo);
    else if(ed.removeImg) await setImage(doc.id, null);
    toast(ed.isNew?"Rezept gespeichert":"Änderungen gespeichert");
    render(); openDetail(doc.id);
  }catch(e){ btn.disabled=false; st.className="status err"; st.textContent="Speichern fehlgeschlagen: "+e.message; }
}

/* ---------- Einstellungen, Sicherung ---------- */
function openSettings(){
  const s=settings();
  openSheet(`
    <div class="sheethead"><h2>Einstellungen</h2><button class="x" type="button" aria-label="Schließen" id="sClose">×</button></div>
    <div class="ipad">
      <fieldset><legend>Claude (optional)</legend>
        <div style="display:grid;gap:10px">
          <p class="hint">Mit einem eigenen API-Schlüssel von console.anthropic.com kann die App Rezepte aus Text und Fotos automatisch erfassen und Nährwerte schätzen. Der Schlüssel bleibt nur auf diesem Gerät.</p>
          <label class="field"><span>API-Schlüssel</span><input id="sKey" type="password" autocomplete="off" placeholder="sk-ant-…" value="${esc(s.apiKey)}"></label>
          <label class="field"><span>Modell</span><input id="sModel" type="text" value="${esc(s.model)}"></label>
          <div class="row"><button class="btn primary" type="button" id="sSave">Speichern</button><button class="btn ghost" type="button" id="sForget">Schlüssel löschen</button></div>
        </div>
      </fieldset>
      <fieldset><legend>Sicherung</legend>
        <div style="display:grid;gap:10px">
          <p class="hint">Alle Rezepte, Bewertungen, Notizen und Fotos liegen lokal auf diesem Gerät. Mach regelmäßig eine Sicherung – damit kannst du die Rezepte auch auf ein anderes Gerät übertragen.</p>
          <div class="row">
            <button class="btn" type="button" id="sExport">Sicherung herunterladen</button>
            <button class="btn" type="button" id="sImport">Sicherung einspielen</button>
            <input id="sFile" type="file" hidden>
          </div>
        </div>
      </fieldset>
      <fieldset><legend>Zurücksetzen</legend>
        <div style="display:grid;gap:10px">
          <p class="hint">Stellt die ursprünglichen ${"Rezepte"} wieder her. Eigene Änderungen, neue Rezepte und Fotos gehen verloren.</p>
          <div id="resetBox"><button class="btn danger" type="button" id="sReset">Auf Originaldaten zurücksetzen</button></div>
        </div>
      </fieldset>
      <p class="hint">${S.recipes.length} Rezepte · ${S.images.size} Fotos</p>
      <div class="status" id="sStatus"></div>
    </div>`, "narrow");
  const st=(m,err)=>{ const e=$("#sStatus"); e.className="status"+(err?" err":""); e.innerHTML=m; };
  $("#sClose").onclick=closeSheet;
  $("#sSave").onclick=()=>{ ls.set("apiKey",$("#sKey").value.trim()); ls.set("model",$("#sModel").value.trim()||"claude-sonnet-5-5"); st("Gespeichert."); };
  $("#sForget").onclick=()=>{ ls.set("apiKey",""); $("#sKey").value=""; st("Schlüssel gelöscht."); };
  $("#sExport").onclick=async()=>{
    st(`<span class="spin"></span>Erstelle Sicherung …`);
    try{
      const images={};
      for(const id of S.images){ const b=await idb.get("images",id); if(b) images[id]=`data:${b.type||"image/jpeg"};base64,`+await blobToB64(b); }
      const blob=new Blob([JSON.stringify({app:"rezeptbox",version:1,exportedAt:new Date().toISOString(),recipes:S.recipes,images})],{type:"application/json"});
      const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download=`rezeptbox-sicherung-${new Date().toISOString().slice(0,10)}.json`; document.body.appendChild(a); a.click(); a.remove();
      st("Sicherung heruntergeladen.");
    }catch(e){ st("Fehler: "+esc(e.message),true); }
  };
  $("#sImport").onclick=()=>$("#sFile").click();
  $("#sFile").onchange=async e=>{
    const f=e.target.files[0]; if(!f) return;
    st(`<span class="spin"></span>Spiele Sicherung ein …`);
    try{
      const data=JSON.parse(await f.text());
      const recipes=Array.isArray(data)?data:data.recipes;
      if(!Array.isArray(recipes)) throw new Error("Keine Rezepte in der Datei");
      const clean=recipes.filter(r=>r&&r.title).map(r=>fixRecipe({...r, id:String(r.id||uid())}));
      await idb.putMany("recipes", clean);
      const imgs=Object.entries(data.images||{}); let ni=0, nf=0;
      for(const [id,url] of imgs){
        try{ const b=await (await fetch(url)).blob(); await setImage(id,b); ni++; }catch(_){ nf++; }
        if((ni+nf)%25===0) st(`<span class="spin"></span>Fotos ${ni+nf} / ${imgs.length} …`);
      }
      S.recipes=(await idb.all("recipes")).map(fixRecipe);
      render(); st(`${clean.length} Rezepte und ${ni} Fotos eingespielt.`+(nf?` ${nf} Fotos konnten nicht gelesen werden.`:"")+(imgs.length?"":" Die Datei enthält keine Fotos – exportiere sie in der Rezeptbox auf claude.ai mit „Für App exportieren“."));
    }catch(err){ st("Einspielen fehlgeschlagen: "+esc(err.message),true); }
  };
  $("#sReset").onclick=()=>{
    $("#resetBox").innerHTML=`<div class="confirm"><span>Wirklich alles zurücksetzen?</span><button class="btn danger" type="button" id="rYes">Zurücksetzen</button><button class="btn ghost" type="button" id="rNo">Abbrechen</button></div>`;
    $("#rNo").onclick=openSettings;
    $("#rYes").onclick=async()=>{ await idb.clear("recipes"); await idb.clear("images"); await idb.del("meta","seeded"); urlCache.clear(); S.images.clear(); closeSheet(); S.loaded=false; await load(); toast("Zurückgesetzt"); };
  };
}

/* ---------- Start ---------- */
load().then(()=>{ const m=location.hash.match(/^#r=(.+)$/); if(m) openDetail(decodeURIComponent(m[1])); syncRemote(); });
if("serviceWorker" in navigator && location.protocol!=="file:"){ navigator.serviceWorker.register("sw.js").catch(()=>{}); }
})();
