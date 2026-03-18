import { useState, useRef, useEffect, useCallback } from "react";

// ─── Theme ────────────────────────────────────────────────────────────────────
const C = {
  bg:"#f0f4ff", surface:"#ffffff", card:"#ffffff", border:"#d1d9f0",
  accent:"#6366f1", accentDim:"#4f46e5", gold:"#f59e0b",
  male:"#3b82f6", female:"#ec4899",
  text:"#1e293b", muted:"#64748b", line:"#94a3b8",
  danger:"#ef4444", success:"#10b981",
};
const NW=154, NH=104, MIN_GAP=18, VGAP=100;
const FONT = "'Poppins',sans-serif";

const REL_DEFS = [
  { value:"spouse",      label:"Eşler",                         icon:"💍", color:"#f59e0b", bi:true  },
  { value:"parent",      label:"Ebeveyn → Çocuk",               icon:"👨‍👧", color:"#6366f1", bi:false },
  { value:"sibling",     label:"Kardeş",                        icon:"🤝", color:"#10b981", bi:true  },
  { value:"grandparent", label:"Büyükanne/baba → Torun",        icon:"👴", color:"#f97316", bi:false },
  { value:"uncle",       label:"Amca/Dayı/Hala/Teyze → Yeğen", icon:"🧑", color:"#0ea5e9", bi:false },
];
const RMAP       = Object.fromEntries(REL_DEFS.map(r=>[r.value,r]));
const VERTICAL   = new Set(["parent","grandparent","uncle"]);
const HORIZONTAL = new Set(["spouse","sibling"]);

// ─── Storage ──────────────────────────────────────────────────────────────────
// Priority: window.storage (Claude artifact) → localStorage (browser/GitHub Pages)
// localStorage is persistent across sessions — data survives app close/refresh.
// Photos are stored as base64 inside tree JSON; total size per project ~1-5 MB.
// localStorage limit is ~5-10 MB per origin; for larger trees use Export/Import.

function useClaudeStorage() {
  return typeof window !== "undefined"
    && window.storage != null
    && typeof window.storage.get === "function";
}

// localStorage key prefix so we never clash with other apps
const LS_PREFIX = "soyagaci_v1_";

async function storageGet(k) {
  if (useClaudeStorage()) {
    try { const r = await window.storage.get(k); return r ? JSON.parse(r.value) : null; }
    catch { return null; }
  }
  try {
    const raw = localStorage.getItem(LS_PREFIX + k);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function storageSet(k, v) {
  if (useClaudeStorage()) {
    try { await window.storage.set(k, JSON.stringify(v)); return true; }
    catch { return false; }
  }
  try {
    localStorage.setItem(LS_PREFIX + k, JSON.stringify(v));
    return true;
  } catch(e) {
    // QuotaExceededError — try removing old entries then retry
    if (e.name === "QuotaExceededError" || e.code === 22) {
      console.warn("localStorage quota exceeded, clearing old data...");
      try {
        // Remove all our own keys first to make room
        const ownKeys = [];
        for (let i = 0; i < localStorage.length; i++) {
          const lk = localStorage.key(i);
          if (lk && lk.startsWith(LS_PREFIX)) ownKeys.push(lk);
        }
        // Sort by value length desc, remove largest first until we have room
        ownKeys.sort((a,b) => (localStorage.getItem(b)||"").length - (localStorage.getItem(a)||"").length);
        for (const lk of ownKeys) {
          localStorage.removeItem(lk);
          try { localStorage.setItem(LS_PREFIX + k, JSON.stringify(v)); return true; } catch {}
        }
      } catch {}
    }
    return false;
  }
}

async function storageDel(k) {
  if (useClaudeStorage()) {
    try { await window.storage.delete(k); return true; } catch { return false; }
  }
  try { localStorage.removeItem(LS_PREFIX + k); return true; } catch { return false; }
}

async function storageList(pfx) {
  if (useClaudeStorage()) {
    try { const r = await window.storage.list(pfx); return r ? r.keys : []; } catch { return []; }
  }
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const lk = localStorage.key(i);
      if (lk && lk.startsWith(LS_PREFIX + pfx)) {
        keys.push(lk.slice(LS_PREFIX.length)); // strip our prefix before returning
      }
    }
    return keys;
  } catch { return []; }
}

// ─── File helpers ─────────────────────────────────────────────────────────────
function readFileAsBase64(file) { return new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(r.result); r.onerror=rej; r.readAsDataURL(file); }); }
function resizeImage(dataUrl,max=220) { return new Promise(res=>{ const img=new Image(); img.onload=()=>{ const s=Math.min(max/img.width,max/img.height,1); const w=Math.round(img.width*s),h=Math.round(img.height*s); const c=document.createElement("canvas"); c.width=w; c.height=h; c.getContext("2d").drawImage(img,0,0,w,h); res(c.toDataURL("image/jpeg",0.82)); }; img.src=dataUrl; }); }
function exportTree(tree) { const blob=new Blob([JSON.stringify(tree,null,2)],{type:"application/json"}); const url=URL.createObjectURL(blob),a=document.createElement("a"); a.href=url; a.download=tree.name.replace(/[^a-zA-Z0-9_\u00C0-\u024F ]/g,"_")+".ftree.json"; a.click(); URL.revokeObjectURL(url); }
function importTreeFile(file) { return new Promise((res,rej)=>{ const r=new FileReader(); r.onload=e=>{ try { const d=JSON.parse(e.target.result); if(!d.name||!Array.isArray(d.people)||!Array.isArray(d.rels)) return rej(new Error("Geçersiz dosya formatı")); res(d); } catch { rej(new Error("JSON okunamadı")); } }; r.onerror=()=>rej(new Error("Dosya okunamadı")); r.readAsText(file); }); }

// ─── Person label helper (name + birth year for disambiguation) ───────────────
function personLabel(p, people) {
  if (!p) return "?";
  const sameNameCount = people.filter(x => x.name === p.name).length;
  let extra = "";
  if (sameNameCount > 1) {
    const parts = [];
    if (p.born) parts.push(p.born);
    // Add father/mother info if available
    const parents = people.filter(par =>
      (people.__rels || []).some(r =>
        r.type === "parent" && r.p1 === par.id && r.p2 === p.id
      )
    );
    if (parents.length > 0) parts.push(parents.map(x => x.name).join("/") + " çocuğu");
    if (parts.length > 0) extra = " (" + parts.join(", ") + ")";
  }
  return p.name + extra;
}

// ─── Layout — Walker / Reingold-Tilford family tree ─────────────────────────
//
//  True family-tree layout:
//   • Every person occupies exactly one rank (row)
//   • Spouses sit side-by-side on the same row
//   • Children are centred under their couple's midpoint
//   • A horizontal "connector bar" joins couple→children
//   • No overlaps, minimum crossings
//   • Algorithm: assign subtree widths bottom-up, then position top-down

