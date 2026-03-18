import { useState, useRef, useEffect, useCallback } from "react";

// ─── Theme ────────────────────────────────────────────────────────────────────
const C = {
  bg:"#f0f4ff", surface:"#ffffff", card:"#ffffff", border:"#d1d9f0",
  accent:"#6366f1", accentDim:"#4f46e5", gold:"#f59e0b",
  male:"#3b82f6", female:"#ec4899",
  text:"#1e293b", muted:"#64748b", line:"#94a3b8",
  danger:"#ef4444", success:"#10b981",
};
const NW=140, NH=230, MIN_GAP=20, VGAP=120;
const FONT = "'Poppins',sans-serif";

const REL_DEFS = [
  { value:"spouse", label:"Eşler",           icon:"💍", color:"#f59e0b", bi:true  },
  { value:"parent", label:"Ebeveyn → Çocuk", icon:"👨‍👧", color:"#6366f1", bi:false, autoSpouse:true },
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
  // AutoSpouse: if parent rel has autoSpouse flag, also register the parent's spouse
  // as co-parent — so user only needs to define the rel once per parent
  rels.forEach(({type,p1,p2})=>{
    if(type!=="parent") return;
    spouseOf[p1].forEach(sid=>{
      if(!childrenOf[sid].includes(p2)) childrenOf[sid].push(p2);
      if(!parentsOf[p2].includes(sid))  parentsOf[p2].push(sid);
    });
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

// ─── SVG Node ────────────────────────────────────────────────────────────────
function Node({person,p,sel,onClick,outsider}) {
  const col      = person.gender==="male" ? C.male : C.female;
  const normalBg = person.gender==="male" ? "#dbeafe" : "#fce7f3";
  const isDead   = !!person.died;

  // Layout
  const INFO_H  = 52;
  const PH      = NH - INFO_H;
  const cid = "ncp-"+person.id;
  const fid = "nsh-"+person.id;

  // Name split: first name / surname — both same size & bold
  const parts    = person.name.trim().split(" ");
  const surname  = parts.length > 1 ? parts[parts.length-1] : "";
  const firstName= parts.length > 1 ? parts.slice(0,-1).join(" ") : parts[0];
  const maxCh    = 14;
  const fn = firstName.length > maxCh ? firstName.slice(0,maxCh-1)+"…" : firstName;
  const sn = surname.length   > maxCh ? surname.slice(0,maxCh-1)+"…"  : surname;

  // Info area: deeper gender colour bg; outsider = darker
  const infoBg   = sel ? normalBg
    : outsider
      ? (person.gender==="male" ? "#bfdbfe" : "#fbcfe8")
      : (person.gender==="male" ? "#dbeafe" : "#fce7f3");
  const nameFill = "#1e293b";
  const yearFill = "#475569";

  return (
    <g transform={"translate("+(p.x-NW/2)+","+(p.y-NH/2)+")"} data-node="1"
       onClick={e=>{e.stopPropagation();onClick(person.id);}} style={{cursor:"pointer"}}>
      <defs>
        {/* Photo clip — top rounded corners only */}
        <clipPath id={cid}>
          {/* Top corners rounded (matches card), bottom straight */}
          <path d={"M14,0 L"+(NW-14)+",0 Q"+NW+",0 "+NW+",14 L"+NW+","+PH+" L0,"+PH+" L0,14 Q0,0 14,0 Z"}/>
        </clipPath>
        {/* Full card clip */}
        <clipPath id={"ncc-"+person.id}>
          <rect width={NW} height={NH} rx={14}/>
        </clipPath>
        {/* Drop shadow */}
        <filter id={fid} x="-25%" y="-25%" width="150%" height="150%">
          <feDropShadow dx="0" dy={sel?4:2} stdDeviation={sel?6:3}
            floodColor={sel?"#6366f1":col} floodOpacity={sel?0.32:0.16}/>
        </filter>
      </defs>

      {/* ── Card background (photo area white, info area = gender colour) ── */}
      <rect width={NW} height={NH} rx={14}
        fill="#ffffff"
        stroke={sel?"#6366f1":"#1e293b"}
        strokeWidth={sel?2.5:2}
        filter={"url(#"+fid+")"}
        opacity={isDead?0.72:1}/>
      {/* Info area — flat top, rounded bottom (matches card rx=14) */}
      <path d={"M0,"+PH+" L"+NW+","+PH+" L"+NW+","+(NH-14)+" Q"+NW+","+NH+" "+(NW-14)+","+NH+" L14,"+NH+" Q0,"+NH+" 0,"+(NH-14)+" Z"}
        fill={infoBg}/>

      {/* ── Photo area (top) ── */}
      {person.photo
        ? <image href={person.photo}
            x={0} y={0} width={NW} height={PH}
            clipPath={"url(#"+cid+")"}
            preserveAspectRatio="xMidYMid slice"/>
        : <>
            <rect x={0} y={0} width={NW} height={PH}
              fill={normalBg} clipPath={"url(#"+cid+")"}/>
            <text x={NW/2} y={PH*0.5} textAnchor="middle" dominantBaseline="middle"
              fill={col} fontSize={52} fontFamily="serif" opacity={0.4}>
              {person.gender==="male"?"♂":"♀"}
            </text>
          </>
      }
      {/* Vignette border on photo */}
      <rect x={0} y={0} width={NW} height={PH}
        fill="none" stroke={col} strokeWidth={2} strokeOpacity={0.2}
        clipPath={"url(#"+cid+")"}/>

      {/* ── Info area divider line ── */}
      <line x1={0} y1={PH} x2={NW} y2={PH}
        stroke="#1e293b" strokeWidth={2} opacity={0.15}/>

      {/* ── Info area (bottom) — gender colour background ── */}
      {surname
        ? <>
            {/* First name — same size & weight as surname */}
            <text x={NW/2} y={PH+14} textAnchor="middle"
              fill={nameFill} fontSize={11} fontWeight="700" fontFamily={FONT}>{fn}</text>
            <text x={NW/2} y={PH+28} textAnchor="middle"
              fill={nameFill} fontSize={11} fontWeight="700" fontFamily={FONT}>
              {sn}{isDead&&<tspan fill="#64748b" fontSize={9}> ✝</tspan>}
            </text>
            <text x={NW/2} y={PH+42} textAnchor="middle"
              fill={yearFill} fontSize={9} fontFamily={FONT}>
              {person.born||"?"}{person.died?" – "+person.died:""}
            </text>
          </>
        : <>
            <text x={NW/2} y={PH+18} textAnchor="middle"
              fill={nameFill} fontSize={11} fontWeight="700" fontFamily={FONT}>
              {fn}{isDead&&<tspan fill="#64748b" fontSize={9}> ✝</tspan>}
            </text>
            <text x={NW/2} y={PH+34} textAnchor="middle"
              fill={yearFill} fontSize={9} fontFamily={FONT}>
              {person.born||"?"}{person.died?" – "+person.died:""}
            </text>
          </>
      }



      {/* ── Selected ring ── */}
      {sel&&<rect width={NW} height={NH} rx={14} fill="none"
        stroke="#6366f1" strokeWidth={2.5} opacity={0.85}/>}
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

  // ── Draw edges — thick black lines ───────────────────────────────────────
  const LINE_COLOR  = "#1e293b";  // near-black
  const LINE_W      = 3;          // stroke width

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
        <line x1={a.x} y1={my} x2={b.x} y2={my}
          stroke={LINE_COLOR} strokeWidth={LINE_W} strokeDasharray="8 4" opacity={0.85}/>
        <circle cx={mx} cy={my} r={10} fill="#ffffff" stroke={LINE_COLOR} strokeWidth={LINE_W*0.7}/>
        <text x={mx} y={my+4} textAnchor="middle" fontSize={11} fill={LINE_COLOR}>♥</text>
      </g>
    );
  });

  // 2. Parent→child edges
  const drawnParent = new Set();
  rels.filter(r=>VERTICAL.has(r.type)).forEach(r=>{
    if(drawnParent.has(r.id)) return; drawnParent.add(r.id);
    const child=pos[r.p2]; if(!child) return;

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
        fill="none" stroke={LINE_COLOR} strokeWidth={LINE_W} opacity={0.85}/>
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
// ─── DragGrid — mouse + touch drag-to-reorder for grid layouts ───────────────
function DragGrid({items, onReorder, renderItem, columns}) {
  const [dragging, setDragging]   = useState(null);   // index being dragged
  const [overIdx,  setOverIdx]    = useState(null);   // index being hovered
  const [ghost,    setGhost]      = useState(null);   // {x,y,w,h} for floating ghost
  const containerRef = useRef(null);
  const itemRefs     = useRef({});
  const pointerStart = useRef(null); // {x,y,idx}

  // Helper: find grid index from pointer position
  const idxFromPoint = (cx, cy) => {
    let closest = null, closestDist = Infinity;
    Object.entries(itemRefs.current).forEach(([i, el]) => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      const mx = r.left + r.width/2, my = r.top + r.height/2;
      const d = Math.hypot(cx - mx, cy - my);
      if (d < closestDist) { closestDist = d; closest = +i; }
    });
    return closest;
  };

  const startDrag = (e, idx) => {
    e.preventDefault();
    const isTouch = e.touches != null;
    const cx = isTouch ? e.touches[0].clientX : e.clientX;
    const cy = isTouch ? e.touches[0].clientY : e.clientY;
    const el = itemRefs.current[idx];
    const r  = el ? el.getBoundingClientRect() : {left:cx,top:cy,width:160,height:80};
    pointerStart.current = { x:cx, y:cy, idx };
    setDragging(idx);
    setOverIdx(idx);
    setGhost({ x:r.left, y:r.top, w:r.width, h:r.height });
  };

  const moveDrag = useCallback((e) => {
    if (dragging === null) return;
    const isTouch = e.touches != null;
    const cx = isTouch ? e.touches[0].clientX : e.clientX;
    const cy = isTouch ? e.touches[0].clientY : e.clientY;
    setGhost(g => g ? { ...g, x: g.x + (cx - pointerStart.current.x), y: g.y + (cy - pointerStart.current.y) } : g);
    pointerStart.current.x = cx;
    pointerStart.current.y = cy;
    const over = idxFromPoint(cx, cy);
    if (over !== null) setOverIdx(over);
  }, [dragging]);

  const endDrag = useCallback(() => {
    if (dragging === null) return;
    if (overIdx !== null && overIdx !== dragging) {
      const next = [...items];
      const [moved] = next.splice(dragging, 1);
      next.splice(overIdx, 0, moved);
      onReorder(next);
    }
    setDragging(null);
    setOverIdx(null);
    setGhost(null);
    pointerStart.current = null;
  }, [dragging, overIdx, items, onReorder]);

  useEffect(() => {
    if (dragging === null) return;
    window.addEventListener("mousemove", moveDrag);
    window.addEventListener("mouseup",   endDrag);
    window.addEventListener("touchmove", moveDrag, { passive:false });
    window.addEventListener("touchend",  endDrag);
    return () => {
      window.removeEventListener("mousemove", moveDrag);
      window.removeEventListener("mouseup",   endDrag);
      window.removeEventListener("touchmove", moveDrag);
      window.removeEventListener("touchend",  endDrag);
    };
  }, [dragging, moveDrag, endDrag]);

  const gridStyle = {
    display: "grid",
    gridTemplateColumns: columns || "repeat(auto-fill,minmax(155px,1fr))",
    gap: 10,
    position: "relative",
  };

  return (
    <div ref={containerRef} style={gridStyle}>
      {items.map((item, i) => (
        <div
          key={item.id}
          ref={el => itemRefs.current[i] = el}
          onMouseDown={e => { if(e.button===0) startDrag(e,i); }}
          onTouchStart={e => startDrag(e, i)}
          style={{
            opacity:   dragging===i ? 0.3 : 1,
            transform: overIdx===i && dragging!==null && dragging!==i ? "scale(1.03)" : "scale(1)",
            outline:   overIdx===i && dragging!==null && dragging!==i ? "2.5px dashed #6366f1" : "none",
            borderRadius: 14,
            transition: "transform 0.12s, opacity 0.12s",
            cursor: "grab",
            userSelect: "none",
          }}>
          {renderItem(item, i)}
        </div>
      ))}
      {/* Floating ghost card while dragging */}
      {ghost && dragging !== null && (
        <div style={{
          position: "fixed",
          left: ghost.x, top: ghost.y,
          width: ghost.w, height: ghost.h,
          pointerEvents: "none",
          zIndex: 9999,
          opacity: 0.85,
          transform: "rotate(2deg) scale(1.05)",
          boxShadow: "0 12px 32px rgba(99,102,241,0.3)",
          borderRadius: 14,
          overflow: "hidden",
        }}>
          {renderItem(items[dragging], dragging)}
        </div>
      )}
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
          {form.type==="parent"&&<div style={{background:"#f0fdf4",border:"1px solid #86efac",borderRadius:10,padding:"10px 13px",fontSize:13,color:"#166534",fontFamily:FONT}}>💡 Sadece bir ebeveyn seçmeniz yeterli — eşi otomatik olarak ortak ebeveyn sayılır.</div>}
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
// ─── Subtree filter ──────────────────────────────────────────────────────────
// Given a root person (and optionally their spouse), return all descendants
function collectSubtree(rootIds, allPeople, allRels) {
  // Build children map including autoSpouse logic
  const childrenOf = {};
  const spouseOf   = {};
  allPeople.forEach(p => { childrenOf[p.id]=[]; spouseOf[p.id]=[]; });
  allRels.forEach(({type,p1,p2}) => {
    if (type==="parent") {
      if (!childrenOf[p1]) childrenOf[p1]=[];
      childrenOf[p1].push(p2);
    } else if (type==="spouse") {
      if (!spouseOf[p1]) spouseOf[p1]=[];
      if (!spouseOf[p2]) spouseOf[p2]=[];
      spouseOf[p1].push(p2);
      spouseOf[p2].push(p1);
    }
  });
  // autoSpouse: add spouse's children too
  allRels.forEach(({type,p1,p2}) => {
    if (type==="parent") {
      (spouseOf[p1]||[]).forEach(sid => {
        if (!(childrenOf[sid]||[]).includes(p2)) {
          if (!childrenOf[sid]) childrenOf[sid]=[];
          childrenOf[sid].push(p2);
        }
      });
    }
  });

  const included = new Set(rootIds);
  const queue    = [...rootIds];
  // Also include spouses of roots
  rootIds.forEach(id => { (spouseOf[id]||[]).forEach(s => { included.add(s); }); });

  while (queue.length) {
    const cur = queue.shift();
    (childrenOf[cur]||[]).forEach(cid => {
      if (!included.has(cid)) {
        included.add(cid);
        queue.push(cid);
        // include spouse of child
        (spouseOf[cid]||[]).forEach(s => { included.add(s); });
      }
    });
  }

  const subPeople = allPeople.filter(p => included.has(p.id));
  const subRels   = allRels.filter(r =>
    (included.has(r.p1) && included.has(r.p2))
  );
  return { subPeople, subRels };
}

function buildTreeSVGString(people, rels) {
  const {pos, couplePoints} = buildLayout(people, rels);
  const xs = Object.values(pos).map(p=>p.x);
  const ys = Object.values(pos).map(p=>p.y);
  if (!xs.length) return null;

  const pad = 40;
  const minX = Math.min(...xs)-NW/2-pad, minY = Math.min(...ys)-NH/2-pad;
  const maxX = Math.max(...xs)+NW/2+pad, maxY = Math.max(...ys)+NH/2+pad;
  const W = maxX-minX, H = maxY-minY;

  const L = "#1e293b", LW = 3; // line color & width — matches Canvas
  const lines = [];
  const drawn = new Set();

  // ── Edges ──
  // Spouse lines
  rels.filter(r=>r.type==="spouse").forEach(r=>{
    const key=[r.p1,r.p2].sort().join("|");
    if(drawn.has(key)) return; drawn.add(key);
    const a=pos[r.p1], b=pos[r.p2]; if(!a||!b) return;
    const mx=(a.x+b.x)/2, my=a.y;
    lines.push('<line x1="'+a.x+'" y1="'+my+'" x2="'+b.x+'" y2="'+my+'" stroke="'+L+'" stroke-width="'+LW+'" stroke-dasharray="8 4" opacity="0.85"/>');
    lines.push('<circle cx="'+mx+'" cy="'+my+'" r="10" fill="#ffffff" stroke="'+L+'" stroke-width="'+(LW*0.7)+'"/>');
    lines.push('<text x="'+mx+'" y="'+(my+4)+'" text-anchor="middle" font-size="11" fill="'+L+'">♥</text>');
  });
  // Parent lines
  const drawnP = new Set();
  rels.filter(r=>VERTICAL.has(r.type)).forEach(r=>{
    if(drawnP.has(r.id)) return; drawnP.add(r.id);
    const child=pos[r.p2]; if(!child) return;
    const cp=Object.values(couplePoints).find(c=>(c.p1===r.p1||c.p2===r.p1)&&c.children.includes(r.p2));
    const fromX=cp?cp.x:(pos[r.p1]?.x??0);
    const fromY=cp?cp.y:(pos[r.p1]?.y??0);
    const fy=fromY+NH/2+6, ty=child.y-NH/2-4, cy2=(fy+ty)/2;
    lines.push('<path d="M'+fromX+','+fy+' C'+fromX+','+cy2+' '+child.x+','+cy2+' '+child.x+','+ty+'" fill="none" stroke="'+L+'" stroke-width="'+LW+'" opacity="0.85"/>');
  });

  // ── Nodes — same design as SVG Node component ──
  const defs = [];
  const nodes = [];
  const hasParentSet = new Set(rels.filter(r=>r.type==="parent").map(r=>r.p2));
  const hasSpouseSet = new Set([...rels.filter(r=>r.type==="spouse").map(r=>r.p1),...rels.filter(r=>r.type==="spouse").map(r=>r.p2)]);

  people.forEach(p=>{
    const pt=pos[p.id]; if(!pt) return;
    const x=pt.x-NW/2, y=pt.y-NH/2;
    const col=p.gender==="male"?"#3b82f6":"#ec4899";
    const normalBg=p.gender==="male"?"#dbeafe":"#fce7f3";
    const outsider=hasSpouseSet.has(p.id)&&!hasParentSet.has(p.id);
    const infoBg=outsider?(p.gender==="male"?"#bfdbfe":"#fbcfe8"):(p.gender==="male"?"#dbeafe":"#fce7f3");
    const isDead=!!p.died;
    const INFO_H=52, PH=NH-INFO_H;
    const cid="pcp-"+p.id;

    // Photo clip path (flat bottom)
    defs.push('<clipPath id="'+cid+'"><path d="M14,0 L'+(NW-14)+',0 Q'+NW+',0 '+NW+',14 L'+NW+','+PH+' L0,'+PH+' L0,14 Q0,0 14,0 Z" transform="translate('+x+','+y+')"/></clipPath>');

    // Card bg
    nodes.push('<rect x="'+x+'" y="'+y+'" width="'+NW+'" height="'+NH+'" rx="14" fill="#ffffff" stroke="#1e293b" stroke-width="2" opacity="'+(isDead?0.72:1)+'"/>');

    // Photo area
    if(p.photo){
      nodes.push('<image href="'+p.photo+'" x="'+x+'" y="'+y+'" width="'+NW+'" height="'+PH+'" clip-path="url(#'+cid+')" preserveAspectRatio="xMidYMid slice"/>');
    } else {
      nodes.push('<rect x="'+x+'" y="'+y+'" width="'+NW+'" height="'+PH+'" fill="'+normalBg+'" clip-path="url(#'+cid+')"/>');
      nodes.push('<text x="'+(x+NW/2)+'" y="'+(y+PH*0.52)+'" text-anchor="middle" dominant-baseline="middle" fill="'+col+'" font-size="52" font-family="serif" opacity="0.4">'+(p.gender==="male"?"♂":"♀")+'</text>');
    }

    // Vignette border on photo
    nodes.push('<rect x="'+x+'" y="'+y+'" width="'+NW+'" height="'+PH+'" fill="none" stroke="'+col+'" stroke-width="2" stroke-opacity="0.2" clip-path="url(#'+cid+')"/>');

    // Info area bg (flat top, rounded bottom via path)
    nodes.push('<path d="M'+x+','+(y+PH)+' L'+(x+NW)+','+(y+PH)+' L'+(x+NW)+','+(y+NH-14)+' Q'+(x+NW)+','+(y+NH)+' '+(x+NW-14)+','+(y+NH)+' L'+(x+14)+','+(y+NH)+' Q'+x+','+(y+NH)+' '+x+','+(y+NH-14)+' Z" fill="'+infoBg+'"/>');

    // Divider
    nodes.push('<line x1="'+x+'" y1="'+(y+PH)+'" x2="'+(x+NW)+'" y2="'+(y+PH)+'" stroke="#1e293b" stroke-width="2" opacity="0.15"/>');

    // Death cross
    if(isDead) nodes.push('<text x="'+(x+NW-8)+'" y="'+(y+16)+'" text-anchor="middle" fill="#94a3b8" font-size="12" font-family="serif">✝</text>');

    // Name split
    const parts=p.name.trim().split(" ");
    const surname=parts.length>1?parts[parts.length-1]:"";
    const firstName=parts.length>1?parts.slice(0,-1).join(" "):parts[0];
    const maxCh=14;
    const fn=firstName.length>maxCh?firstName.slice(0,maxCh-1)+"…":firstName;
    const sn=surname.length>maxCh?surname.slice(0,maxCh-1)+"…":surname;
    const cx=x+NW/2;
    if(surname){
      nodes.push('<text x="'+cx+'" y="'+(y+PH+14)+'" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700" font-family="sans-serif">'+fn+'</text>');
      nodes.push('<text x="'+cx+'" y="'+(y+PH+28)+'" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700" font-family="sans-serif">'+sn+'</text>');
      nodes.push('<text x="'+cx+'" y="'+(y+PH+42)+'" text-anchor="middle" fill="#475569" font-size="9" font-family="sans-serif">'+(p.born||"?")+(p.died?" – "+p.died:"")+'</text>');
    } else {
      nodes.push('<text x="'+cx+'" y="'+(y+PH+18)+'" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700" font-family="sans-serif">'+fn+'</text>');
      nodes.push('<text x="'+cx+'" y="'+(y+PH+34)+'" text-anchor="middle" fill="#475569" font-size="9" font-family="sans-serif">'+(p.born||"?")+(p.died?" – "+p.died:"")+'</text>');
    }
  });

  const svgString = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="'+minX+' '+minY+' '+W+' '+H+'" width="'+W+'" height="'+H+'" style="background:#ffffff">'
    + '<defs>'+defs.join("")+'</defs>'
    + lines.join("")
    + nodes.join("")
    + '</svg>';

  return {svgString, W, H};
}

async function svgToDataUrl(svgString, maxScale=2) {
  return new Promise((res,rej)=>{ const blob=new Blob([svgString],{type:"image/svg+xml"}); const url=URL.createObjectURL(blob); const img=new Image(); img.onload=()=>{ const scale=Math.min(2400/img.naturalWidth,1600/img.naturalHeight,maxScale); const canvas=document.createElement("canvas"); canvas.width=img.naturalWidth*scale; canvas.height=img.naturalHeight*scale; const ctx=canvas.getContext("2d"); ctx.fillStyle="#ffffff"; ctx.fillRect(0,0,canvas.width,canvas.height); ctx.scale(scale,scale); ctx.drawImage(img,0,0); URL.revokeObjectURL(url); res(canvas.toDataURL("image/png")); }; img.onerror=rej; img.src=url; });
}

// High-resolution PNG export — full tree on one canvas, no page splitting
async function buildExportPng(people, rels, scaleFactor) {
  const result = buildTreeSVGString(people, rels);
  if (!result) return null;
  const {svgString} = result;
  return new Promise((res,rej)=>{
    const blob=new Blob([svgString],{type:"image/svg+xml"});
    const url=URL.createObjectURL(blob);
    const img=new Image();
    img.onload=()=>{
      const canvas=document.createElement("canvas");
      canvas.width  = Math.round(img.naturalWidth  * scaleFactor);
      canvas.height = Math.round(img.naturalHeight * scaleFactor);
      const ctx=canvas.getContext("2d");
      ctx.fillStyle="#ffffff";
      ctx.fillRect(0,0,canvas.width,canvas.height);
      ctx.scale(scaleFactor,scaleFactor);
      ctx.drawImage(img,0,0);
      URL.revokeObjectURL(url);
      res({dataUrl:canvas.toDataURL("image/png",1.0), w:canvas.width, h:canvas.height});
    };
    img.onerror=rej;
    img.src=url;
  });
}

function buildPrintHTML(tree, tileImgs, title) {
  const people = tree.people || [], rels = tree.rels || [];
  const today = new Date().toLocaleDateString("tr-TR", {day:"2-digit", month:"long", year:"numeric"});
  const displayTitle = title || tree.name;

  const pageHtmls = tileImgs.map((tile, i) => {
    const imgHtml = tile
      ? '<img src="' + tile.dataUrl + '" alt=""/>'
      : '<p style="text-align:center;color:#999;padding:40px 0">Diyagram oluşturulamadı</p>';
    const pageInfo = displayTitle + ' &middot; Soy A&#287;ac&#305; &middot; ' + today + ' &middot; ' + people.length + ' ki&#351;i'
      + (tileImgs.length > 1 ? ' &middot; Sayfa ' + (i+1) + ' / ' + tileImgs.length : '');
    return [
      '<div class="page">',
      '  <div class="diagram">' + imgHtml + '</div>',
      '  <div class="footer">' + pageInfo + '</div>',
      '</div>',
    ].join('\n');
  });

  const css = [
    '* { box-sizing:border-box; margin:0; padding:0; font-family:sans-serif; }',
    'html, body { height:100%; background:white; }',
    '.page {',
    '  display: flex;',
    '  flex-direction: column;',
    '  height: 100vh;',
    '  width: 100%;',
    '  page-break-after: always;',
    '  break-after: page;',
    '  overflow: hidden;',
    '}',
    '.page:last-child { page-break-after:avoid; break-after:avoid; }',
    '.diagram {',
    '  flex: 1;',
    '  min-height: 0;',
    '  display: flex;',
    '  align-items: center;',
    '  justify-content: center;',
    '  padding: 5mm 8mm 2mm 8mm;',
    '  overflow: hidden;',
    '}',
    '.diagram img {',
    '  max-width: 100%;',
    '  max-height: 100%;',
    '  width: auto;',
    '  height: auto;',
    '  object-fit: contain;',
    '  display: block;',
    '}',
    '.footer {',
    '  flex-shrink: 0;',
    '  text-align: center;',
    '  padding: 3mm 8mm 5mm 8mm;',
    '  border-top: 1.5pt solid #c7d2fe;',
    '  font-size: 11pt;',
    '  color: #475569;',
    '  font-weight: 600;',
    '  letter-spacing: 0.03em;',
    '}',
    '@media print {',
    '  @page { margin: 0; size: A4 landscape; }',
    '  html, body { height: 100%; }',
    '}',
  ].join('\n');

  return [
    '<!DOCTYPE html>',
    '<html lang="tr">',
    '<head>',
    '<meta charset="UTF-8"/>',
    '<title>' + displayTitle + ' — Soy Ağacı</title>',
    '<style>' + css + '</style>',
    '</head>',
    '<body>',
    pageHtmls.join('\n'),
    '<script>',
    '  window.onload=function(){window.print();window.onafterprint=function(){window.close();};};',
    '<\/script>',
    '</body>',
    '</html>'
  ].join('\n');
}

// Split SVG into page tiles — supports both wide AND tall trees
// targetPages: if set, forces the tree to be split into exactly that many columns×rows
async function buildTiledImgs(people, rels, pageWidthPx, targetPages) {
  const result = buildTreeSVGString(people, rels);
  if (!result) return [null];
  const {svgString, W, H} = result;

  const BASE_PAGE_W = pageWidthPx || 1080;
  const BASE_PAGE_H = 720;

  const {pos} = buildLayout(people, rels);

  const allXs     = Object.values(pos).map(p => p.x).sort((a,b) => a - b);
  const treeLeft  = Math.min(...allXs) - NW/2 - 40;
  const treeRight = Math.max(...allXs) + NW/2 + 40;
  const rowTops   = [...new Set(Object.values(pos).map(p => Math.round(p.y - NH/2)))].sort((a,b) => a-b);
  const treeTop    = rowTops[0] - 30;
  const treeBottom = rowTops[rowTops.length-1] + NH + 30;

  // ── Helper: build vBands given a max band height ───────────────────────────
  function makeVBands(maxH) {
    const bands = [];
    let bs = treeTop, be = treeTop;
    for (const ry of rowTops) {
      const rb = ry + NH + 30;
      if (rb - bs <= maxH) { be = rb; }
      else { bands.push({y0:bs, y1:be}); bs = ry - 30; be = rb; }
    }
    bands.push({y0:bs, y1:be});
    return bands;
  }

  // ── Helper: build hSlices given a max slice width ──────────────────────────
  function makeHSlices(maxW) {
    // Find natural gap cut-points
    const hCuts = [treeLeft];
    for (let i = 1; i < allXs.length; i++) {
      if (allXs[i] - allXs[i-1] > NW + 30) hCuts.push((allXs[i-1]+allXs[i])/2);
    }
    hCuts.push(treeRight);

    // Greedy grouping respecting maxW
    const slices = [];
    let ss = hCuts[0], se = hCuts[0];
    for (let ci = 1; ci < hCuts.length; ci++) {
      const c = hCuts[ci];
      if (c - ss <= maxW) { se = c; }
      else { slices.push({x0:ss, x1:se}); ss = se; se = c; }
    }
    slices.push({x0:ss, x1:se});
    return slices;
  }

  // ── Determine vBands and hSlices ───────────────────────────────────────────
  let vBands, hSlices;

  if (targetPages && targetPages > 1) {
    // Work out the best nCols × nRows grid that:
    //  a) gives product >= targetPages
    //  b) keeps A4 aspect ratio (cols proportional to tree width, rows to height)
    const treeW = treeRight - treeLeft;
    const treeHH = treeBottom - treeTop;
    const aspect = BASE_PAGE_W / BASE_PAGE_H; // ~1.5
    // nCols / nRows should roughly equal (treeW / treeHH) / aspect
    // and nCols * nRows = targetPages
    const ratio = (treeW / treeHH) / aspect; // how many col-units per row-unit
    // nRows = sqrt(targetPages / ratio), nCols = targetPages / nRows
    let nRows = Math.max(1, Math.round(Math.sqrt(targetPages / Math.max(ratio, 0.1))));
    let nCols = Math.ceil(targetPages / nRows);
    // adjust until product >= targetPages
    while (nCols * nRows < targetPages) nCols++;

    // Force-split into exactly nCols horizontal slices
    const sliceW = treeW / nCols;
    hSlices = [];
    for (let i = 0; i < nCols; i++) {
      hSlices.push({x0: treeLeft + i*sliceW, x1: treeLeft + (i+1)*sliceW});
    }

    // Force-split into exactly nRows vertical bands — respect row boundaries
    // Distribute rowTops evenly among nRows buckets
    const rowsPerBand = Math.ceil(rowTops.length / nRows);
    vBands = [];
    for (let b = 0; b < nRows; b++) {
      const first = rowTops[b * rowsPerBand];
      const lastIdx = Math.min((b+1)*rowsPerBand - 1, rowTops.length-1);
      const last  = rowTops[lastIdx];
      if (first === undefined) continue;
      vBands.push({y0: first - 30, y1: last + NH + 30});
    }

  } else if (targetPages === 1) {
    // Single page: whole tree as one tile
    vBands  = [{y0: treeTop, y1: treeBottom}];
    hSlices = [{x0: treeLeft, x1: treeRight}];

  } else {
    // Auto: natural splitting within A4 bounds
    vBands  = makeVBands(BASE_PAGE_H);
    hSlices = makeHSlices(BASE_PAGE_W);
    // Fallback if hSlices is just 1 giant slice wider than page
    if (hSlices.length === 1 && hSlices[0].x1 - hSlices[0].x0 > BASE_PAGE_W * 1.1) {
      const n = Math.ceil((treeRight - treeLeft) / BASE_PAGE_W);
      hSlices = [];
      for (let i = 0; i < n; i++) {
        hSlices.push({x0: treeLeft + i*BASE_PAGE_W, x1: Math.min(treeLeft + (i+1)*BASE_PAGE_W, treeRight)});
      }
    }
  }

  // ── Render each tile ───────────────────────────────────────────────────────
  const results = [];
  for (const vb of vBands) {
    const bH = vb.y1 - vb.y0;
    for (const hs of hSlices) {
      const bW = hs.x1 - hs.x0;
      if (bW < 10 || bH < 10) continue;

      const hasContent = Object.values(pos).some(p =>
        p.x + NW/2 >= hs.x0 && p.x - NW/2 <= hs.x1 &&
        p.y + NH/2 >= vb.y0 && p.y - NH/2 <= vb.y1
      );
      if (!hasContent) continue;

      const tileSvg = svgString
        .replace(/viewBox="[^"]*"/, `viewBox="${hs.x0} ${vb.y0} ${bW} ${bH}"`)
        .replace(/width="[^"]*"/,   `width="${bW}"`)
        .replace(/height="[^"]*"/,  `height="${bH}"`);

      const dataUrl = await svgToDataUrl(tileSvg);
      results.push({dataUrl, w:bW, h:bH});
    }
  }
  return results.length ? results : [null];
}

// ─── Export Modal ─────────────────────────────────────────────────────────────
const EXPORT_FORMATS = [
  { id:"png",  label:"PNG",  mime:"image/png",     ext:".png",  quality:null, desc:"Şeffaf arka plan destekler, kayıpsız" },
  { id:"jpg",  label:"JPG",  mime:"image/jpeg",    ext:".jpg",  quality:0.95, desc:"Küçük dosya boyutu, fotoğraflar için" },
  { id:"webp", label:"WebP", mime:"image/webp",    ext:".webp", quality:0.95, desc:"Modern format, küçük & kaliteli" },
];

const EXPORT_SIZES = [
  { id:"1x",  label:"1×",  scale:1,   desc:"Orijinal boyut" },
  { id:"2x",  label:"2×",  scale:2,   desc:"Orta çözünürlük" },
  { id:"3x",  label:"3×",  scale:3,   desc:"Yüksek çözünürlük (önerilen)" },
  { id:"4x",  label:"4×",  scale:4,   desc:"Baskı kalitesi" },
  { id:"5x",  label:"5×",  scale:5,   desc:"Ultra yüksek çözünürlük" },
];

function ExportModal({tree, onClose}) {
  const allPeople = tree.people||[], allRels = tree.rels||[];

  // Spouse pairs (same logic as PrintModal)
  const spousePairs = [];
  const seenPairs   = new Set();
  allRels.filter(r=>r.type==="spouse").forEach(r=>{
    const key=[r.p1,r.p2].sort().join("|");
    if(seenPairs.has(key)) return; seenPairs.add(key);
    const p1=allPeople.find(p=>p.id===r.p1), p2=allPeople.find(p=>p.id===r.p2);
    if(p1&&p2) spousePairs.push({key,p1,p2});
  });
  (()=>{
    const depth={};
    allPeople.forEach(p=>{depth[p.id]=0;});
    const upMap={};
    allRels.filter(r=>r.type==="parent").forEach(({p1,p2})=>{ if(!upMap[p2]) upMap[p2]=[]; upMap[p2].push(p1); });
    let changed=true;
    while(changed){ changed=false; allPeople.forEach(p=>{ const parents=(upMap[p.id]||[]); if(!parents.length) return; const nd=Math.max(...parents.map(pid=>depth[pid]||0))+1; if((depth[p.id]||0)<nd){depth[p.id]=nd;changed=true;} }); }
    spousePairs.sort((a,b)=>(Math.min(depth[a.p1.id]||0,depth[a.p2.id]||0))-(Math.min(depth[b.p1.id]||0,depth[b.p2.id]||0)));
  })();

  const [scope,      setScope]      = useState("all");
  const [pairSearch, setPairSearch] = useState("");
  const [format,     setFormat]     = useState("png");
  const [sizeId,     setSizeId]     = useState("3x");
  const [generating, setGenerating] = useState(false);
  const [status,     setStatus]     = useState("");
  const [preview,    setPreview]    = useState(null); // {w,h}

  const filteredPairs = pairSearch.trim()
    ? spousePairs.filter(s=>(s.p1.name+s.p2.name).toLowerCase().includes(pairSearch.toLowerCase()))
    : spousePairs;

  const scopeLabel = ()=>{
    if(scope==="all") return "Tüm ağaç ("+allPeople.length+" kişi)";
    const pair=spousePairs.find(s=>s.key===scope);
    return pair ? pair.p1.name+" & "+pair.p2.name+" alt soyu" : "?";
  };

  const buildSubset = ()=>{
    if(scope==="all") return {subPeople:allPeople, subRels:allRels};
    const pair=spousePairs.find(s=>s.key===scope);
    if(!pair) return {subPeople:allPeople, subRels:allRels};
    return collectSubtree([pair.p1.id, pair.p2.id], allPeople, allRels);
  };

  // Compute preview dimensions whenever scope/size changes
  useEffect(()=>{
    const {subPeople, subRels} = buildSubset();
    const result = buildTreeSVGString(subPeople, subRels);
    if(!result){setPreview(null);return;}
    const sc = EXPORT_SIZES.find(s=>s.id===sizeId)?.scale||3;
    setPreview({w:Math.round(result.W*sc), h:Math.round(result.H*sc)});
  },[scope, sizeId]);

  const handleExport = async ()=>{
    setGenerating(true); setStatus("Görüntü hazırlanıyor…");
    try {
      const {subPeople, subRels} = buildSubset();
      const title = scope==="all" ? tree.name : scopeLabel();
      const sc  = EXPORT_SIZES.find(s=>s.id===sizeId)?.scale||3;
      const fmt = EXPORT_FORMATS.find(f=>f.id===format)||EXPORT_FORMATS[0];

      setStatus("Render ediliyor… (büyük ağaçlar birkaç saniye alabilir)");
      const result = buildTreeSVGString(subPeople, subRels);
      if(!result){setStatus("Hata: diyagram oluşturulamadı.");setGenerating(false);return;}
      const {svgString} = result;

      const dataUrl = await new Promise((res,rej)=>{
        const blob=new Blob([svgString],{type:"image/svg+xml"});
        const url=URL.createObjectURL(blob);
        const img=new Image();
        img.onload=()=>{
          const canvas=document.createElement("canvas");
          canvas.width =Math.round(img.naturalWidth *sc);
          canvas.height=Math.round(img.naturalHeight*sc);
          const ctx=canvas.getContext("2d");
          if(format!=="png"){ ctx.fillStyle="#ffffff"; ctx.fillRect(0,0,canvas.width,canvas.height); }
          ctx.scale(sc,sc);
          ctx.drawImage(img,0,0);
          URL.revokeObjectURL(url);
          res(canvas.toDataURL(fmt.mime, fmt.quality||1.0));
        };
        img.onerror=rej;
        img.src=url;
      });

      setStatus("İndiriliyor…");
      const a=document.createElement("a");
      a.href=dataUrl;
      a.download=(title||tree.name).replace(/[^a-zA-Z0-9_À-ɏ ]/g,"_")+"_soyagaci"+fmt.ext;
      a.click();
      const kb=Math.round(dataUrl.length*0.75/1024);
      setStatus("✓ İndirildi · "+Math.round(result.W*sc)+"×"+Math.round(result.H*sc)+" px · ~"+kb+" KB");
    } catch(e){ console.error(e); setStatus("Hata: "+e.message); }
    setGenerating(false);
  };

  const lbl={fontSize:12,color:"#64748b",fontWeight:600,marginBottom:6,display:"block",fontFamily:FONT};
  const inp={background:"#f8faff",border:"1px solid #e2e8f0",borderRadius:9,color:"#1e293b",padding:"10px 13px",fontSize:14,outline:"none",width:"100%",fontFamily:FONT};

  return (
    <div style={{position:"fixed",inset:0,background:"#00000099",display:"flex",alignItems:"flex-end",justifyContent:"center",zIndex:1002}}>
      <div style={{background:"#ffffff",borderRadius:"20px 20px 0 0",width:"100%",maxWidth:540,maxHeight:"92vh",overflow:"auto",paddingBottom:"env(safe-area-inset-bottom)"}}>
        <div style={{display:"flex",justifyContent:"center",padding:"12px 0 0"}}><div style={{width:40,height:4,borderRadius:2,background:"#d1d9f0"}}/></div>
        <div style={{padding:"12px 18px 8px",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <span style={{fontSize:16,fontWeight:700,color:"#10b981",fontFamily:FONT}}>🖼️ Görüntü Olarak Kaydet</span>
          <button onClick={onClose} style={{background:"transparent",border:"none",color:"#64748b",fontSize:24,cursor:"pointer"}}>✕</button>
        </div>

        <div style={{padding:"0 16px 24px",display:"flex",flexDirection:"column",gap:16}}>

          {/* ── Scope ── */}
          <div>
            <label style={lbl}>KAPSAM</label>
            <div onClick={()=>setScope("all")} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 13px",borderRadius:10,border:"2px solid "+(scope==="all"?"#10b981":"#e2e8f0"),background:scope==="all"?"#f0fdf4":"#f8faff",cursor:"pointer",marginBottom:8}}>
              <span style={{fontSize:18}}>🌳</span>
              <div style={{flex:1}}>
                <div style={{fontSize:13,fontWeight:700,color:scope==="all"?"#10b981":"#1e293b",fontFamily:FONT}}>Tüm Ağaç</div>
                <div style={{fontSize:11,color:"#64748b",fontFamily:FONT}}>{allPeople.length} kişi</div>
              </div>
              {scope==="all"&&<span style={{color:"#10b981",fontSize:18}}>✓</span>}
            </div>
            {spousePairs.length>0&&<>
              <label style={{...lbl,marginTop:4}}>EŞ ÇİFTİ SEÇİN (ALT SOY)</label>
              <div style={{position:"relative",marginBottom:8}}>
                <span style={{position:"absolute",left:10,top:"50%",transform:"translateY(-50%)",color:"#94a3b8",fontSize:14,pointerEvents:"none"}}>🔍</span>
                <input value={pairSearch} onChange={e=>setPairSearch(e.target.value)} placeholder="İsim ile ara…" style={{...inp,paddingLeft:32}}/>
                {pairSearch&&<button onClick={()=>setPairSearch("")} style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",background:"transparent",border:"none",color:"#94a3b8",cursor:"pointer",fontSize:15}}>✕</button>}
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:6,maxHeight:180,overflow:"auto"}}>
                {filteredPairs.map(s=>{
                  const sel=scope===s.key;
                  return(
                    <div key={s.key} onClick={()=>setScope(s.key)} style={{display:"flex",alignItems:"center",gap:10,padding:"9px 12px",borderRadius:10,border:"2px solid "+(sel?"#10b981":"#e2e8f0"),background:sel?"#f0fdf4":"#f8faff",cursor:"pointer"}}>
                      <div style={{display:"flex",gap:4}}>
                        {[s.p1,s.p2].map(px=>(
                          <div key={px.id} style={{width:30,height:30,borderRadius:"50%",overflow:"hidden",border:"2px solid "+(px.gender==="male"?C.male:C.female),background:px.gender==="male"?"#dbeafe":"#fce7f3",display:"flex",alignItems:"center",justifyContent:"center",fontSize:13}}>
                            {px.photo?<img src={px.photo} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>:(px.gender==="male"?"♂":"♀")}
                          </div>
                        ))}
                      </div>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontSize:13,fontWeight:700,color:sel?"#10b981":"#1e293b",fontFamily:FONT,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{s.p1.name} & {s.p2.name}</div>
                        <div style={{fontSize:11,color:"#64748b",fontFamily:FONT}}>Alt soy ağacı</div>
                      </div>
                      {sel&&<span style={{color:"#10b981",fontSize:18}}>✓</span>}
                    </div>
                  );
                })}
                {filteredPairs.length===0&&pairSearch&&<div style={{textAlign:"center",color:"#94a3b8",fontSize:13,padding:"10px 0",fontFamily:FONT}}>Sonuç bulunamadı</div>}
              </div>
            </>}
          </div>

          {/* ── Format ── */}
          <div>
            <label style={lbl}>DOSYA TÜRÜ</label>
            <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8}}>
              {EXPORT_FORMATS.map(f=>(
                <div key={f.id} onClick={()=>setFormat(f.id)} style={{padding:"12px 8px",borderRadius:10,border:"2px solid "+(format===f.id?"#10b981":"#e2e8f0"),background:format===f.id?"#f0fdf4":"#f8faff",cursor:"pointer",textAlign:"center"}}>
                  <div style={{fontSize:15,fontWeight:700,color:format===f.id?"#10b981":"#1e293b",fontFamily:FONT}}>{f.label}</div>
                  <div style={{fontSize:10,color:"#94a3b8",fontFamily:FONT,marginTop:3,lineHeight:1.3}}>{f.desc}</div>
                </div>
              ))}
            </div>
          </div>

          {/* ── Size ── */}
          <div>
            <label style={lbl}>ÇÖZÜNÜRLÜK</label>
            <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:6}}>
              {EXPORT_SIZES.map(s=>(
                <div key={s.id} onClick={()=>setSizeId(s.id)} style={{padding:"10px 4px",borderRadius:10,border:"2px solid "+(sizeId===s.id?"#10b981":"#e2e8f0"),background:sizeId===s.id?"#f0fdf4":"#f8faff",cursor:"pointer",textAlign:"center"}}>
                  <div style={{fontSize:15,fontWeight:700,color:sizeId===s.id?"#10b981":"#1e293b",fontFamily:FONT}}>{s.label}</div>
                  <div style={{fontSize:10,color:"#94a3b8",fontFamily:FONT,marginTop:2}}>{s.desc.split(",")[0]}</div>
                </div>
              ))}
            </div>
          </div>

          {/* ── Preview info ── */}
          <div style={{background:"#f0fdf4",border:"1px solid #86efac",borderRadius:12,padding:"12px 14px",display:"flex",alignItems:"center",gap:12}}>
            <span style={{fontSize:24}}>🖼️</span>
            <div style={{flex:1}}>
              <div style={{fontSize:13,fontWeight:700,color:"#1e293b",fontFamily:FONT}}>{scopeLabel()}</div>
              <div style={{fontSize:12,color:"#10b981",fontFamily:FONT,marginTop:2}}>
                {preview ? preview.w.toLocaleString("tr-TR")+" × "+preview.h.toLocaleString("tr-TR")+" piksel" : "Hesaplanıyor…"}
                {" · "}{EXPORT_FORMATS.find(f=>f.id===format)?.label} · {EXPORT_SIZES.find(s=>s.id===sizeId)?.scale}× ölçek
              </div>
            </div>
          </div>

          {/* ── Status ── */}
          {status&&<div style={{textAlign:"center",fontSize:13,fontFamily:FONT,color:status.startsWith("✓")?"#10b981":status.startsWith("Hata")?"#ef4444":"#64748b",padding:"4px 0"}}>{status}</div>}

          {/* ── Export button ── */}
          <button onClick={handleExport} disabled={generating}
            style={{background:generating?"#bbf7d0":"#10b981",border:"1px solid #10b981",borderRadius:12,color:"#ffffff",padding:"15px",fontSize:16,cursor:generating?"not-allowed":"pointer",fontWeight:700,width:"100%",fontFamily:FONT}}>
            {generating?"⏳ Hazırlanıyor…":"🖼️ İndir"}
          </button>
        </div>
      </div>
    </div>
  );
}

function PrintModal({tree,onClose}) {
  const allPeople = tree.people||[], allRels = tree.rels||[];

  // Spouse pairs — sorted top-to-bottom by generation rank
  const spousePairs = [];
  const seenPairs   = new Set();
  allRels.filter(r=>r.type==="spouse").forEach(r=>{
    const key=[r.p1,r.p2].sort().join("|");
    if(seenPairs.has(key)) return; seenPairs.add(key);
    const p1=allPeople.find(p=>p.id===r.p1), p2=allPeople.find(p=>p.id===r.p2);
    if(p1&&p2) spousePairs.push({key, p1, p2});
  });
  // Compute rank for sorting: use parent-child depth
  (()=>{
    const parentOf = {};
    allPeople.forEach(p=>{ parentOf[p.id]=0; });
    allRels.filter(r=>r.type==="parent").forEach(({p1,p2})=>{
      parentOf[p2] = (parentOf[p2]||0)+1; // will be replaced below
    });
    // BFS depth
    const depth = {};
    allPeople.forEach(p=>{ depth[p.id]=0; });
    const upMap = {};
    allRels.filter(r=>r.type==="parent").forEach(({p1,p2})=>{
      if(!upMap[p2]) upMap[p2]=[];
      upMap[p2].push(p1);
    });
    let changed=true;
    while(changed){ changed=false;
      allPeople.forEach(p=>{
        const parents=(upMap[p.id]||[]);
        if(!parents.length) return;
        const nd=Math.max(...parents.map(pid=>depth[pid]||0))+1;
        if((depth[p.id]||0)<nd){ depth[p.id]=nd; changed=true; }
      });
    }
    spousePairs.sort((a,b)=>{
      const da=Math.min(depth[a.p1.id]||0, depth[a.p2.id]||0);
      const db=Math.min(depth[b.p1.id]||0, depth[b.p2.id]||0);
      return da-db;
    });
  })();

  const [scope,      setScope]      = useState("all");
  const [pairSearch, setPairSearch] = useState("");
  const [pageTarget, setPageTarget] = useState("auto");  // "auto"|"1"|"2"|"4"|"6"|"9"|"12"
  const [pageEst,    setPageEst]    = useState(null);    // estimated page count
  const [generating, setGenerating] = useState(false);
  const [status,     setStatus]     = useState("");
  const tilesRef = useRef(null);

  // Estimate page count whenever scope or pageTarget changes
  useEffect(()=>{
    const {subPeople, subRels} = buildSubset();
    if(!subPeople.length){setPageEst(null);return;}
    const r = buildTreeSVGString(subPeople, subRels);
    if(!r){setPageEst(null);return;}
    const tgt = pageTarget==="auto" ? null : parseInt(pageTarget);
    if(tgt===1){setPageEst(1);return;}
    if(tgt>1){
      // Mirror the exact grid logic from buildTiledImgs
      const {pos} = buildLayout(subPeople, subRels);
      const allXs  = Object.values(pos).map(p=>p.x).sort((a,b)=>a-b);
      const rowTops= [...new Set(Object.values(pos).map(p=>Math.round(p.y-NH/2)))].sort((a,b)=>a-b);
      const treeW  = Math.max(...allXs)+NW/2+40 - (Math.min(...allXs)-NW/2-40);
      const treeHH = rowTops[rowTops.length-1]+NH+30 - (rowTops[0]-30);
      const aspect = 1080/720;
      const ratio  = (treeW/treeHH)/aspect;
      let nRows = Math.max(1,Math.round(Math.sqrt(tgt/Math.max(ratio,0.1))));
      let nCols = Math.ceil(tgt/nRows);
      while(nCols*nRows<tgt) nCols++;
      // count non-empty tiles
      const {pos:pos2} = buildLayout(subPeople, subRels);
      const left=Math.min(...allXs)-NW/2-40, right=Math.max(...allXs)+NW/2+40;
      const sw=(right-left)/nCols;
      const rowsPerBand=Math.ceil(rowTops.length/nRows);
      let count=0;
      for(let b=0;b<nRows;b++){
        const firstRy=rowTops[b*rowsPerBand]; if(!firstRy) continue;
        const lastRy=rowTops[Math.min((b+1)*rowsPerBand-1,rowTops.length-1)];
        const y0=firstRy-30, y1=lastRy+NH+30;
        for(let c=0;c<nCols;c++){
          const x0=left+c*sw, x1=left+(c+1)*sw;
          const has=Object.values(pos2).some(p=>p.x+NW/2>=x0&&p.x-NW/2<=x1&&p.y+NH/2>=y0&&p.y-NH/2<=y1);
          if(has) count++;
        }
      }
      setPageEst(count);
      return;
    }
    // Auto mode
    const {pos} = buildLayout(subPeople, subRels);
    const allXs=Object.values(pos).map(p=>p.x).sort((a,b)=>a-b);
    const rowTops=[...new Set(Object.values(pos).map(p=>Math.round(p.y-NH/2)))].sort((a,b)=>a-b);
    let vCount=0, bs=rowTops[0]-30, be=bs;
    for(const ry of rowTops){const rb=ry+NH+30;if(rb-bs<=720){be=rb;}else{vCount++;bs=ry-30;be=rb;}}vCount++;
    const tL=Math.min(...allXs)-NW/2-40,tR=Math.max(...allXs)+NW/2+40;
    const hCuts=[tL];
    for(let i=1;i<allXs.length;i++){if(allXs[i]-allXs[i-1]>NW+30)hCuts.push((allXs[i-1]+allXs[i])/2);}
    hCuts.push(tR);
    let hCount=0,ss=hCuts[0],se=hCuts[0];
    for(let ci=1;ci<hCuts.length;ci++){const c=hCuts[ci];if(c-ss<=1080){se=c;}else{hCount++;ss=se;se=c;}}
    hCount++;
    setPageEst(vCount*hCount);
  },[scope, pageTarget]);

  const filteredPairs = pairSearch.trim()
    ? spousePairs.filter(s=>
        (s.p1.name+s.p2.name).toLowerCase().includes(pairSearch.toLowerCase())
      )
    : spousePairs;

  const scopeLabel = ()=>{
    if(scope==="all") return "Tüm ağaç ("+allPeople.length+" kişi)";
    const pair=spousePairs.find(s=>s.key===scope);
    return pair ? pair.p1.name+" & "+pair.p2.name+" alt soyu" : "?";
  };

  const buildSubset = ()=>{
    if(scope==="all") return {subPeople:allPeople, subRels:allRels};
    const pair=spousePairs.find(s=>s.key===scope);
    if(!pair) return {subPeople:allPeople, subRels:allRels};
    return collectSubtree([pair.p1.id, pair.p2.id], allPeople, allRels);
  };

  const handlePrint = async ()=>{
    setGenerating(true); setStatus("Diyagram hazırlanıyor…");
    try {
      const {subPeople, subRels} = buildSubset();
      const title = scope==="all" ? tree.name : scopeLabel();
      const tgt = pageTarget==="auto" ? null : parseInt(pageTarget);
      const tiles = await buildTiledImgs(subPeople, subRels, 1020, tgt);
      tilesRef.current = {tiles, title, subPeople};
      setStatus("Yazdırma penceresi açılıyor…");
      const subTree = {...tree, people:subPeople, rels:subRels};
      const html = buildPrintHTML(subTree, tiles, title);
      const w = window.open("","_blank","width=1100,height=750");
      if(!w){alert("Lütfen popup engelleyiciyi kapatın.");return;}
      w.document.write(html); w.document.close();
      setStatus("✓ Hazır");
    } catch(e){ console.error(e); setStatus("Hata oluştu."); }
    setGenerating(false);
  };


  const inp={background:"#f8faff",border:"1px solid #e2e8f0",borderRadius:9,color:"#1e293b",padding:"10px 13px",fontSize:14,outline:"none",width:"100%",fontFamily:FONT};
  const lbl={fontSize:12,color:"#64748b",fontWeight:600,marginBottom:6,display:"block",fontFamily:FONT};

  return (
    <div style={{position:"fixed",inset:0,background:"#00000099",display:"flex",alignItems:"flex-end",justifyContent:"center",zIndex:1002}}>
      <div style={{background:"#ffffff",border:"1px solid #e2e8f0",borderRadius:"20px 20px 0 0",width:"100%",maxWidth:540,maxHeight:"90vh",overflow:"auto",paddingBottom:"env(safe-area-inset-bottom)"}}>
        <div style={{display:"flex",justifyContent:"center",padding:"12px 0 0"}}><div style={{width:40,height:4,borderRadius:2,background:"#d1d9f0"}}/></div>
        <div style={{padding:"12px 18px 8px",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <span style={{fontSize:16,fontWeight:700,color:"#6366f1",fontFamily:FONT}}>🖨️ Yazdır / PDF Kaydet</span>
          <button onClick={onClose} style={{background:"transparent",border:"none",color:"#64748b",fontSize:24,cursor:"pointer"}}>✕</button>
        </div>
        <div style={{padding:"0 16px 20px",display:"flex",flexDirection:"column",gap:14}}>

          {/* Scope selector */}
          <div>
            <label style={lbl}>KAPSAM SEÇİN</label>
            {/* "Tüm ağaç" button */}
            <div
              onClick={()=>setScope("all")}
              style={{display:"flex",alignItems:"center",gap:10,padding:"10px 13px",borderRadius:10,border:"2px solid "+(scope==="all"?"#6366f1":"#e2e8f0"),background:scope==="all"?"#eef2ff":"#f8faff",cursor:"pointer",marginBottom:10}}>
              <span style={{fontSize:18}}>🌳</span>
              <div style={{flex:1}}>
                <div style={{fontSize:13,fontWeight:700,color:scope==="all"?"#6366f1":"#1e293b",fontFamily:FONT}}>Tüm Ağaç</div>
                <div style={{fontSize:11,color:"#64748b",fontFamily:FONT}}>{allPeople.length} kişi</div>
              </div>
              {scope==="all"&&<span style={{color:"#6366f1",fontSize:18}}>✓</span>}
            </div>
            {/* Spouse pair search + list */}
            {spousePairs.length>0&&<>
              <label style={{...lbl,marginTop:4}}>EŞ ÇİFTİ SEÇİN (ALT SOY)</label>
              <div style={{position:"relative",marginBottom:8}}>
                <span style={{position:"absolute",left:10,top:"50%",transform:"translateY(-50%)",color:"#94a3b8",fontSize:14,pointerEvents:"none"}}>🔍</span>
                <input
                  value={pairSearch} onChange={e=>setPairSearch(e.target.value)}
                  placeholder="İsim ile ara…"
                  style={{...inp,paddingLeft:32}}/>
                {pairSearch&&<button onClick={()=>setPairSearch("")} style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",background:"transparent",border:"none",color:"#94a3b8",cursor:"pointer",fontSize:15}}>✕</button>}
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:6,maxHeight:220,overflow:"auto"}}>
                {filteredPairs.map(s=>{
                  const sel=scope===s.key;
                  return(
                    <div key={s.key} onClick={()=>setScope(s.key)}
                      style={{display:"flex",alignItems:"center",gap:10,padding:"9px 12px",borderRadius:10,border:"2px solid "+(sel?"#6366f1":"#e2e8f0"),background:sel?"#eef2ff":"#f8faff",cursor:"pointer"}}>
                      <div style={{display:"flex",gap:4}}>
                        {[s.p1,s.p2].map(px=>(
                          <div key={px.id} style={{width:32,height:32,borderRadius:"50%",overflow:"hidden",border:"2px solid "+(px.gender==="male"?C.male:C.female),background:px.gender==="male"?"#dbeafe":"#fce7f3",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14}}>
                            {px.photo?<img src={px.photo} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>:(px.gender==="male"?"♂":"♀")}
                          </div>
                        ))}
                      </div>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontSize:13,fontWeight:700,color:sel?"#6366f1":"#1e293b",fontFamily:FONT,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                          {s.p1.name} & {s.p2.name}
                        </div>
                        <div style={{fontSize:11,color:"#64748b",fontFamily:FONT}}>Alt soy ağacı</div>
                      </div>
                      {sel&&<span style={{color:"#6366f1",fontSize:18}}>✓</span>}
                    </div>
                  );
                })}
                {filteredPairs.length===0&&pairSearch&&
                  <div style={{textAlign:"center",color:"#94a3b8",fontSize:13,padding:"12px 0",fontFamily:FONT}}>Sonuç bulunamadı</div>}
              </div>
            </>}
          </div>

          {/* Page count selector */}
          <div>
            <label style={lbl}>SAYFA SAYISI</label>
            <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:7}}>
              {[
                {id:"auto", label:"Otomatik", sub:"akıllı bölme"},
                {id:"1",    label:"1 Sayfa",  sub:"tek sayfaya sığdır"},
                {id:"2",    label:"2 Sayfa",  sub:"2 yatay parça"},
                {id:"4",    label:"4 Sayfa",  sub:"2×2 ızgara"},
                {id:"6",    label:"6 Sayfa",  sub:"2×3 ızgara"},
                {id:"9",    label:"9 Sayfa",  sub:"3×3 ızgara"},
                {id:"12",   label:"12 Sayfa", sub:"3×4 ızgara"},
                {id:"16",   label:"16 Sayfa", sub:"4×4 ızgara"},
              ].map(opt=>(
                <div key={opt.id} onClick={()=>setPageTarget(opt.id)}
                  style={{padding:"9px 6px",borderRadius:10,border:"2px solid "+(pageTarget===opt.id?"#6366f1":"#e2e8f0"),background:pageTarget===opt.id?"#eef2ff":"#f8faff",cursor:"pointer",textAlign:"center"}}>
                  <div style={{fontSize:12,fontWeight:700,color:pageTarget===opt.id?"#6366f1":"#1e293b",fontFamily:FONT,lineHeight:1.2}}>{opt.label}</div>
                  <div style={{fontSize:9,color:"#94a3b8",fontFamily:FONT,marginTop:2,lineHeight:1.2}}>{opt.sub}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Preview info */}
          <div style={{background:"#f8faff",borderRadius:12,padding:"12px 14px",display:"flex",alignItems:"center",gap:10}}>
            <span style={{fontSize:22}}>📄</span>
            <div style={{flex:1}}>
              <div style={{fontSize:14,fontWeight:700,color:"#1e293b",fontFamily:FONT}}>{tree.name}</div>
              <div style={{fontSize:12,color:"#6366f1",fontFamily:FONT,marginTop:2}}>{scopeLabel()}</div>
              <div style={{fontSize:11,color:"#94a3b8",fontFamily:FONT,marginTop:1}}>
                Yatay A4
                {pageEst!==null && <span style={{color:"#6366f1",fontWeight:600}}> · Tahmini <span style={{color:"#4f46e5"}}>{pageEst} sayfa</span></span>}
              </div>
            </div>
          </div>

          {/* Status */}
          {status&&<div style={{textAlign:"center",fontSize:13,fontFamily:FONT,color:status.startsWith("✓")?"#10b981":"#64748b"}}>{status}</div>}

          <div style={{background:"#eef2ff",border:"1px solid #c7d2fe",borderRadius:10,padding:"11px 14px",fontSize:13,color:"#4f46e5",lineHeight:1.6,fontFamily:FONT}}>
            💡 Açılan pencerede print diyaloğu başlar. <strong>"PDF Olarak Kaydet"</strong> seçin.
          </div>
          <button onClick={handlePrint} disabled={generating}
            style={{background:generating?"#c7d2fe":"#6366f1",border:"1px solid #6366f1",borderRadius:12,color:"#ffffff",padding:"15px",fontSize:16,cursor:generating?"not-allowed":"pointer",fontWeight:700,width:"100%",fontFamily:FONT}}>
            {generating?"⏳ Hazırlanıyor…":"🖨️ Yazdır / PDF Kaydet"}
          </button>
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
  const [showExport,setShowExport]=useState(false);
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
  const handleSaveRel=data=>{ if(relModal==="new"){
    // For parent rels: skip if the child already has this parent OR the parent's spouse as parent
    if(data.type==="parent"){
      const spousesOfP1=rels.filter(r=>r.type==="spouse"&&(r.p1===data.p1||r.p2===data.p1)).map(r=>r.p1===data.p1?r.p2:r.p1);
      const alreadyCovered=rels.some(r=>r.type==="parent"&&r.p2===data.p2&&(r.p1===data.p1||spousesOfP1.includes(r.p1)));
      if(!alreadyCovered) setRels(prev=>[...prev,{...data,id:"r"+Date.now()}]);
      else alert("Bu çocuk için zaten bir ebeveyn ilişkisi tanımlı. Eşler otomatik ortak ebeveyn sayılır.");
    } else {
      const dup=rels.some(r=>r.type===data.type&&((r.p1===data.p1&&r.p2===data.p2)||(r.p1===data.p2&&r.p2===data.p1)));
      if(!dup) setRels(prev=>[...prev,{...data,id:"r"+Date.now()}]);
    }
  } else { setRels(prev=>prev.map(r=>r.id===relModal.id?{...r,...data}:r)); } setRelModal(null); };
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
        <button onClick={()=>setShowExport(true)} style={{...btn(false,true),flexShrink:0,color:"#10b981",borderColor:"#86efac"}}>🖼️</button>
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

        {/* ── Kişiler Grid ── */}
        {tab==="kişiler"&&(
          <div style={{flex:1,overflow:"auto",padding:14}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
              <span style={{fontSize:14,color:"#64748b",fontWeight:600}}>👥 KİŞİLER ({people.length})</span>
              <button onClick={openAddPerson} style={btn(true,true)}>+ Yeni Kişi</button>
            </div>
            <div style={{position:"relative",marginBottom:12}}>
              <span style={{position:"absolute",left:11,top:"50%",transform:"translateY(-50%)",color:"#94a3b8",fontSize:15,pointerEvents:"none"}}>🔍</span>
              <input value={peopleSearch} onChange={e=>setPeopleSearch(e.target.value)} placeholder="İsme göre ara…"
                style={{background:"#ffffff",border:"1px solid #e2e8f0",borderRadius:9,color:"#1e293b",padding:"9px 12px 9px 34px",fontSize:14,outline:"none",width:"100%",fontFamily:FONT}}/>
              {peopleSearch&&<button onClick={()=>setPeopleSearch("")} style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",background:"transparent",border:"none",color:"#94a3b8",cursor:"pointer",fontSize:16,lineHeight:1}}>✕</button>}
            </div>
            {filteredPeople.length===0&&peopleSearch
              ?<div style={{textAlign:"center",color:"#94a3b8",padding:"20px 0",fontSize:14}}>"{peopleSearch}" için sonuç yok</div>
              :<DragGrid
                items={filteredPeople}
                columns="repeat(auto-fill,minmax(130px,1fr))"
                onReorder={filtered=>{
                  if(!peopleSearch.trim()){ setPeople(filtered); return; }
                  const ids=filtered.map(p=>p.id);
                  const next=[...people]; let fi=0;
                  next.forEach((_,i)=>{ if(ids.includes(next[i].id)) next[i]=filtered[fi++]; });
                  setPeople(next);
                }}
                renderItem={(p)=>{
                  const isOutsider=(()=>{ const hp=new Set(rels.filter(r=>r.type==="parent").map(r=>r.p2)); const hs=new Set([...rels.filter(r=>r.type==="spouse").map(r=>r.p1),...rels.filter(r=>r.type==="spouse").map(r=>r.p2)]); return hs.has(p.id)&&!hp.has(p.id); })();
                  const gCol=p.gender==="male"?C.male:C.female;
                  const gBg=p.gender==="male"?"#dbeafe":"#fce7f3";
                  return (
                    <div key={p.id} onClick={()=>setSelId(p.id===selId?null:p.id)}
                      style={{background:"#ffffff",border:"2px solid "+(selId===p.id?"#6366f1":gCol),borderRadius:16,overflow:"hidden",display:"flex",flexDirection:"column",alignItems:"center",cursor:"pointer",boxShadow:selId===p.id?"0 0 0 3px #c7d2fe":"0 2px 8px rgba(99,102,241,0.08)",position:"relative",transition:"box-shadow 0.15s"}}>
                      {/* Photo area — portrait (3:4 ratio) */}
                      <div style={{width:"100%",aspectRatio:"3/4",position:"relative",overflow:"hidden",background:gBg,display:"flex",alignItems:"center",justifyContent:"center"}}>
                        {p.photo
                          ?<img src={p.photo} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
                          :<span style={{fontSize:52,color:gCol,opacity:0.5}}>{p.gender==="male"?"♂":"♀"}</span>
                        }
                        {/* Oval vignette overlay for portrait feel */}
                        <div style={{position:"absolute",inset:0,boxShadow:"inset 0 0 0 3px "+gCol+"55",borderRadius:0,pointerEvents:"none"}}/>
                        {/* Oval frame at bottom */}
                        <div style={{position:"absolute",bottom:-1,left:"50%",transform:"translateX(-50%)",width:"110%",height:28,background:"#ffffff",borderRadius:"50% 50% 0 0",border:"2px solid "+gCol,borderBottom:"none"}}/>
                      </div>
                      {/* Info section */}
                      <div style={{width:"100%",padding:"8px 10px 6px",display:"flex",flexDirection:"column",alignItems:"center",gap:3}}>
                        {/* Badge */}
                        <div style={{background:isOutsider?"#fef3c7":gBg,border:"1px solid "+(isOutsider?"#fcd34d":gCol),borderRadius:4,fontSize:9,color:isOutsider?"#92400e":gCol,padding:"1px 6px",fontWeight:600,fontFamily:FONT,marginBottom:1}}>
                          {isOutsider?"dışarıdan":p.gender==="male"?"♂ Erkek":"♀ Kadın"}
                        </div>
                        {/* Name: first name above, surname below */}
                        {(()=>{const pts=p.name.trim().split(" ");const soyad=pts.length>1?pts[pts.length-1]:"";const ad=pts.length>1?pts.slice(0,-1).join(" "):pts[0];return(
                          <div style={{textAlign:"center",lineHeight:1.35,width:"100%"}}>
                            <div style={{fontSize:11,fontWeight:500,color:"#475569",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{ad}</div>
                            <div style={{fontSize:13,fontWeight:800,color:"#1e293b",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{soyad||ad}{p.died&&<span style={{color:"#94a3b8",fontSize:10}}> ✝</span>}</div>
                          </div>
                        );})()}
                        {/* Years */}
                        <div style={{fontSize:11,color:"#64748b",textAlign:"center"}}>{p.born||"?"}{p.died?" – "+p.died:""}</div>
                        {/* Actions */}
                        <div style={{display:"flex",gap:5,marginTop:5}} onClick={e=>e.stopPropagation()}>
                          <button onClick={()=>openEditPerson(p)} style={{background:"#eef2ff",border:"1px solid #a5b4fc",borderRadius:7,color:"#6366f1",padding:"5px 9px",fontSize:13,cursor:"pointer"}}>✏️</button>
                          <button onClick={()=>setConfirmPerson(p.id)} style={{background:"#fef2f2",border:"1px solid #fca5a5",borderRadius:7,color:"#ef4444",padding:"5px 9px",fontSize:13,cursor:"pointer"}}>🗑</button>
                        </div>
                        {/* Bottom colour strip — same as SVG node */}
                        <div style={{width:"100%",height:5,background:gCol,marginTop:6,borderRadius:"0 0 2px 2px",flexShrink:0}}/>
                      </div>
                    </div>
                  ); }}
              />
            }
          </div>
        )}

        {/* ── İlişkiler Grid ── */}
        {tab==="ilişkiler"&&(
          <div style={{flex:1,overflow:"auto",padding:14}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
              <span style={{fontSize:14,color:"#64748b",fontWeight:600}}>🔗 İLİŞKİLER ({rels.length})</span>
              <button onClick={openAddRel} style={btn(true,true)}>+ Yeni İlişki</button>
            </div>
            <div style={{position:"relative",marginBottom:12}}>
              <span style={{position:"absolute",left:11,top:"50%",transform:"translateY(-50%)",color:"#94a3b8",fontSize:15,pointerEvents:"none"}}>🔍</span>
              <input value={relsSearch} onChange={e=>setRelsSearch(e.target.value)} placeholder="İsim veya ilişki türü ara…"
                style={{background:"#ffffff",border:"1px solid #e2e8f0",borderRadius:9,color:"#1e293b",padding:"9px 12px 9px 34px",fontSize:14,outline:"none",width:"100%",fontFamily:FONT}}/>
              {relsSearch&&<button onClick={()=>setRelsSearch("")} style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",background:"transparent",border:"none",color:"#94a3b8",cursor:"pointer",fontSize:16,lineHeight:1}}>✕</button>}
            </div>
            {filteredRels.length===0&&relsSearch
              ?<div style={{textAlign:"center",color:"#94a3b8",padding:"20px 0",fontSize:14}}>"{relsSearch}" için sonuç yok</div>
              :<DragGrid
                items={filteredRels}
                columns="repeat(auto-fill,minmax(200px,1fr))"
                onReorder={filtered=>{
                  if(!relsSearch.trim()){ setRels(filtered); return; }
                  const ids=filtered.map(r=>r.id);
                  const next=[...rels]; let fi=0;
                  next.forEach((_,i)=>{ if(ids.includes(next[i].id)) next[i]=filtered[fi++]; });
                  setRels(next);
                }}
                renderItem={(r)=>{ const d=RMAP[r.type]||{}; const p1=people.find(p=>p.id===r.p1); const p2=people.find(p=>p.id===r.p2);
                  // Portrait mini-card for one person
                  const PersonCard=({px})=>{
                    if(!px) return <div style={{flex:1}}/>;
                    const gc=px.gender==="male"?C.male:C.female;
                    const gb=px.gender==="male"?"#dbeafe":"#fce7f3";
                    return (
                      <div style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",minWidth:0}}>
                        <div style={{width:"100%",aspectRatio:"3/4",position:"relative",overflow:"hidden",borderRadius:"10px",border:"2.5px solid "+gc,background:gb,display:"flex",alignItems:"center",justifyContent:"center",marginBottom:5}}>
                          {px.photo
                            ?<img src={px.photo} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
                            :<span style={{fontSize:30,color:gc,opacity:0.5}}>{px.gender==="male"?"♂":"♀"}</span>
                          }
                          <div style={{position:"absolute",inset:0,boxShadow:"inset 0 0 0 2px "+gc+"44",borderRadius:"inherit",pointerEvents:"none"}}/>
                        </div>
                        <div style={{fontSize:11,fontWeight:700,color:"#1e293b",textAlign:"center",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",maxWidth:"100%",lineHeight:1.3}}>
                          {px.name}{px.died&&<span style={{color:"#94a3b8",fontSize:10}}> ✝</span>}
                        </div>
                        {px.born&&<div style={{fontSize:10,color:"#64748b",marginTop:1}}>{px.born}{px.died?" – "+px.died:""}</div>}
                      </div>
                    );
                  };
                  return(
                  <div key={r.id} style={{background:"#ffffff",border:"1px solid #e2e8f0",borderRadius:16,overflow:"hidden",display:"flex",flexDirection:"column",boxShadow:"0 2px 8px rgba(99,102,241,0.07)"}}>
                    {/* Colour strip */}
                    <div style={{height:4,background:d.color||"#6366f1",flexShrink:0}}/>
                    {/* Type badge */}
                    <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:6,padding:"8px 10px 4px"}}>
                      <span style={{fontSize:16}}>{d.icon||"🔗"}</span>
                      <span style={{fontSize:12,fontWeight:700,color:d.color||"#6366f1",background:(d.color||"#6366f1")+"18",padding:"2px 10px",borderRadius:20,fontFamily:FONT}}>{d.label||r.type}</span>
                    </div>
                    {/* Two portrait cards side by side */}
                    <div style={{display:"flex",alignItems:"flex-start",gap:6,padding:"6px 10px 8px"}}>
                      <PersonCard px={p1}/>
                      {/* Arrow */}
                      <div style={{display:"flex",alignItems:"center",justifyContent:"center",paddingTop:"30%",flexShrink:0}}>
                        <span style={{fontSize:18,color:d.color||"#6366f1",fontWeight:700}}>{d.bi?"↔":"→"}</span>
                      </div>
                      <PersonCard px={p2}/>
                    </div>
                    {/* Actions */}
                    <div style={{display:"flex",gap:6,padding:"0 10px 10px",justifyContent:"flex-end"}}>
                      <button onClick={()=>openEditRel(r)} style={{background:"#eef2ff",border:"1px solid #a5b4fc",borderRadius:7,color:"#6366f1",padding:"5px 10px",fontSize:13,cursor:"pointer"}}>✏️</button>
                      <button onClick={()=>setConfirmRel(r.id)} style={{background:"#fef2f2",border:"1px solid #fca5a5",borderRadius:7,color:"#ef4444",padding:"5px 10px",fontSize:13,cursor:"pointer"}}>🗑</button>
                    </div>
                  </div>
                ); }}
              />
            }
          </div>
        )}
      </div>

      {personModal&&<PersonModal person={personModal==="new"?null:personModal} onSave={handleSavePerson} onClose={()=>setPersonModal(null)}/>}
      {relModal&&<RelModal rel={relModal==="new"?null:relModal} people={peopleWithRels} onSave={handleSaveRel} onClose={()=>setRelModal(null)}/>}
      {confirmPerson&&<Confirm message={'"'+(people.find(p=>p.id===confirmPerson)||{}).name+'" silinsin mi?'} onYes={()=>delPerson(confirmPerson)} onNo={()=>setConfirmPerson(null)}/>}
      {confirmRel&&<Confirm message="Bu ilişkiyi silmek istediğinizden emin misiniz?" onYes={()=>delRel(confirmRel)} onNo={()=>setConfirmRel(null)}/>}
      {showPrint&&<PrintModal tree={{name:treeName,people,rels}} onClose={()=>setShowPrint(false)}/>}
      {showExport&&<ExportModal tree={{name:treeName,people,rels}} onClose={()=>setShowExport(false)}/>}
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

// ─── Login ────────────────────────────────────────────────────────────────────
const AUTH_USER = "erensoft";
const AUTH_PASS = "sakaeli";
const AUTH_KEY  = "soyagaci_auth";

function LoginScreen({onLogin}) {
  const [user,setUser]   = useState("");
  const [pass,setPass]   = useState("");
  const [showPass,setShowPass] = useState(false);
  const [err,setErr]     = useState("");
  const [shake,setShake] = useState(false);

  const handleSubmit = () => {
    if(user.trim()===AUTH_USER && pass===AUTH_PASS){
      try { sessionStorage.setItem(AUTH_KEY,"1"); } catch{}
      onLogin();
    } else {
      setErr("Kullanıcı adı veya şifre hatalı.");
      setShake(true);
      setTimeout(()=>setShake(false),600);
    }
  };

  return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",minHeight:"100vh",background:"#f0f4ff",fontFamily:FONT,padding:20}}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap');*{box-sizing:border-box}input::placeholder{color:#94a3b8}@keyframes shake{0%,100%{transform:translateX(0)}20%,60%{transform:translateX(-8px)}40%,80%{transform:translateX(8px)}}.shake{animation:shake 0.5s ease}`}</style>
      <div className={shake?"shake":""} style={{background:"#ffffff",borderRadius:24,boxShadow:"0 8px 40px rgba(99,102,241,0.13)",padding:"36px 28px",width:"100%",maxWidth:380,border:"1px solid #e2e8f0"}}>
        {/* Logo */}
        <div style={{textAlign:"center",marginBottom:28}}>
          <div style={{fontSize:48,marginBottom:8}}>🌳</div>
          <div style={{fontSize:22,fontWeight:700,color:"#6366f1",fontFamily:FONT}}>SOY AĞACI</div>
          <div style={{fontSize:12,color:"#94a3b8",letterSpacing:"0.08em",marginTop:2}}>AİLE BAĞLARI HARİTASI</div>
        </div>
        {/* Fields */}
        <div style={{display:"flex",flexDirection:"column",gap:14}}>
          <div>
            <label style={{fontSize:12,fontWeight:600,color:"#64748b",display:"block",marginBottom:6,fontFamily:FONT}}>KULLANICI ADI</label>
            <input
              autoFocus
              value={user}
              onChange={e=>{setUser(e.target.value);setErr("");}}
              onKeyDown={e=>e.key==="Enter"&&document.getElementById("pass-input")?.focus()}
              placeholder="Kullanıcı adınızı girin"
              style={{width:"100%",background:"#f8faff",border:"1px solid #e2e8f0",borderRadius:10,padding:"13px 15px",fontSize:15,color:"#1e293b",outline:"none",fontFamily:FONT}}/>
          </div>
          <div>
            <label style={{fontSize:12,fontWeight:600,color:"#64748b",display:"block",marginBottom:6,fontFamily:FONT}}>ŞİFRE</label>
            <div style={{position:"relative"}}>
              <input
                id="pass-input"
                type={showPass?"text":"password"}
                value={pass}
                onChange={e=>{setPass(e.target.value);setErr("");}}
                onKeyDown={e=>e.key==="Enter"&&handleSubmit()}
                placeholder="Şifrenizi girin"
                style={{width:"100%",background:"#f8faff",border:"1px solid #e2e8f0",borderRadius:10,padding:"13px 42px 13px 15px",fontSize:15,color:"#1e293b",outline:"none",fontFamily:FONT}}/>
              <button onClick={()=>setShowPass(v=>!v)} style={{position:"absolute",right:12,top:"50%",transform:"translateY(-50%)",background:"transparent",border:"none",cursor:"pointer",fontSize:18,color:"#94a3b8",padding:0}}>
                {showPass?"🙈":"👁️"}
              </button>
            </div>
          </div>
          {err&&(
            <div style={{background:"#fef2f2",border:"1px solid #fca5a5",borderRadius:9,padding:"10px 14px",fontSize:13,color:"#ef4444",fontFamily:FONT,textAlign:"center"}}>
              ⚠️ {err}
            </div>
          )}
          <button
            onClick={handleSubmit}
            disabled={!user.trim()||!pass}
            style={{background:(user.trim()&&pass)?"#6366f1":"#c7d2fe",border:"none",borderRadius:12,color:"#ffffff",padding:"14px",fontSize:16,cursor:(user.trim()&&pass)?"pointer":"not-allowed",fontWeight:700,fontFamily:FONT,marginTop:4,transition:"background 0.2s"}}>
            Giriş Yap
          </button>
        </div>
        <div style={{textAlign:"center",marginTop:20,fontSize:12,color:"#cbd5e1",fontFamily:FONT}}>
          © {new Date().getFullYear()} Soy Ağacı · Tüm hakları saklıdır
        </div>
      </div>
    </div>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────
export default function App() {
  const [authed,setAuthed] = useState(()=>{ try { return sessionStorage.getItem(AUTH_KEY)==="1"; } catch { return false; } });
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

  if(!authed) return <LoginScreen onLogin={()=>setAuthed(true)}/>;
  if(openId&&currentTree) return <div><style>{STYLE}</style><TreeEditor tree={currentTree} onSave={saveTree} onBack={()=>setOpenId(null)}/></div>;
  return <div><style>{STYLE}</style><Home trees={trees} loading={loading} onOpen={setOpenId} onCreate={createTree} onDelete={deleteTree} onImport={importTree} onExport={exportTree}/></div>;
}