function buildLayout(people, rels) {
  if (!people.length) return { pos:{}, couplePoints:{}, bbox:{x0:0,y0:0,w:400,h:300} };

  const SLOT = NW + MIN_GAP;

  // ── 1. Adjacency ───────────────────────────────────────────────────────────
  const childrenOf={}, parentsOf={}, spouseOf={};
  people.forEach(p=>{ childrenOf[p.id]=[]; parentsOf[p.id]=[]; spouseOf[p.id]=[]; });
  rels.forEach(({type,p1,p2})=>{
    if(!people.find(p=>p.id===p1)||!people.find(p=>p.id===p2)) return;
    if(VERTICAL.has(type)){
      if(!childrenOf[p1].includes(p2)) childrenOf[p1].push(p2);
      if(!parentsOf[p2].includes(p1))  parentsOf[p2].push(p1);
    } else if(type==="spouse"){
      if(!spouseOf[p1].includes(p2)) spouseOf[p1].push(p2);
      if(!spouseOf[p2].includes(p1)) spouseOf[p2].push(p1);
    }
  });

  // ── 2. Rank (generation) assignment ───────────────────────────────────────
  const rank={};
  people.forEach(p=>{ rank[p.id]=parentsOf[p.id].length===0?0:-1; });
  let ch=true,it=0;
  while(ch&&it++<40){ ch=false;
    people.forEach(p=>{
      const pr=parentsOf[p.id].map(id=>rank[id]).filter(r=>r>=0);
      if(!pr.length) return;
      const need=Math.max(...pr)+1;
      if((rank[p.id]??-1)<need){ rank[p.id]=need; ch=true; }
    });
  }
  people.forEach(p=>{ if(rank[p.id]<0) rank[p.id]=0; });
  // Spouses share same rank (max)
  ch=true;it=0;
  while(ch&&it++<15){ ch=false;
    people.forEach(p=>{ spouseOf[p.id].forEach(s=>{
      const nr=Math.max(rank[p.id],rank[s]);
      if(rank[p.id]!==nr){rank[p.id]=nr;ch=true;}
      if(rank[s]!==nr){rank[s]=nr;ch=true;}
    }); });
  }
  // Children strictly below all parents
  ch=true;it=0;
  while(ch&&it++<20){ ch=false;
    people.forEach(p=>{ childrenOf[p.id].forEach(cid=>{
      const need=rank[p.id]+1;
      if(rank[cid]<need){rank[cid]=need;ch=true;}
    }); });
  }
  // Compact to 0,1,2,...
  const used=[...new Set(Object.values(rank))].sort((a,b)=>a-b);
  const rm={}; used.forEach((r,i)=>rm[r]=i);
  people.forEach(p=>{ rank[p.id]=rm[rank[p.id]]??0; });

  // ── 3. Build "family units" ────────────────────────────────────────────────
  // A family unit = one couple + their shared children
  // Single parents (no spouse) also form a unit
  const units=[];  // {id, members:[id,...], children:[id,...], coupleIds:[id,...]}
  const unitOf={};  // personId → unit

  const pairedDone=new Set();
  people.forEach(p=>{
    const spouses=spouseOf[p.id].filter(s=>rank[s]===rank[p.id]);
    if(spouses.length && !pairedDone.has(p.id)){
      const s=spouses[0];
      pairedDone.add(p.id); pairedDone.add(s);
      const shared=childrenOf[p.id].filter(c=>parentsOf[c].includes(s));
      const uid="u:"+[p.id,s].sort().join("|");
      units.push({id:uid,members:[p.id,s],children:shared});
      unitOf[p.id]=uid; unitOf[s]=uid;
    }
  });
  // Solo people not yet in a unit
  people.forEach(p=>{
    if(unitOf[p.id]) return;
    const uid="u:"+p.id;
    const soloChildren=childrenOf[p.id].filter(c=>!parentsOf[c].some(pid=>pid!==p.id&&unitOf[pid]===unitOf[p.id]));
    units.push({id:uid,members:[p.id],children:childrenOf[p.id]});
    unitOf[p.id]=uid;
  });

  // ── 4. Subtree width (bottom-up) ──────────────────────────────────────────
  // subW[unitId] = minimum width in SLOT units needed by this unit + all descendants
  const subW={};
  const byRank={};
  people.forEach(p=>{ const r=rank[p.id]; (byRank[r]=byRank[r]||new Set()).add(p.id); });
  const maxRank=Math.max(...Object.keys(byRank).map(Number));

  // Process bottom-up
  for(let r=maxRank;r>=0;r--){
    const unitsAtRank=new Set([...(byRank[r]||[])].map(id=>unitOf[id]).filter(Boolean));
    unitsAtRank.forEach(uid=>{
      const unit=units.find(u=>u.id===uid); if(!unit) return;
      const ownW=unit.members.length*SLOT;
      // Children's subtree widths (children may belong to units at deeper rank)
      const childUnits=[...new Set(unit.children.map(c=>unitOf[c]).filter(Boolean))];
      const childW=childUnits.reduce((s,cu)=>{
        const cUnit=units.find(u=>u.id===cu);
        return s+(subW[cu]??((cUnit?.members.length||1)*SLOT));
      },0)+(Math.max(0,childUnits.length-1))*MIN_GAP;
      subW[uid]=Math.max(ownW,childW);
    });
  }

  // ── 5. X assignment (top-down) ────────────────────────────────────────────
  const posX={};
  const unitX={};  // unitId → left edge of unit's allocated space

  // Roots: units at rank 0
  const rootUnits=[...new Set([...(byRank[0]||[])].map(id=>unitOf[id]).filter(Boolean))];
  let cursor=0;
  rootUnits.forEach(uid=>{
    unitX[uid]=cursor;
    cursor+=(subW[uid]??SLOT)+MIN_GAP*2;
  });

  // Top-down: place unit members, then distribute children
  for(let r=0;r<=maxRank;r++){
    const unitsAtRank=[...new Set([...(byRank[r]||[])].map(id=>unitOf[id]).filter(Boolean))];
    unitsAtRank.forEach(uid=>{
      const unit=units.find(u=>u.id===uid); if(!unit) return;
      const ux=unitX[uid]??0;
      const uw=subW[uid]??SLOT;
      // Place members centred in their allocated width
      const membW=(unit.members.length-1)*SLOT;
      const membStart=ux+uw/2-membW/2;
      unit.members.forEach((id,i)=>{ posX[id]=membStart+i*SLOT; });

      // Distribute children's units in remaining width
      if(!unit.children.length) return;
      const childUnits=[...new Set(unit.children.map(c=>unitOf[c]).filter(Boolean))];
      const totalChildW=childUnits.reduce((s,cu)=>s+(subW[cu]??SLOT),0)+(childUnits.length-1)*MIN_GAP;
      let cx=ux+uw/2-totalChildW/2;
      childUnits.forEach(cu=>{
        unitX[cu]=cx;
        cx+=(subW[cu]??SLOT)+MIN_GAP;
      });
    });
  }

  // ── 6. Resolve any remaining overlaps per rank ────────────────────────────
  Object.keys(byRank).forEach(r=>{
    const ids=[...(byRank[r]||[])].sort((a,b)=>(posX[a]??0)-(posX[b]??0));
    let minX=-Infinity;
    ids.forEach(id=>{
      if((posX[id]??0)<minX+SLOT) posX[id]=minX+SLOT;
      minX=posX[id]??0;
    });
  });

  // Re-centre spouse pairs after overlap fix
  units.forEach(unit=>{
    if(unit.members.length<2) return;
    // If children exist, re-centre over them
    const childXs=unit.children.map(c=>posX[c]).filter(x=>x!=null);
    if(childXs.length){
      const cCentre=(Math.min(...childXs)+Math.max(...childXs))/2;
      const membW=(unit.members.length-1)*SLOT;
      unit.members.forEach((id,i)=>{ posX[id]=cCentre-membW/2+i*SLOT; });
    }
  });

  // ── 7. Centre whole tree ───────────────────────────────────────────────────
  const allX=Object.values(posX);
  const treeMin=Math.min(...allX), treeMax=Math.max(...allX);
  const shift=-((treeMin+treeMax)/2);
  people.forEach(p=>{ posX[p.id]=(posX[p.id]??0)+shift; });

  // ── 8. Build pos & couplePoints ───────────────────────────────────────────
  const pos={};
  people.forEach(p=>{ pos[p.id]={ x:posX[p.id]??0, y:rank[p.id]*(NH+VGAP)+NH/2 }; });

  const couplePoints={};
  units.forEach(unit=>{
    if(unit.members.length>=2){
      const [p1,p2]=unit.members;
      const a=pos[p1],b=pos[p2];
      if(a&&b) couplePoints[unit.id]={x:(a.x+b.x)/2, y:a.y, children:unit.children, p1,p2};
    }
  });

  // ── 9. Bounding box ───────────────────────────────────────────────────────
  const xs=Object.values(pos).map(p=>p.x);
  const ys=Object.values(pos).map(p=>p.y);
  return {
    pos, couplePoints,
    bbox:{
      x0:Math.min(...xs)-NW/2-30,
      y0:Math.min(...ys)-NH/2-30,
      w:Math.max(...xs)-Math.min(...xs)+NW+60,
      h:Math.max(...ys)-Math.min(...ys)+NH+60
    }
  };
}

// ─── SVG Node ─────────────────────────────────────────────────────────────────
function Node({person,p,sel,onClick,outsider}) {
  const col        = person.gender==="male" ? C.male : C.female;
  const normalBg   = person.gender==="male" ? "#dbeafe" : "#fce7f3";
  const outsiderBg = person.gender==="male" ? "#1e40af" : "#9d174d";
  const cardBg     = sel ? "#e0e7ff" : (outsider ? outsiderBg : normalBg);
  const nameFill   = outsider && !sel ? "#ffffff" : "#1e293b";
  const yearFill   = outsider && !sel ? "#cbd5e1" : "#64748b";
  const isDead=!!person.died;
  return (
    <g transform={"translate("+(p.x-NW/2)+","+(p.y-NH/2)+")"} data-node="1"
       onClick={e=>{e.stopPropagation();onClick(person.id);}} style={{cursor:"pointer"}}>
      <defs>
        <clipPath id={"cp-"+person.id}><circle cx={NW/2} cy={38} r={25}/></clipPath>
        <filter id={"sh-"+person.id} x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="2" stdDeviation={sel?5:3} floodColor={col} floodOpacity={sel?0.3:0.1}/>
        </filter>
      </defs>
      <rect width={NW} height={NH} rx={14} fill={cardBg} stroke={col} strokeWidth={sel?2.5:(outsider?2:1.5)} filter={"url(#sh-"+person.id+")"} opacity={isDead?0.65:1}/>
      {outsider&&!sel&&<rect width={NW} height={NH} rx={14} fill="none" stroke={col} strokeWidth={1} strokeDasharray="4 3" opacity={0.4}/>}
      <rect width={NW} height={5} rx={2} fill={col}/>
      {person.photo
        ?<image href={person.photo} x={NW/2-25} y={13} width={50} height={50} clipPath={"url(#cp-"+person.id+")"} preserveAspectRatio="xMidYMid slice"/>
        :<><circle cx={NW/2} cy={38} r={25} fill={normalBg} stroke={col} strokeWidth={1.5}/><text x={NW/2} y={46} textAnchor="middle" fill={col} fontSize={20} fontFamily="serif">{person.gender==="male"?"♂":"♀"}</text></>
      }
      <circle cx={NW/2} cy={38} r={25} fill="none" stroke={col} strokeWidth={1.5} opacity={0.5}/>
      {isDead&&<text x={NW-12} y={18} fill="#94a3b8" fontSize={13}>✝</text>}
      <text x={NW/2} y={76} textAnchor="middle" fill={nameFill} fontSize={11} fontWeight="700" fontFamily={FONT}>
        {person.name.length>18?person.name.slice(0,17)+"…":person.name}
      </text>
      <text x={NW/2} y={92} textAnchor="middle" fill={yearFill} fontSize={10} fontFamily={FONT}>
        {person.born||"?"}{person.died?" – "+person.died:""}
      </text>
    </g>
  );
}

// ─── Canvas ───────────────────────────────────────────────────────────────────
function Canvas({people,rels,selId,onSelect}) {
  const wrapRef=useRef(null),svgRef=useRef(null);
  const vpRef=useRef({x:0,y:0,s:1});
  const [vp,setVp]=useState({x:0,y:0,s:1});
  const [sz,setSz]=useState({w:360,h:480});
  const drag=useRef({on:false,lx:0,ly:0,pinch:false,ld:0});
  const {pos,couplePoints,bbox}=buildLayout(people,rels);

  const fit=useCallback((w,h)=>{
    if(!bbox.w||!bbox.h) return {x:w/2,y:50,s:1};
    const s=Math.min((w-30)/bbox.w,(h-30)/bbox.h,1.3);
    return {x:w/2-(bbox.x0+bbox.w/2)*s,y:h/2-(bbox.y0+bbox.h/2)*s,s};
  },[bbox.x0,bbox.y0,bbox.w,bbox.h]);

  useEffect(()=>{ const el=wrapRef.current; if(!el) return; const w=el.offsetWidth,h=el.offsetHeight; setSz({w,h}); const v=fit(w,h); vpRef.current=v; setVp(v); },[people.length,rels.length]);
  useEffect(()=>{ const el=wrapRef.current; if(!el) return; const ro=new ResizeObserver(([e])=>{ const {width:w,height:h}=e.contentRect; setSz({w,h}); }); ro.observe(el); return ()=>ro.disconnect(); },[]);

  useEffect(()=>{
    const el=svgRef.current; if(!el) return;
    const ts=e=>{ if(e.touches.length===1) drag.current={on:true,lx:e.touches[0].clientX,ly:e.touches[0].clientY,pinch:false,ld:0}; else if(e.touches.length===2){ const dx=e.touches[0].clientX-e.touches[1].clientX,dy=e.touches[0].clientY-e.touches[1].clientY; drag.current={on:false,pinch:true,lx:0,ly:0,ld:Math.hypot(dx,dy)}; } };
    const tm=e=>{ e.preventDefault(); const d=drag.current;
      if(d.pinch&&e.touches.length===2){ const dx=e.touches[0].clientX-e.touches[1].clientX,dy=e.touches[0].clientY-e.touches[1].clientY; const nd=Math.hypot(dx,dy),f=nd/d.ld; d.ld=nd; const nv={...vpRef.current,s:Math.min(3,Math.max(0.2,vpRef.current.s*f))}; vpRef.current=nv; setVp({...nv}); }
      else if(d.on&&e.touches.length===1){ const dx=e.touches[0].clientX-d.lx,dy=e.touches[0].clientY-d.ly; d.lx=e.touches[0].clientX; d.ly=e.touches[0].clientY; const nv={...vpRef.current,x:vpRef.current.x+dx,y:vpRef.current.y+dy}; vpRef.current=nv; setVp({...nv}); }
    };
    const te=()=>{ drag.current.on=false; drag.current.pinch=false; };
    el.addEventListener("touchstart",ts,{passive:true}); el.addEventListener("touchmove",tm,{passive:false}); el.addEventListener("touchend",te,{passive:true});
    return ()=>{ el.removeEventListener("touchstart",ts); el.removeEventListener("touchmove",tm); el.removeEventListener("touchend",te); };
  },[]);

  const md=e=>{ if(e.target.closest("[data-node]")) return; drag.current={...drag.current,on:true,lx:e.clientX,ly:e.clientY}; };
  const mm=e=>{ if(!drag.current.on) return; const dx=e.clientX-drag.current.lx,dy=e.clientY-drag.current.ly; drag.current.lx=e.clientX; drag.current.ly=e.clientY; const nv={...vpRef.current,x:vpRef.current.x+dx,y:vpRef.current.y+dy}; vpRef.current=nv; setVp({...nv}); };
  const mu=()=>{ drag.current.on=false; };
  const wh=e=>{ e.preventDefault(); const f=e.deltaY<0?1.1:0.91; const nv={...vpRef.current,s:Math.min(3,Math.max(0.2,vpRef.current.s*f))}; vpRef.current=nv; setVp({...nv}); };
  const doFit=()=>{ const v=fit(sz.w,sz.h); vpRef.current=v; setVp(v); };

  // ── Draw edges using couple midpoints ─────────────────────────────────────
  const spouseColor = RMAP["spouse"]?.color || "#f59e0b";
  const parentColor = RMAP["parent"]?.color || "#6366f1";

  const edgeElements = [];
  const drawnSpouse = new Set();

  // 1. Spouse lines (horizontal, dashed, with ♥ at midpoint)
  rels.filter(r=>r.type==="spouse").forEach(r=>{
    const key=[r.p1,r.p2].sort().join("|");
    if(drawnSpouse.has(key)) return; drawnSpouse.add(key);
    const a=pos[r.p1], b=pos[r.p2]; if(!a||!b) return;
    const mx=(a.x+b.x)/2, my=a.y;
    edgeElements.push(
      <g key={"sp-"+key}>
        <line x1={a.x} y1={my} x2={b.x} y2={my} stroke={spouseColor} strokeWidth={2} strokeDasharray="6 3" opacity={0.85}/>
        <circle cx={mx} cy={my} r={8} fill={spouseColor} opacity={0.15}/>
        <text x={mx} y={my+4} textAnchor="middle" fontSize={11} fill={spouseColor}>♥</text>
      </g>
    );
  });

  // 2. Parent→child edges: from couple midpoint down to child
  //    If child has two parents who are a couple → edge from couple centre
  //    If child has only one known parent → edge from that parent
  const drawnParent = new Set();
  rels.filter(r=>VERTICAL.has(r.type)).forEach(r=>{
    if(drawnParent.has(r.id)) return; drawnParent.add(r.id);
    const child=pos[r.p2]; if(!child) return;
    const col = (RMAP[r.type]?.color) || parentColor;
    const dash = r.type==="grandparent"?"7 4":r.type==="uncle"?"3 3":"none";

    // Find if there's a couple point for parent r.p1 + a co-parent
    const coParents = (rels.filter(r2=>VERTICAL.has(r2.type)&&r2.p2===r.p2&&r2.p1!==r.p1).map(r2=>r2.p1));
    const coupleKey = coParents.length
      ? "couple:"+[r.p1,...coParents].flatMap(a=>[r.p1,...coParents].map(b=>a<b?a+"|"+b:b+"|"+a)).find(k=>couplePoints[k])
      : null;
    const cp = Object.values(couplePoints).find(cp=>
      (cp.p1===r.p1||cp.p2===r.p1) && cp.children.includes(r.p2)
    );

    const fromX = cp ? cp.x : (pos[r.p1]?.x ?? 0);
    const fromY = cp ? cp.y : (pos[r.p1]?.y ?? 0);
    const fy = fromY + NH/2 + 6;
    const ty = child.y - NH/2 - 4;
    const cy = (fy+ty)/2;

    edgeElements.push(
      <path key={"pc-"+r.id}
        d={"M"+fromX+","+fy+" C"+fromX+","+cy+" "+child.x+","+cy+" "+child.x+","+ty}
        fill="none" stroke={col} strokeWidth={1.8} strokeDasharray={dash} opacity={0.75}/>
    );
  });

  const lines = edgeElements;

  return (
    <div ref={wrapRef} style={{position:"relative",width:"100%",height:"100%",background:"#f0f4ff",borderRadius:14,overflow:"hidden",border:"1px solid #d1d9f0"}}>
      <svg ref={svgRef} width={sz.w} height={sz.h} style={{display:"block",userSelect:"none"}}
        onMouseDown={md} onMouseMove={mm} onMouseUp={mu} onMouseLeave={mu} onWheel={wh}
        onClick={()=>onSelect(null)}>
        <g transform={"translate("+vp.x+","+vp.y+") scale("+vp.s+")"}>
          {lines}
          {(()=>{
            const hasParent=new Set(rels.filter(r=>r.type==="parent").map(r=>r.p2));
            const hasSpouse=new Set([
              ...rels.filter(r=>r.type==="spouse").map(r=>r.p1),
              ...rels.filter(r=>r.type==="spouse").map(r=>r.p2),
            ]);
            return people.map(p=>{ const pt=pos[p.id]; if(!pt) return null;
              const isOutsider=hasSpouse.has(p.id)&&!hasParent.has(p.id);
              return <Node key={p.id} person={p} p={pt} sel={selId===p.id} onClick={onSelect} outsider={isOutsider}/>;
            });
          })()}
        </g>
      </svg>
      <button onClick={doFit} style={{position:"absolute",top:10,right:10,background:"#ffffff",border:"1px solid #d1d9f0",borderRadius:8,color:"#1e293b",padding:"7px 13px",fontSize:13,cursor:"pointer",boxShadow:"0 1px 4px rgba(0,0,0,0.08)",fontFamily:FONT}}>⊡ Sığdır</button>
      <div style={{position:"absolute",bottom:10,left:10,background:"#ffffffee",borderRadius:9,padding:"8px 11px",fontSize:11,color:"#475569",fontFamily:FONT,lineHeight:2,boxShadow:"0 1px 4px rgba(0,0,0,0.07)"}}>
        {REL_DEFS.map(r=><div key={r.value}><span style={{color:r.color,marginRight:4}}>{HORIZONTAL.has(r.value)?"╌╌":"──"}</span>{r.label.split(" ")[0]}</div>)}
      </div>
      <div style={{position:"absolute",bottom:10,right:10,fontSize:10,color:"#94a3b8",fontFamily:FONT,textAlign:"right"}}>Sürükle · Pinch zoom</div>
    </div>
  );
}

// ─── Drag-sortable list ────────────────────────────────────────────────────────
function DragList({items,onReorder,renderItem}) {
  const dragIdx=useRef(null);
  const [dragOver,setDragOver]=useState(null);

  const onDragStart=(e,i)=>{ dragIdx.current=i; e.dataTransfer.effectAllowed="move"; };
  const onDragOver=(e,i)=>{ e.preventDefault(); setDragOver(i); };
  const onDrop=(e,i)=>{ e.preventDefault(); const from=dragIdx.current; if(from===null||from===i) return; const next=[...items]; const [moved]=next.splice(from,1); next.splice(i,0,moved); onReorder(next); dragIdx.current=null; setDragOver(null); };
  const onDragEnd=()=>{ dragIdx.current=null; setDragOver(null); };

  return (
    <div style={{display:"flex",flexDirection:"column",gap:8}}>
      {items.map((item,i)=>(
        <div key={item.id} draggable
          onDragStart={e=>onDragStart(e,i)} onDragOver={e=>onDragOver(e,i)}
          onDrop={e=>onDrop(e,i)} onDragEnd={onDragEnd}
          style={{opacity:dragOver===i?0.5:1,transition:"opacity 0.15s",outline:dragOver===i?"2px dashed #6366f1":"none",borderRadius:10}}>
          {renderItem(item,i)}
        </div>
      ))}
    </div>
  );
}

// ─── Searchable Select ────────────────────────────────────────────────────────
function SearchSelect({value, onChange, options, placeholder}) {
  const [query, setQuery]   = useState("");
  const [open,  setOpen]    = useState(false);
  const wrapRef             = useRef(null);

  const filtered = options.filter(o =>
    o.label.toLowerCase().includes(query.toLowerCase())
  );
  const selected = options.find(o => o.value === value);

  // Close on outside click
  useEffect(() => {
    const handler = e => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const inp = {
    background:"#f8faff", border:"1px solid #e2e8f0", borderRadius:8,
    color:"#1e293b", padding:"11px 13px", fontSize:15, outline:"none",
    width:"100%", fontFamily:FONT,
  };

  return (
    <div ref={wrapRef} style={{position:"relative",width:"100%"}}>
      {/* Trigger */}
      <div
        onClick={() => { setOpen(o => !o); setQuery(""); }}
        style={{...inp, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"space-between", userSelect:"none"}}
      >
        <span style={{color: selected ? "#1e293b" : "#94a3b8", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>
          {selected ? selected.label : (placeholder || "Seçin…")}
        </span>
        <span style={{color:"#94a3b8", fontSize:12, marginLeft:8, flexShrink:0}}>{open ? "▲" : "▼"}</span>
      </div>

      {/* Dropdown */}
      {open && (
        <div style={{
          position:"absolute", top:"calc(100% + 4px)", left:0, right:0, zIndex:2000,
          background:"#ffffff", border:"1px solid #e2e8f0", borderRadius:12,
          boxShadow:"0 8px 24px rgba(99,102,241,0.15)", overflow:"hidden",
        }}>
          {/* Search input */}
          <div style={{padding:"8px 10px", borderBottom:"1px solid #f1f5f9"}}>
            <input
              autoFocus
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Ara…"
              style={{...inp, padding:"8px 11px", fontSize:14, background:"#f8faff"}}
              onClick={e => e.stopPropagation()}
            />
          </div>
          {/* Options */}
          <div style={{maxHeight:220, overflowY:"auto"}}>
            {filtered.length === 0
              ? <div style={{padding:"12px 14px", color:"#94a3b8", fontSize:14, fontFamily:FONT}}>Sonuç bulunamadı</div>
              : filtered.map(o => (
                  <div
                    key={o.value}
                    onClick={() => { onChange(o.value); setOpen(false); setQuery(""); }}
                    style={{
                      padding:"10px 14px", cursor:"pointer", fontSize:14, fontFamily:FONT,
                      background: o.value === value ? "#eef2ff" : "transparent",
                      color: o.value === value ? "#6366f1" : "#1e293b",
                      fontWeight: o.value === value ? 600 : 400,
                      borderBottom:"1px solid #f8faff",
                    }}
                    onMouseEnter={e => { if(o.value !== value) e.currentTarget.style.background="#f8faff"; }}
                    onMouseLeave={e => { if(o.value !== value) e.currentTarget.style.background="transparent"; }}
                  >
                    {o.label}
                  </div>
                ))
            }
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Person Modal ─────────────────────────────────────────────────────────────
function PersonModal({person,onSave,onClose}) {
  const isEdit=!!person;
  const fileRef=useRef(null);
  const [form,setForm]=useState({name:person?.name||"",gender:person?.gender||"male",born:person?.born||"",died:person?.died||"",photo:person?.photo||null});
  const [uploading,setUploading]=useState(false);
  const set=(k,v)=>setForm(f=>({...f,[k]:v}));
  const handlePhoto=async e=>{ const file=e.target.files?.[0]; if(!file) return; setUploading(true); try { const raw=await readFileAsBase64(file); const rsz=await resizeImage(raw,220); set("photo",rsz); } catch{} setUploading(false); };
  const handleSave=()=>{ if(!form.name.trim()) return; onSave({...form,name:form.name.trim()}); };
  const col=form.gender==="male"?C.male:C.female;
  const colLight=form.gender==="male"?"#dbeafe":"#fce7f3";
  const inp={background:"#f8faff",border:"1px solid #e2e8f0",borderRadius:8,color:"#1e293b",padding:"11px 13px",fontSize:15,outline:"none",width:"100%",fontFamily:FONT};
  const lbl={fontSize:12,color:"#64748b",display:"block",marginBottom:6,letterSpacing:"0.04em",fontWeight:500};
  return (
    <div style={{position:"fixed",inset:0,background:"#00000099",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000,padding:16}}>
      <div style={{background:"#ffffff",border:"1px solid #e2e8f0",borderRadius:20,width:"100%",maxWidth:420,maxHeight:"92vh",overflow:"auto",boxShadow:"0 8px 32px rgba(99,102,241,0.15)"}}>
        <div style={{padding:"16px 18px",borderBottom:"1px solid #e2e8f0",display:"flex",alignItems:"center",justifyContent:"space-between",position:"sticky",top:0,background:"#ffffff",zIndex:1,borderRadius:"20px 20px 0 0"}}>
          <span style={{fontSize:16,fontWeight:700,color:"#6366f1",fontFamily:FONT}}>{isEdit?"✏️ Kişiyi Düzenle":"➕ Yeni Kişi"}</span>
          <button onClick={onClose} style={{background:"transparent",border:"none",color:"#64748b",fontSize:24,cursor:"pointer",lineHeight:1}}>✕</button>
        </div>
        <div style={{padding:"18px",display:"flex",flexDirection:"column",gap:16}}>
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:10}}>
            <div onClick={()=>fileRef.current?.click()} style={{width:92,height:92,borderRadius:"50%",cursor:"pointer",border:"3px solid "+col,overflow:"hidden",background:form.photo?"transparent":colLight,display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 2px 12px "+col+"44"}}>
              {form.photo?<img src={form.photo} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>:<span style={{fontSize:34,color:col}}>{form.gender==="male"?"♂":"♀"}</span>}
            </div>
            <input ref={fileRef} type="file" accept="image/*" style={{display:"none"}} onChange={handlePhoto}/>
            <div style={{display:"flex",gap:8}}>
              <button onClick={()=>fileRef.current?.click()} disabled={uploading} style={{background:"#6366f1",border:"1px solid #6366f1",borderRadius:8,color:"#ffffff",padding:"8px 14px",fontSize:13,cursor:"pointer",fontFamily:FONT}}>{uploading?"Yükleniyor…":form.photo?"📷 Değiştir":"📷 Fotoğraf Ekle"}</button>
              {form.photo&&<button onClick={()=>set("photo",null)} style={{background:"transparent",border:"1px solid #fca5a5",borderRadius:8,color:"#ef4444",padding:"8px 11px",fontSize:13,cursor:"pointer"}}>🗑</button>}
            </div>
          </div>
          <div><label style={lbl}>AD SOYAD *</label><input style={inp} placeholder="Örn: Ahmet Yılmaz" value={form.name} onChange={e=>set("name",e.target.value)} onKeyDown={e=>e.key==="Enter"&&handleSave()}/></div>
          <div><label style={lbl}>CİNSİYET</label>
            <div style={{display:"flex",gap:10}}>
              {["male","female"].map(g=>(
                <button key={g} onClick={()=>set("gender",g)} style={{flex:1,padding:"11px",borderRadius:10,cursor:"pointer",fontSize:15,background:form.gender===g?(g==="male"?C.male:C.female)+"22":"transparent",border:"2px solid "+(form.gender===g?(g==="male"?C.male:C.female):"#e2e8f0"),color:form.gender===g?(g==="male"?C.male:C.female):"#64748b",fontFamily:FONT,fontWeight:600}}>
                  {g==="male"?"♂ Erkek":"♀ Kadın"}
                </button>
              ))}
            </div>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
            <div><label style={lbl}>DOĞUM YILI</label><input style={inp} placeholder="1980" value={form.born} onChange={e=>set("born",e.target.value)}/></div>
            <div><label style={lbl}>ÖLÜM YILI</label><input style={inp} placeholder="—" value={form.died} onChange={e=>set("died",e.target.value)}/></div>
          </div>
          <div style={{display:"flex",gap:10,marginTop:4}}>
            <button onClick={handleSave} disabled={!form.name.trim()} style={{flex:1,background:"#6366f1",border:"1px solid #6366f1",borderRadius:10,color:"#ffffff",padding:"13px",fontSize:15,cursor:"pointer",fontWeight:700,opacity:form.name.trim()?1:0.5,fontFamily:FONT}}>{isEdit?"💾 Güncelle":"✓ Ekle"}</button>
            <button onClick={onClose} style={{flex:1,background:"transparent",border:"1px solid #e2e8f0",borderRadius:10,color:"#1e293b",padding:"13px",fontSize:15,cursor:"pointer",fontFamily:FONT}}>İptal</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Relation Modal (Add / Edit) ──────────────────────────────────────────────
function RelModal({rel,people,onSave,onClose}) {
  const isEdit=!!rel;
  const [form,setForm]=useState({type:rel?.type||"spouse",p1:rel?.p1||"",p2:rel?.p2||""});
  const set=(k,v)=>setForm(f=>({...f,[k]:v}));
  const relDef=RMAP[form.type]||{};

  // Build rich label for a person
  const richLabel=(id)=>{
    const p=people.find(x=>x.id===id); if(!p) return "";
    const parents=people.filter(par=>
      people.__rels&&people.__rels.some(r=>r.type==="parent"&&r.p1===par.id&&r.p2===p.id)
    );
    const parts=[];
    if(p.born) parts.push(p.born);
    if(parents.length>0) parts.push(parents.map(x=>x.name).join("/")+` çoc.`);
    const extra=parts.length>0?" ("+parts.join(", ")+")":"";
    return (p.gender==="male"?"♂ ":"♀ ")+p.name+extra;
  };

  // Simpler: just show name + born for disambiguation
  const optLabel=(p)=>{
    const sames=people.filter(x=>x.name===p.name);
    if(sames.length<=1) return (p.gender==="male"?"♂ ":"♀ ")+p.name;
    const parts=[];
    if(p.born) parts.push(p.born);
    if(p.died) parts.push("✝"+p.died);
    return (p.gender==="male"?"♂ ":"♀ ")+p.name+(parts.length?" ("+parts.join(", ")+")":"");
  };

  const inp={background:"#f8faff",border:"1px solid #e2e8f0",borderRadius:8,color:"#1e293b",padding:"11px 13px",fontSize:15,outline:"none",width:"100%",fontFamily:FONT};
  const lbl={fontSize:12,color:"#64748b",display:"block",marginBottom:6,fontWeight:500};
  const handleSave=()=>{ if(!form.p1||!form.p2||form.p1===form.p2) return; onSave(form); };

  return (
    <div style={{position:"fixed",inset:0,background:"#00000099",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000,padding:16}}>
      <div style={{background:"#ffffff",border:"1px solid #e2e8f0",borderRadius:20,width:"100%",maxWidth:420,overflow:"auto",maxHeight:"90vh",boxShadow:"0 8px 32px rgba(99,102,241,0.15)"}}>
        <div style={{padding:"16px 18px",borderBottom:"1px solid #e2e8f0",display:"flex",alignItems:"center",justifyContent:"space-between",position:"sticky",top:0,background:"#ffffff",zIndex:1,borderRadius:"20px 20px 0 0"}}>
          <span style={{fontSize:16,fontWeight:700,color:"#6366f1",fontFamily:FONT}}>{isEdit?"✏️ İlişkiyi Düzenle":"➕ Yeni İlişki"}</span>
          <button onClick={onClose} style={{background:"transparent",border:"none",color:"#64748b",fontSize:24,cursor:"pointer"}}>✕</button>
        </div>
        <div style={{padding:"18px",display:"flex",flexDirection:"column",gap:14}}>
          <div><label style={lbl}>İLİŞKİ TÜRÜ</label>
            <select style={inp} value={form.type} onChange={e=>set("type",e.target.value)}>
              {REL_DEFS.map(rd=><option key={rd.value} value={rd.value}>{rd.icon} {rd.label}</option>)}
            </select>
          </div>
          {relDef.bi&&<div style={{background:"#eef2ff",border:"1px solid #c7d2fe",borderRadius:10,padding:"10px 13px",fontSize:13,color:"#4f46e5",fontFamily:FONT}}>ℹ️ Çift yönlü — tek kez tanımlamanız yeterlidir.</div>}
          <div><label style={lbl}>{relDef.bi?"KİŞİ 1 ":"ÜSTTEKI (Ebeveyn / Büyükanne / Amca vb.)"}</label>
            <SearchSelect
              value={form.p1}
              onChange={v=>set("p1",v)}
              placeholder="Kişi seçin veya arayın…"
              options={people.map(p=>({value:p.id,label:optLabel(p)}))}
            />
          </div>
          <div><label style={lbl}>{relDef.bi?"KİŞİ 2":"ALTTAKİ (Çocuk / Torun / Yeğen vb.)"}</label>
            <SearchSelect
              value={form.p2}
              onChange={v=>set("p2",v)}
              placeholder="Kişi seçin veya arayın…"
              options={people.filter(p=>p.id!==form.p1).map(p=>({value:p.id,label:optLabel(p)}))}
            />
          </div>
          <div style={{display:"flex",gap:10,marginTop:4}}>
            <button onClick={handleSave} disabled={!form.p1||!form.p2||form.p1===form.p2} style={{flex:1,background:"#6366f1",border:"1px solid #6366f1",borderRadius:10,color:"#ffffff",padding:"13px",fontSize:15,cursor:"pointer",fontWeight:700,opacity:(form.p1&&form.p2&&form.p1!==form.p2)?1:0.5,fontFamily:FONT}}>{isEdit?"💾 Güncelle":"✓ Ekle"}</button>
            <button onClick={onClose} style={{flex:1,background:"transparent",border:"1px solid #e2e8f0",borderRadius:10,color:"#1e293b",padding:"13px",fontSize:15,cursor:"pointer",fontFamily:FONT}}>İptal</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Confirm ──────────────────────────────────────────────────────────────────
function Confirm({message,onYes,onNo}) {
  return (
    <div style={{position:"fixed",inset:0,background:"#00000088",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1001,padding:20}}>
      <div style={{background:"#ffffff",border:"1px solid #e2e8f0",borderRadius:18,padding:26,maxWidth:340,width:"100%",boxShadow:"0 8px 32px rgba(0,0,0,0.12)"}}>
        <div style={{fontSize:15,marginBottom:22,color:"#1e293b",lineHeight:1.6,fontFamily:FONT}}>{message}</div>
        <div style={{display:"flex",gap:10}}>
          <button onClick={onYes} style={{flex:1,background:"#fee2e2",border:"1px solid #ef4444",borderRadius:9,color:"#ef4444",padding:"11px",fontSize:14,cursor:"pointer",fontFamily:FONT,fontWeight:600}}>Evet, Sil</button>
          <button onClick={onNo}  style={{flex:1,background:"transparent",border:"1px solid #e2e8f0",borderRadius:9,color:"#1e293b",padding:"11px",fontSize:14,cursor:"pointer",fontFamily:FONT}}>İptal</button>
        </div>
      </div>
    </div>
  );
}

// ─── Print helpers ────────────────────────────────────────────────────────────
function buildTreeSVGString(people,rels) {
  const {pos}=buildLayout(people,rels);
  const xs=Object.values(pos).map(p=>p.x),ys=Object.values(pos).map(p=>p.y);
  if(!xs.length) return null;
  const pad=30,minX=Math.min(...xs)-NW/2-pad,minY=Math.min(...ys)-NH/2-pad;
  const maxX=Math.max(...xs)+NW/2+pad,maxY=Math.max(...ys)+NH/2+pad;
  const W=maxX-minX,H=maxY-minY;
  const drawn=new Set(); const svgLines=[];
  rels.forEach(r=>{
    const a=pos[r.p1],b=pos[r.p2]; if(!a||!b) return;
    const def=RMAP[r.type]||{},col=def.color||"#94a3b8";
    if(HORIZONTAL.has(r.type)){ const key=[r.p1,r.p2].sort().join("|")+r.type; if(drawn.has(key)) return; drawn.add(key); const dash=r.type==="spouse"?"5,3":""; svgLines.push('<line x1="'+a.x+'" y1="'+a.y+'" x2="'+b.x+'" y2="'+b.y+'" stroke="'+col+'" stroke-width="2" stroke-dasharray="'+dash+'" opacity="0.8"/>'); if(r.type==="spouse") svgLines.push('<text x="'+((a.x+b.x)/2)+'" y="'+((a.y+b.y)/2-5)+'" text-anchor="middle" font-size="12" fill="'+col+'">♥</text>'); }
    else if(VERTICAL.has(r.type)){ const cy=(a.y+b.y)/2; const dash=r.type==="grandparent"?"7,4":r.type==="uncle"?"3,3":""; svgLines.push('<path d="M'+a.x+','+(a.y+NH/2)+' C'+a.x+','+(cy+18)+' '+b.x+','+(cy-18)+' '+b.x+','+(b.y-NH/2)+'" fill="none" stroke="'+col+'" stroke-width="2" stroke-dasharray="'+dash+'" opacity="0.85"/>'); }
  });
  people.forEach(p=>{ const pt=pos[p.id]; if(!pt) return; const col=p.gender==="male"?"#3b82f6":"#ec4899"; const cl=p.gender==="male"?"#dbeafe":"#fce7f3"; const x=pt.x-NW/2,y=pt.y-NH/2; const isDead=!!p.died; const cid="cpr-"+p.id;
    svgLines.push('<defs><clipPath id="'+cid+'"><circle cx="'+pt.x+'" cy="'+(y+38)+'" r="25"/></clipPath></defs>');
    svgLines.push('<rect x="'+x+'" y="'+y+'" width="'+NW+'" height="'+NH+'" rx="14" fill="'+(isDead?"#f1f5f9":"#ffffff")+'" stroke="'+col+'" stroke-width="1.5" opacity="'+(isDead?0.65:1)+'"/>');
    svgLines.push('<rect x="'+x+'" y="'+y+'" width="'+NW+'" height="5" rx="2" fill="'+col+'"/>');
    if(p.photo){ svgLines.push('<image href="'+p.photo+'" x="'+(pt.x-25)+'" y="'+(y+13)+'" width="50" height="50" clip-path="url(#'+cid+')" preserveAspectRatio="xMidYMid slice"/>'); }
    else { svgLines.push('<circle cx="'+pt.x+'" cy="'+(y+38)+'" r="25" fill="'+cl+'" stroke="'+col+'" stroke-width="1.5"/>'); svgLines.push('<text x="'+pt.x+'" y="'+(y+46)+'" text-anchor="middle" fill="'+col+'" font-size="20" font-family="serif">'+(p.gender==="male"?"♂":"♀")+'</text>'); }
    svgLines.push('<circle cx="'+pt.x+'" cy="'+(y+38)+'" r="25" fill="none" stroke="'+col+'" stroke-width="1.5" opacity="0.5"/>');
    if(isDead) svgLines.push('<text x="'+(x+NW-12)+'" y="'+(y+18)+'" fill="#94a3b8" font-size="13">✝</text>');
    const nm=p.name.length>18?p.name.slice(0,17)+"…":p.name;
    svgLines.push('<text x="'+pt.x+'" y="'+(y+76)+'" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700" font-family="sans-serif">'+nm+'</text>');
    svgLines.push('<text x="'+pt.x+'" y="'+(y+92)+'" text-anchor="middle" fill="#64748b" font-size="10" font-family="sans-serif">'+(p.born||"?")+(p.died?" – "+p.died:"")+'</text>');
  });
  return {svgString:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="'+minX+' '+minY+' '+W+' '+H+'" width="'+W+'" height="'+H+'">'+svgLines.join("")+"</svg>",W,H};
}

async function svgToDataUrl(svgString) {
  return new Promise((res,rej)=>{ const blob=new Blob([svgString],{type:"image/svg+xml"}); const url=URL.createObjectURL(blob); const img=new Image(); img.onload=()=>{ const scale=Math.min(2400/img.naturalWidth,1600/img.naturalHeight,2); const canvas=document.createElement("canvas"); canvas.width=img.naturalWidth*scale; canvas.height=img.naturalHeight*scale; const ctx=canvas.getContext("2d"); ctx.fillStyle="#f0f4ff"; ctx.fillRect(0,0,canvas.width,canvas.height); ctx.scale(scale,scale); ctx.drawImage(img,0,0); URL.revokeObjectURL(url); res(canvas.toDataURL("image/png")); }; img.onerror=rej; img.src=url; });
}

function buildPrintHTML(tree, treeImg) {
  const people = tree.people || [], rels = tree.rels || [];
  const today = new Date().toLocaleDateString("tr-TR", {day:"2-digit", month:"long", year:"numeric"});
  const imgHtml = treeImg
    ? '<img src="' + treeImg + '" style="width:100%;height:auto;object-fit:contain;display:block;"/>'
    : '<p style="text-align:center;color:#999;padding:40px 0">Diyagram oluşturulamadı</p>';
  return [
    '<!DOCTYPE html>',
    '<html lang="tr">',
    '<head>',
    '<meta charset="UTF-8"/>',
    '<title>' + tree.name + ' — Soy Ağacı</title>',
    '<style>',
    '  * { box-sizing: border-box; margin: 0; padding: 0; font-family: sans-serif; }',
    '  body { background: white; }',
    '  .page {',
    '    padding: 10mm 12mm;',
    '    display: flex;',
    '    flex-direction: column;',
    '    align-items: center;',
    '  }',
    '  .header { text-align: center; margin-bottom: 8mm; width: 100%; }',
    '  .header h1 { font-size: 20pt; font-weight: 700; color: #1e293b; }',
    '  .header p  { font-size: 9pt; color: #64748b; margin-top: 3px; }',
    '  .divider { border: none; border-top: 1px solid #d1d9f0; width: 100%; margin-bottom: 8mm; }',
    '  .diagram { width: 100%; }',
    '  .footer { font-size: 8pt; color: #94a3b8; text-align: right; margin-top: 6mm; width: 100%; }',
    '  @media print {',
    '    @page { margin: 6mm; size: A4 landscape; }',
    '  }',
    '</style>',
    '</head>',
    '<body>',
    '  <div class="page">',
    '    <div class="header">',
    '      <h1>' + tree.name + '</h1>',
    '      <p>Soy Ağacı &middot; ' + today + ' &middot; ' + people.length + ' kişi</p>',
    '    </div>',
    '    <hr class="divider"/>',
    '    <div class="diagram">' + imgHtml + '</div>',
    '    <div class="footer">Yazdırıldı: ' + today + '</div>',
    '  </div>',
    '  <script>',
    '    window.onload = function() {',
    '      window.print();',
    '      window.onafterprint = function() { window.close(); };',
    '    };',
    '  <\/script>',
    '</body>',
    '</html>'
  ].join("\n");
}
function PrintModal({tree,onClose}) {
  const [generating,setGenerating]=useState(false);
  const [ready,setReady]=useState(false);
  const treeImgRef=useRef(null);
  const people=tree.people||[],rels=tree.rels||[];
  useEffect(()=>{ (async()=>{ setGenerating(true); try { const r=buildTreeSVGString(people,rels); if(r) treeImgRef.current=await svgToDataUrl(r.svgString); } catch(e){console.error(e);} setGenerating(false); setReady(true); })(); },[]);
  const handlePrint=()=>{ const html=buildPrintHTML(tree,treeImgRef.current); const w=window.open("","_blank","width=900,height=700"); if(!w){alert("Lütfen popup engelleyiciyi kapatın.");return;} w.document.write(html); w.document.close(); };
  return (
    <div style={{position:"fixed",inset:0,background:"#00000099",display:"flex",alignItems:"flex-end",justifyContent:"center",zIndex:1002}}>
      <div style={{background:"#ffffff",border:"1px solid #e2e8f0",borderRadius:"20px 20px 0 0",width:"100%",maxWidth:520,maxHeight:"80vh",overflow:"auto",paddingBottom:"env(safe-area-inset-bottom)"}}>
        <div style={{display:"flex",justifyContent:"center",padding:"12px 0 0"}}><div style={{width:40,height:4,borderRadius:2,background:"#d1d9f0"}}/></div>
        <div style={{padding:"12px 18px 8px",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <span style={{fontSize:16,fontWeight:700,color:"#6366f1",fontFamily:FONT}}>🖨️ Yazdır / PDF Kaydet</span>
          <button onClick={onClose} style={{background:"transparent",border:"none",color:"#64748b",fontSize:24,cursor:"pointer"}}>✕</button>
        </div>
        <div style={{padding:"0 16px 18px",display:"flex",flexDirection:"column",gap:12}}>
          <div style={{background:"#f8faff",borderRadius:12,padding:14}}>
            <div style={{fontSize:14,fontWeight:700,color:"#1e293b",marginBottom:10,fontFamily:FONT}}>{tree.name}</div>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:5}}>
              <span style={{fontSize:18}}>🌳</span>
              <span style={{color:"#6366f1",fontSize:14,fontWeight:600,fontFamily:FONT}}>Soy Ağacı Diyagramı</span>
            </div>
            <div style={{fontSize:13,color:"#64748b",fontFamily:FONT,marginTop:4}}>{people.length} kişi · Yatay A4 · Tek sayfa</div>
          </div>
          {generating?<div style={{textAlign:"center",color:"#64748b",fontSize:14,fontFamily:FONT}}>🔄 Diyagram hazırlanıyor…</div>:<div style={{textAlign:"center",color:"#10b981",fontSize:14,fontFamily:FONT}}>✓ Hazır</div>}
          <div style={{background:"#eef2ff",border:"1px solid #c7d2fe",borderRadius:10,padding:"11px 14px",fontSize:13,color:"#4f46e5",lineHeight:1.6,fontFamily:FONT}}>💡 Açılan pencerede print diyaloğu başlar. <strong>"PDF Olarak Kaydet"</strong> seçin.</div>
          <button onClick={handlePrint} disabled={generating} style={{background:generating?"#c7d2fe":"#6366f1",border:"1px solid #6366f1",borderRadius:12,color:"#ffffff",padding:"15px",fontSize:16,cursor:generating?"not-allowed":"pointer",fontWeight:700,width:"100%",fontFamily:FONT}}>{generating?"🔄 Hazırlanıyor…":"🖨️ Yazdır / PDF Kaydet"}</button>
        </div>
      </div>
    </div>
  );
}

// ─── Tree Editor ──────────────────────────────────────────────────────────────
function TreeEditor({tree,onSave,onBack}) {
  const [treeName,setTreeName]=useState(tree.name||"");
  const [people,setPeople]=useState(tree.people||[]);
  const [rels,setRels]=useState(tree.rels||[]);
  const [tab,setTab]=useState("ağaç");
  const [selId,setSelId]=useState(null);
  const [saving,setSaving]=useState(false);
  const [saved,setSaved]=useState(false);
  const [personModal,setPersonModal]=useState(null);
  const [relModal,setRelModal]=useState(null);
  const [confirmPerson,setConfirmPerson]=useState(null);
  const [confirmRel,setConfirmRel]=useState(null);
  const [showPrint,setShowPrint]=useState(false);
  const [peopleSearch,setPeopleSearch]=useState("");
  const [relsSearch,setRelsSearch]=useState("");

  const selPerson=people.find(p=>p.id===selId);
  const filteredPeople=peopleSearch.trim()
    ? people.filter(p=>p.name.toLowerCase().includes(peopleSearch.toLowerCase())||(p.born||"").includes(peopleSearch))
    : people;
  const filteredRels=relsSearch.trim()
    ? rels.filter(r=>{
        const n1=(people.find(p=>p.id===r.p1)||{}).name||"";
        const n2=(people.find(p=>p.id===r.p2)||{}).name||"";
        const lbl=(RMAP[r.type]||{}).label||"";
        return [n1,n2,lbl].some(s=>s.toLowerCase().includes(relsSearch.toLowerCase()));
      })
    : rels;

  // Attach rels to people for label disambiguation
  const peopleWithRels=[...people];
  peopleWithRels.__rels=rels;

  const openAddPerson=()=>setPersonModal("new");
  const openEditPerson=p=>setPersonModal(p);
  const handleSavePerson=data=>{ if(personModal==="new") setPeople(prev=>[...prev,{...data,id:String(Date.now())}]); else setPeople(prev=>prev.map(p=>p.id===personModal.id?{...p,...data}:p)); setPersonModal(null); };
  const delPerson=id=>{ setPeople(prev=>prev.filter(p=>p.id!==id)); setRels(prev=>prev.filter(r=>r.p1!==id&&r.p2!==id)); if(selId===id) setSelId(null); setConfirmPerson(null); };

  const openAddRel=()=>setRelModal("new");
  const openEditRel=r=>setRelModal(r);
  const handleSaveRel=data=>{ if(relModal==="new"){ const dup=rels.some(r=>r.type===data.type&&((r.p1===data.p1&&r.p2===data.p2)||(r.p1===data.p2&&r.p2===data.p1))); if(!dup) setRels(prev=>[...prev,{...data,id:"r"+Date.now()}]); } else { setRels(prev=>prev.map(r=>r.id===relModal.id?{...r,...data}:r)); } setRelModal(null); };
  const delRel=id=>{ setRels(prev=>prev.filter(r=>r.id!==id)); setConfirmRel(null); };

  const pname=id=>(people.find(p=>p.id===id)||{}).name||"?";
  const optLabel=p=>{ const sames=people.filter(x=>x.name===p.name); if(sames.length<=1) return (p.gender==="male"?"♂ ":"♀ ")+p.name; const parts=[]; if(p.born) parts.push(p.born); if(p.died) parts.push("✝"+p.died); return (p.gender==="male"?"♂ ":"♀ ")+p.name+(parts.length?" ("+parts.join(", ")+")":""); };
  const handleSave=async()=>{ if(!treeName.trim()) return; setSaving(true); await onSave({...tree,name:treeName.trim(),people,rels,updatedAt:Date.now()}); setSaving(false); setSaved(true); setTimeout(()=>setSaved(false),2000); };

  const btn=(primary,small)=>({background:primary?"#6366f1":"transparent",border:"1px solid "+(primary?"#6366f1":"#e2e8f0"),borderRadius:9,color:primary?"#ffffff":"#1e293b",padding:small?"8px 13px":"11px 16px",fontSize:small?13:14,cursor:"pointer",fontFamily:FONT,fontWeight:primary?600:400});

  return (
    <div style={{display:"flex",flexDirection:"column",height:"100vh",background:"#f0f4ff",color:"#1e293b",overflow:"hidden",fontFamily:FONT}}>
      {/* Header */}
      <div style={{background:"#ffffff",borderBottom:"1px solid #e2e8f0",padding:"10px 14px",display:"flex",alignItems:"center",gap:8,flexShrink:0,boxShadow:"0 1px 3px rgba(0,0,0,0.06)"}}>
        <button onClick={onBack} style={{...btn(false,true),flexShrink:0}}>← Geri</button>
        <input value={treeName} onChange={e=>setTreeName(e.target.value)} placeholder="Ağaç adı…"
          style={{flex:1,background:"transparent",border:"none",borderBottom:"1px solid #e2e8f0",color:"#1e293b",fontSize:16,fontWeight:700,padding:"4px 2px",outline:"none",fontFamily:FONT,minWidth:0}}/>
        <button onClick={()=>setShowPrint(true)} style={{...btn(false,true),flexShrink:0}}>🖨️</button>
        <button onClick={handleSave} disabled={saving||!treeName.trim()} style={{background:saved?"#d1fae5":"#6366f1",border:"1px solid "+(saved?"#10b981":"#6366f1"),borderRadius:9,color:saved?"#10b981":"#ffffff",padding:"8px 13px",fontSize:13,cursor:"pointer",flexShrink:0,fontFamily:FONT,fontWeight:600,opacity:(!treeName.trim()||saving)?0.5:1}}>
          {saving?"…":saved?"✓ Kaydedildi":"💾 Kaydet"}
        </button>
      </div>
      {/* Tabs */}
      <div style={{display:"flex",background:"#ffffff",borderBottom:"1px solid #e2e8f0",flexShrink:0}}>
        {["ağaç","kişiler","ilişkiler"].map(t=>(
          <button key={t} onClick={()=>setTab(t)} style={{flex:1,background:tab===t?"#eef2ff":"transparent",border:"none",borderBottom:"3px solid "+(tab===t?"#6366f1":"transparent"),color:tab===t?"#6366f1":"#64748b",padding:"12px 4px",fontSize:14,cursor:"pointer",fontFamily:FONT,fontWeight:tab===t?"700":"400"}}>
            {t==="ağaç"?"🌳 Ağaç":t==="kişiler"?"👥 Kişiler":"🔗 İlişkiler"}
          </button>
        ))}
      </div>

      <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",minHeight:0}}>

        {/* ── Ağaç ── */}
        {tab==="ağaç"&&(
          <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",minHeight:0}}>
            <div style={{padding:"10px 12px 6px",display:"flex",gap:8,flexShrink:0}}>
              <button onClick={openAddPerson} style={{...btn(true,true),flex:1}}>+ Kişi Ekle</button>
              <button onClick={openAddRel}    style={{...btn(false,true),flex:1}}>+ İlişki Ekle</button>
            </div>
            <div style={{flex:1,margin:"0 10px",minHeight:0}}>
              <Canvas people={people} rels={rels} selId={selId} onSelect={id=>setSelId(id===selId?null:id)}/>
            </div>
            {selPerson&&(
              <div style={{margin:"8px 10px",background:"#ffffff",border:"1px solid #e2e8f0",borderRadius:14,padding:"12px 14px",display:"flex",alignItems:"center",gap:12,flexShrink:0,boxShadow:"0 2px 8px rgba(99,102,241,0.07)"}}>
                <div style={{width:46,height:46,borderRadius:"50%",flexShrink:0,overflow:"hidden",border:"2px solid "+(selPerson.gender==="male"?C.male:C.female),background:(selPerson.gender==="male"?"#dbeafe":"#fce7f3"),display:"flex",alignItems:"center",justifyContent:"center",fontSize:20}}>
                  {selPerson.photo?<img src={selPerson.photo} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>:(selPerson.gender==="male"?"♂":"♀")}
                </div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontWeight:700,fontSize:15,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{selPerson.name}</div>
                  <div style={{fontSize:12,color:"#64748b",marginTop:2}}>{selPerson.born&&"Doğum: "+selPerson.born}{selPerson.died&&" · Ölüm: "+selPerson.died+" ✝"}</div>
                </div>
                <button onClick={()=>openEditPerson(selPerson)} style={{background:"#eef2ff",border:"1px solid #a5b4fc",borderRadius:8,color:"#6366f1",padding:"7px 11px",fontSize:14,cursor:"pointer"}}>✏️</button>
                <button onClick={()=>setSelId(null)} style={{background:"transparent",border:"none",color:"#64748b",fontSize:20,cursor:"pointer"}}>✕</button>
              </div>
            )}
            <div style={{height:8,flexShrink:0}}/>
          </div>
        )}

        {/* ── Kişiler ── */}
        {tab==="kişiler"&&(
          <div style={{flex:1,overflow:"auto",padding:14}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
              <span style={{fontSize:14,color:"#64748b",fontWeight:600}}>👥 KİŞİLER ({people.length})</span>
              <button onClick={openAddPerson} style={btn(true,true)}>+ Yeni Kişi</button>
            </div>
            <div style={{position:"relative",marginBottom:10}}>
              <span style={{position:"absolute",left:11,top:"50%",transform:"translateY(-50%)",color:"#94a3b8",fontSize:15,pointerEvents:"none"}}>🔍</span>
              <input
                value={peopleSearch} onChange={e=>setPeopleSearch(e.target.value)}
                placeholder="İsme göre ara…"
                style={{background:"#ffffff",border:"1px solid #e2e8f0",borderRadius:9,color:"#1e293b",padding:"9px 12px 9px 34px",fontSize:14,outline:"none",width:"100%",fontFamily:FONT}}
              />
              {peopleSearch&&<button onClick={()=>setPeopleSearch("")} style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",background:"transparent",border:"none",color:"#94a3b8",cursor:"pointer",fontSize:16,lineHeight:1}}>✕</button>}
            </div>
            {filteredPeople.length===0&&peopleSearch&&<div style={{textAlign:"center",color:"#94a3b8",padding:"20px 0",fontSize:14}}>"{peopleSearch}" için sonuç yok</div>}
            <div style={{fontSize:12,color:"#94a3b8",marginBottom:8,display:"flex",alignItems:"center",gap:6}}>
              <span>⠿</span> Sürükle-bırak ile sırala
            </div>
            <DragList
              items={filteredPeople}
              onReorder={filtered=>{
                // Merge filtered reorder back into full list preserving non-filtered order
                if(!peopleSearch.trim()){ setPeople(filtered); return; }
                const filteredIds=filtered.map(p=>p.id);
                const rest=people.filter(p=>!filteredIds.includes(p.id));
                // Re-insert filtered at their original positions
                const newList=[...people];
                let fi=0;
                newList.forEach((_,i)=>{ if(filteredIds.includes(newList[i].id)){ newList[i]=filtered[fi++]; } });
                setPeople(newList);
              }}
              renderItem={(p)=>(
                <div style={{background:"#ffffff",border:"1px solid "+(selId===p.id?"#6366f1":"#e2e8f0"),borderRadius:12,padding:"12px 14px",display:"flex",alignItems:"center",gap:12,cursor:"pointer",boxShadow:"0 1px 4px rgba(99,102,241,0.05)"}} onClick={()=>setSelId(p.id===selId?null:p.id)}>
                  <span style={{color:"#d1d9f0",fontSize:18,cursor:"grab",flexShrink:0}}>⠿</span>
                  <div style={{width:40,height:40,borderRadius:"50%",flexShrink:0,overflow:"hidden",border:"2px solid "+(p.gender==="male"?C.male:C.female),background:(p.gender==="male"?"#dbeafe":"#fce7f3"),display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>
                    {p.photo?<img src={p.photo} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>:(p.gender==="male"?"♂":"♀")}
                  </div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:14,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                      {p.name}{p.died&&<span style={{color:"#94a3b8",marginLeft:6,fontSize:12}}>✝</span>}
                      {(()=>{ const hp=new Set(rels.filter(r=>r.type==="parent").map(r=>r.p2)); const hs=new Set([...rels.filter(r=>r.type==="spouse").map(r=>r.p1),...rels.filter(r=>r.type==="spouse").map(r=>r.p2)]); return hs.has(p.id)&&!hp.has(p.id)?<span style={{background:"#fef3c7",border:"1px solid #fcd34d",borderRadius:4,fontSize:10,color:"#92400e",padding:"1px 5px",marginLeft:6,fontWeight:500}}>dışarıdan</span>:null; })()}
                    </div>
                    <div style={{fontSize:12,color:"#64748b",marginTop:1}}>{p.born||"?"}{p.died?" – "+p.died:""}</div>
                  </div>
                  <div style={{display:"flex",gap:6}} onClick={e=>e.stopPropagation()}>
                    <button onClick={()=>openEditPerson(p)} style={{background:"#eef2ff",border:"1px solid #a5b4fc",borderRadius:8,color:"#6366f1",padding:"6px 10px",fontSize:14,cursor:"pointer"}}>✏️</button>
                    <button onClick={()=>setConfirmPerson(p.id)} style={{background:"#fef2f2",border:"1px solid #fca5a5",borderRadius:8,color:"#ef4444",padding:"6px 10px",fontSize:14,cursor:"pointer"}}>🗑</button>
                  </div>
                </div>
              )}
            />
          </div>
        )}

        {/* ── İlişkiler ── */}
        {tab==="ilişkiler"&&(
          <div style={{flex:1,overflow:"auto",padding:14}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
              <span style={{fontSize:14,color:"#64748b",fontWeight:600}}>🔗 İLİŞKİLER ({rels.length})</span>
              <button onClick={openAddRel} style={btn(true,true)}>+ Yeni İlişki</button>
            </div>
            <div style={{position:"relative",marginBottom:10}}>
              <span style={{position:"absolute",left:11,top:"50%",transform:"translateY(-50%)",color:"#94a3b8",fontSize:15,pointerEvents:"none"}}>🔍</span>
              <input
                value={relsSearch} onChange={e=>setRelsSearch(e.target.value)}
                placeholder="İsim veya ilişki türü ara…"
                style={{background:"#ffffff",border:"1px solid #e2e8f0",borderRadius:9,color:"#1e293b",padding:"9px 12px 9px 34px",fontSize:14,outline:"none",width:"100%",fontFamily:FONT}}
              />
              {relsSearch&&<button onClick={()=>setRelsSearch("")} style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",background:"transparent",border:"none",color:"#94a3b8",cursor:"pointer",fontSize:16,lineHeight:1}}>✕</button>}
            </div>
            {filteredRels.length===0&&relsSearch&&<div style={{textAlign:"center",color:"#94a3b8",padding:"20px 0",fontSize:14}}>"{relsSearch}" için sonuç yok</div>}
            <div style={{fontSize:12,color:"#94a3b8",marginBottom:8,display:"flex",alignItems:"center",gap:6}}>
              <span>⠿</span> Sürükle-bırak ile sırala
            </div>
            <DragList
              items={filteredRels}
              onReorder={filtered=>{
                if(!relsSearch.trim()){ setRels(filtered); return; }
                const filteredIds=filtered.map(r=>r.id);
                const newList=[...rels];
                let fi=0;
                newList.forEach((_,i)=>{ if(filteredIds.includes(newList[i].id)){ newList[i]=filtered[fi++]; } });
                setRels(newList);
              }}
              renderItem={(r)=>{ const d=RMAP[r.type]||{}; return(
                <div style={{background:"#ffffff",border:"1px solid #e2e8f0",borderRadius:12,padding:"12px 14px",display:"flex",alignItems:"center",gap:10,boxShadow:"0 1px 4px rgba(99,102,241,0.05)"}}>
                  <span style={{color:"#d1d9f0",fontSize:18,cursor:"grab",flexShrink:0}}>⠿</span>
                  <span style={{fontSize:20,flexShrink:0}}>{d.icon||"🔗"}</span>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:14,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                      {optLabel(people.find(p=>p.id===r.p1)||{name:"?",gender:"male"})}
                      {" "}<span style={{color:d.color||"#6366f1",fontSize:12}}>{d.bi?"↔":"→"}</span>{" "}
                      {optLabel(people.find(p=>p.id===r.p2)||{name:"?",gender:"male"})}
                    </div>
                    <div style={{fontSize:12,color:d.color||"#64748b",marginTop:2,fontWeight:500}}>{d.label||r.type}</div>
                  </div>
                  <div style={{display:"flex",gap:6}}>
                    <button onClick={()=>openEditRel(r)} style={{background:"#eef2ff",border:"1px solid #a5b4fc",borderRadius:8,color:"#6366f1",padding:"6px 10px",fontSize:14,cursor:"pointer"}}>✏️</button>
                    <button onClick={()=>setConfirmRel(r.id)} style={{background:"#fef2f2",border:"1px solid #fca5a5",borderRadius:8,color:"#ef4444",padding:"6px 10px",fontSize:14,cursor:"pointer"}}>🗑</button>
                  </div>
                </div>
              ); }}
            />
          </div>
        )}
      </div>

      {personModal&&<PersonModal person={personModal==="new"?null:personModal} onSave={handleSavePerson} onClose={()=>setPersonModal(null)}/>}
      {relModal&&<RelModal rel={relModal==="new"?null:relModal} people={peopleWithRels} onSave={handleSaveRel} onClose={()=>setRelModal(null)}/>}
      {confirmPerson&&<Confirm message={'"'+(people.find(p=>p.id===confirmPerson)||{}).name+'" silinsin mi?'} onYes={()=>delPerson(confirmPerson)} onNo={()=>setConfirmPerson(null)}/>}
      {confirmRel&&<Confirm message="Bu ilişkiyi silmek istediğinizden emin misiniz?" onYes={()=>delRel(confirmRel)} onNo={()=>setConfirmRel(null)}/>}
      {showPrint&&<PrintModal tree={{name:treeName,people,rels}} onClose={()=>setShowPrint(false)}/>}
    </div>
  );
}

// ─── Home ─────────────────────────────────────────────────────────────────────
function Home({trees,loading,onOpen,onCreate,onDelete,onImport,onExport}) {
  const [confirmId,setConfirmId]=useState(null);
  const [newName,setNewName]=useState("");
  const [view,setView]=useState("list");
  const [importErr,setImportErr]=useState("");
  const [importing,setImporting]=useState(false);
  const importRef=useRef(null);
  const fmt=ts=>ts?new Date(ts).toLocaleDateString("tr-TR",{day:"2-digit",month:"short",year:"numeric"}):"";
  const handleCreate=()=>{ if(!newName.trim()) return; onCreate(newName.trim()); setNewName(""); setView("list"); };
  const handleImport=async e=>{ const file=e.target.files?.[0]; if(!file) return; setImporting(true); setImportErr(""); try { const d=await importTreeFile(file); await onImport(d); } catch(err){ setImportErr(err.message); } setImporting(false); e.target.value=""; };

  return (
    <div style={{display:"flex",flexDirection:"column",height:"100vh",background:"#f0f4ff",color:"#1e293b",fontFamily:FONT}}>
      {/* Header */}
      <div style={{background:"#ffffff",borderBottom:"1px solid #e2e8f0",padding:"14px 18px",display:"flex",alignItems:"center",gap:12,flexShrink:0,boxShadow:"0 1px 3px rgba(0,0,0,0.06)"}}>
        <span style={{fontSize:26}}>🌳</span>
        <div>
          <div style={{fontSize:19,fontWeight:700,color:"#6366f1",fontFamily:FONT}}>SOY AĞACI</div>
          <div style={{fontSize:11,color:"#94a3b8",letterSpacing:"0.08em"}}>AİLE BAĞLARI HARİTASI</div>
        </div>
        <div style={{marginLeft:"auto",fontSize:13,color:"#64748b",fontWeight:500}}>{trees.length} proje</div>
      </div>
      {/* Action bar */}
      <div style={{background:"#ffffff",borderBottom:"1px solid #e2e8f0",padding:"12px 16px",display:"flex",gap:10,flexShrink:0}}>
        <button onClick={()=>setView(view==="new"?"list":"new")} style={{flex:1,background:view==="new"?"#4f46e5":"#6366f1",border:"1px solid #6366f1",borderRadius:12,color:"#ffffff",padding:"12px 8px",fontSize:14,cursor:"pointer",fontWeight:700,fontFamily:FONT}}>
          {view==="new"?"✕ İptal":"＋ Yeni Proje"}
        </button>
        <button onClick={()=>importRef.current?.click()} disabled={importing} style={{flex:1,background:"transparent",border:"1px solid #e2e8f0",borderRadius:12,color:"#64748b",padding:"12px 8px",fontSize:14,cursor:"pointer",fontFamily:FONT}}>
          {importing?"⏳ Yükleniyor…":"📥 İçe Aktar"}
        </button>
        <input ref={importRef} type="file" accept=".json,.ftree.json" style={{display:"none"}} onChange={handleImport}/>
      </div>

      <div style={{flex:1,overflow:"auto",padding:16}}>
        {view==="new"&&(
          <div style={{background:"#ffffff",border:"1px solid #a5b4fc",borderRadius:16,padding:18,marginBottom:18,boxShadow:"0 2px 12px rgba(99,102,241,0.1)"}}>
            <div style={{fontSize:14,color:"#6366f1",marginBottom:12,fontWeight:700}}>YENİ SOY AĞACI</div>
            <input autoFocus placeholder="Proje adı (örn: Yılmaz Ailesi)" value={newName}
              onChange={e=>setNewName(e.target.value)} onKeyDown={e=>e.key==="Enter"&&handleCreate()}
              style={{background:"#f8faff",border:"1px solid #e2e8f0",borderRadius:10,color:"#1e293b",padding:"13px 15px",fontSize:15,outline:"none",width:"100%",marginBottom:12,fontFamily:FONT}}/>
            <div style={{display:"flex",gap:10}}>
              <button onClick={handleCreate} disabled={!newName.trim()} style={{flex:1,background:"#6366f1",border:"1px solid #6366f1",borderRadius:10,color:"#ffffff",padding:"13px",fontSize:15,cursor:"pointer",fontWeight:700,opacity:newName.trim()?1:0.5,fontFamily:FONT}}>Oluştur</button>
              <button onClick={()=>{setView("list");setNewName("");}} style={{flex:1,background:"transparent",border:"1px solid #e2e8f0",borderRadius:10,color:"#1e293b",padding:"13px",fontSize:15,cursor:"pointer",fontFamily:FONT}}>İptal</button>
            </div>
          </div>
        )}
        {importErr&&(
          <div style={{background:"#fef2f2",border:"1px solid #fca5a5",borderRadius:10,padding:"12px 15px",marginBottom:14,fontSize:14,color:"#ef4444",display:"flex",justifyContent:"space-between",alignItems:"center",fontFamily:FONT}}>
            <span>⚠️ {importErr}</span>
            <button onClick={()=>setImportErr("")} style={{background:"transparent",border:"none",color:"#ef4444",cursor:"pointer",fontSize:18}}>✕</button>
          </div>
        )}
        {loading&&<div style={{textAlign:"center",color:"#64748b",padding:50,fontSize:15}}>Yükleniyor…</div>}
        {!loading&&trees.length===0&&view!=="new"&&(
          <div style={{textAlign:"center",padding:"60px 20px",color:"#94a3b8"}}>
            <div style={{fontSize:52,marginBottom:16}}>🌱</div>
            <div style={{fontSize:18,color:"#1e293b",marginBottom:8,fontWeight:700}}>Henüz proje yok</div>
            <div style={{fontSize:14,lineHeight:1.7}}>Yeni proje oluşturun<br/>veya dışa aktarılmış bir dosyayı içe aktarın.</div>
          </div>
        )}
        <div style={{display:"flex",flexDirection:"column",gap:12}}>
          {trees.map(tree=>{
            const avatars=[...(tree.people||[]).filter(p=>p.photo),...(tree.people||[]).filter(p=>!p.photo)].slice(0,3);
            return (
              <div key={tree.id} style={{background:"#ffffff",border:"1px solid #e2e8f0",borderRadius:16,overflow:"hidden",boxShadow:"0 2px 8px rgba(99,102,241,0.06)"}}>
                <div style={{padding:"16px",display:"flex",alignItems:"center",gap:14,cursor:"pointer"}} onClick={()=>onOpen(tree.id)}>
                  <div style={{position:"relative",width:avatars.length>1?50:38,height:38,flexShrink:0}}>
                    {avatars.length===0
                      ?<div style={{width:38,height:38,borderRadius:10,background:"#eef2ff",border:"1px solid #c7d2fe",display:"flex",alignItems:"center",justifyContent:"center",fontSize:22}}>🌳</div>
                      :avatars.map((p,i)=>(
                        <div key={p.id} style={{position:"absolute",left:i*12,top:i===1?5:0,width:32,height:32,borderRadius:"50%",overflow:"hidden",border:"2px solid #ffffff",background:(p.gender==="male"?"#dbeafe":"#fce7f3"),display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,zIndex:3-i}}>
                          {p.photo?<img src={p.photo} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>:(p.gender==="male"?"♂":"♀")}
                        </div>
                      ))
                    }
                  </div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:16,fontWeight:700,color:"#1e293b",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{tree.name}</div>
                    <div style={{fontSize:12,color:"#64748b",marginTop:3}}>{tree.people?.length||0} kişi · {tree.rels?.length||0} ilişki{tree.updatedAt?" · "+fmt(tree.updatedAt):""}</div>
                  </div>
                  <span style={{color:"#94a3b8",fontSize:20}}>›</span>
                </div>
                <div style={{borderTop:"1px solid #f1f5f9",display:"flex"}}>
                  <button onClick={()=>onOpen(tree.id)} style={{flex:1,background:"transparent",border:"none",borderRight:"1px solid #f1f5f9",color:"#6366f1",padding:"11px 0",fontSize:14,cursor:"pointer",fontFamily:FONT,fontWeight:500}}>✏️ Düzenle</button>
                  <button onClick={()=>onExport(tree)} style={{flex:1,background:"transparent",border:"none",borderRight:"1px solid #f1f5f9",color:"#64748b",padding:"11px 0",fontSize:14,cursor:"pointer",fontFamily:FONT}}>📤 Dışa Aktar</button>
                  <button onClick={()=>setConfirmId(tree.id)} style={{flex:1,background:"transparent",border:"none",color:"#ef4444",padding:"11px 0",fontSize:14,cursor:"pointer",fontFamily:FONT}}>🗑 Sil</button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {confirmId&&<Confirm message={'"'+(trees.find(t=>t.id===confirmId)||{}).name+'" silinsin mi?'} onYes={()=>{onDelete(confirmId);setConfirmId(null);}} onNo={()=>setConfirmId(null)}/>}
    </div>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────
export default function App() {
  const [trees,setTrees]=useState([]);
  const [openId,setOpenId]=useState(null);
  const [loading,setLoading]=useState(true);

  useEffect(()=>{ (async()=>{ setLoading(true); try { const keys=await storageList("tree:"); const loaded=await Promise.all(keys.map(k=>storageGet(k))); setTrees(loaded.filter(Boolean).sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0))); } catch(e){console.error(e);} setLoading(false); })(); },[]);

  const createTree=name=>{ const id="tree:"+Date.now(),now=Date.now(); const t={id,name,people:[],rels:[],createdAt:now,updatedAt:now}; setTrees(prev=>[t,...prev]); setOpenId(id); };
  const saveTree=async tree=>{ await storageSet(tree.id,tree); setTrees(prev=>{ const idx=prev.findIndex(t=>t.id===tree.id); const next=idx===-1?[tree,...prev]:prev.map(t=>t.id===tree.id?tree:t); return next.sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0)); }); };
  const deleteTree=async id=>{ await storageDel(id); setTrees(prev=>prev.filter(t=>t.id!==id)); if(openId===id) setOpenId(null); };
  const importTree=async data=>{ const id="tree:"+Date.now(),now=Date.now(); const tree={...data,id,updatedAt:now,importedAt:now}; await storageSet(id,tree); setTrees(prev=>[tree,...prev]); };

  const STYLE="@import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap');*{box-sizing:border-box}input::placeholder{color:#94a3b8}select option{background:#ffffff;color:#1e293b}::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:#f0f4ff}::-webkit-scrollbar-thumb{background:#c7d2f0;border-radius:3px}";
  const currentTree=trees.find(t=>t.id===openId);

  if(openId&&currentTree) return <div><style>{STYLE}</style><TreeEditor tree={currentTree} onSave={saveTree} onBack={()=>setOpenId(null)}/></div>;
  return <div><style>{STYLE}</style><Home trees={trees} loading={loading} onOpen={setOpenId} onCreate={createTree} onDelete={deleteTree} onImport={importTree} onExport={exportTree}/></div>;
}
