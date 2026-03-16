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
async function storageGet(k)    { try { const r=await window.storage.get(k);    return r?JSON.parse(r.value):null; } catch { return null; } }
async function storageSet(k,v)  { try { await window.storage.set(k,JSON.stringify(v)); return true; } catch { return false; } }
async function storageDel(k)    { try { await window.storage.delete(k); return true; } catch { return false; } }
async function storageList(pfx) { try { const r=await window.storage.list(pfx); return r?r.keys:[]; } catch { return []; } }

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

// ─── Layout ───────────────────────────────────────────────────────────────────
function buildLayout(people, rels) {
  if (!people.length) return { pos:{}, bbox:{x0:0,y0:0,w:400,h:300} };

  // Build adjacency maps
  const down={}, up={}, lat={};
  people.forEach(p=>{ down[p.id]=[]; up[p.id]=[]; lat[p.id]=[]; });
  rels.forEach(({type,p1,p2})=>{
    if (!people.find(p=>p.id===p1) || !people.find(p=>p.id===p2)) return;
    if (VERTICAL.has(type)) {
      if (!down[p1].includes(p2)) down[p1].push(p2);
      if (!up[p2].includes(p1))   up[p2].push(p1);
    } else if (HORIZONTAL.has(type)) {
      if (!lat[p1].includes(p2)) lat[p1].push(p2);
      if (!lat[p2].includes(p1)) lat[p2].push(p1);
    }
  });

  // STEP 1: Assign levels via topological sort (level = max parent level + 1)
  const lev = {};
  const roots = people.filter(p => !up[p.id].length).map(p => p.id);

  // Iterative level assignment - keep pushing until stable
  roots.forEach(id => { lev[id] = 0; });
  people.forEach(p => { if (lev[p.id] === undefined) lev[p.id] = 0; });

  let changed = true;
  let iter = 0;
  while (changed && iter < 20) {
    changed = false; iter++;
    people.forEach(p => {
      const parentLevels = (up[p.id] || []).map(pid => lev[pid] ?? 0);
      const needed = parentLevels.length > 0 ? Math.max(...parentLevels) + 1 : lev[p.id] ?? 0;
      if ((lev[p.id] ?? 0) < needed) { lev[p.id] = needed; changed = true; }
    });
  }

  // STEP 2: Snap spouses/siblings to same level (take the maximum)
  changed = true; iter = 0;
  while (changed && iter < 10) {
    changed = false; iter++;
    people.forEach(p => {
      (lat[p.id] || []).forEach(lid => {
        const nl = Math.max(lev[p.id] ?? 0, lev[lid] ?? 0);
        if (lev[p.id] !== nl) { lev[p.id] = nl; changed = true; }
        if (lev[lid] !== nl) { lev[lid] = nl; changed = true; }
      });
    });
  }

  // STEP 3: Re-check children are below their parents after lat-snap
  changed = true; iter = 0;
  while (changed && iter < 10) {
    changed = false; iter++;
    people.forEach(p => {
      (down[p.id] || []).forEach(cid => {
        const needed = (lev[p.id] ?? 0) + 1;
        if ((lev[cid] ?? 0) < needed) { lev[cid] = needed; changed = true; }
      });
    });
  }

  // STEP 4: Compact levels — remap to consecutive integers 0,1,2,...
  const usedLevels = [...new Set(Object.values(lev))].sort((a,b)=>a-b);
  const levelMap = {};
  usedLevels.forEach((l,i) => { levelMap[l] = i; });
  people.forEach(p => { lev[p.id] = levelMap[lev[p.id] ?? 0]; });

  // STEP 5: Group by level
  const byLev = {};
  people.forEach(p => {
    const l = lev[p.id] ?? 0;
    (byLev[l] = byLev[l] || []).push(p.id);
  });

  // STEP 6: Position nodes — cluster spouses/siblings together
  const pos = {};
  const SLOT = NW + MIN_GAP; // guaranteed slot width per node

  Object.keys(byLev).sort((a,b)=>+a-+b).forEach(l => {
    const ids = byLev[l];
    // Build clusters of lateral peers
    const clustered = new Set(), groups = [];
    ids.forEach(id => {
      if (clustered.has(id)) return;
      const cluster = [id]; clustered.add(id);
      const bfs = [id];
      while (bfs.length) {
        const cur = bfs.shift();
        (lat[cur] || []).forEach(lid => {
          if (!clustered.has(lid) && ids.includes(lid)) {
            cluster.push(lid); clustered.add(lid); bfs.push(lid);
          }
        });
      }
      groups.push(cluster);
    });

    // Total width: each node gets SLOT, spouse pairs get SLOT each
    const totalNodes = ids.length;
    const totalW = totalNodes * SLOT;
    let x = -totalW / 2;
    const y = +l * (NH + VGAP);

    groups.forEach(group => {
      group.forEach((id, i) => {
        pos[id] = { x: x + i * SLOT + NW / 2, y: y + NH / 2 };
      });
      x += group.length * SLOT;
    });
  });

  const xs = Object.values(pos).map(p => p.x);
  const ys = Object.values(pos).map(p => p.y);
  const x0 = Math.min(...xs) - NW/2 - 30;
  const x1 = Math.max(...xs) + NW/2 + 30;
  const y0 = Math.min(...ys) - NH/2 - 30;
  const y1 = Math.max(...ys) + NH/2 + 30;
  return { pos, bbox: { x0, y0, w: x1-x0, h: y1-y0 } };
}

// ─── SVG Node ─────────────────────────────────────────────────────────────────
function Node({person,p,sel,onClick}) {
  const col=person.gender==="male"?C.male:C.female;
  const colLight=person.gender==="male"?"#dbeafe":"#fce7f3";
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
      <rect width={NW} height={NH} rx={14} fill={sel?colLight:"#ffffff"} stroke={col} strokeWidth={sel?2.5:1.5} filter={"url(#sh-"+person.id+")"} opacity={isDead?0.65:1}/>
      <rect width={NW} height={5} rx={2} fill={col}/>
      {person.photo
        ?<image href={person.photo} x={NW/2-25} y={13} width={50} height={50} clipPath={"url(#cp-"+person.id+")"} preserveAspectRatio="xMidYMid slice"/>
        :<><circle cx={NW/2} cy={38} r={25} fill={colLight} stroke={col} strokeWidth={1.5}/><text x={NW/2} y={46} textAnchor="middle" fill={col} fontSize={20} fontFamily="serif">{person.gender==="male"?"♂":"♀"}</text></>
      }
      <circle cx={NW/2} cy={38} r={25} fill="none" stroke={col} strokeWidth={1.5} opacity={0.5}/>
      {isDead&&<text x={NW-12} y={18} fill="#94a3b8" fontSize={13}>✝</text>}
      <text x={NW/2} y={76} textAnchor="middle" fill="#1e293b" fontSize={11} fontWeight="700" fontFamily={FONT}>
        {person.name.length>18?person.name.slice(0,17)+"…":person.name}
      </text>
      <text x={NW/2} y={92} textAnchor="middle" fill="#64748b" fontSize={10} fontFamily={FONT}>
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
  const {pos,bbox}=buildLayout(people,rels);

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

  const drawn=new Set();
  const lines=rels.map(r=>{
    const a=pos[r.p1],b=pos[r.p2]; if(!a||!b) return null;
    const def=RMAP[r.type]||{},col=def.color||"#94a3b8";
    if(HORIZONTAL.has(r.type)){ const key=[r.p1,r.p2].sort().join("|")+r.type; if(drawn.has(key)) return null; drawn.add(key); const mx=(a.x+b.x)/2,my=(a.y+b.y)/2;
      return(<g key={"h-"+key}><line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={col} strokeWidth={2} strokeDasharray={r.type==="spouse"?"6 3":"none"} opacity={0.75}/>{r.type==="spouse"&&<text x={mx} y={my-5} textAnchor="middle" fontSize={12} fill={col}>♥</text>}</g>); }
    if(VERTICAL.has(r.type)){ const dash=r.type==="grandparent"?"7 4":r.type==="uncle"?"3 3":"none"; const cy=(a.y+b.y)/2;
      return <path key={"v-"+r.id} d={"M"+a.x+","+(a.y+NH/2)+" C"+a.x+","+(cy+18)+" "+b.x+","+(cy-18)+" "+b.x+","+(b.y-NH/2)} fill="none" stroke={col} strokeWidth={2} strokeDasharray={dash} opacity={0.8}/>; }
    return null;
  });

  return (
    <div ref={wrapRef} style={{position:"relative",width:"100%",height:"100%",background:"#f0f4ff",borderRadius:14,overflow:"hidden",border:"1px solid #d1d9f0"}}>
      <svg ref={svgRef} width={sz.w} height={sz.h} style={{display:"block",userSelect:"none"}}
        onMouseDown={md} onMouseMove={mm} onMouseUp={mu} onMouseLeave={mu} onWheel={wh}
        onClick={()=>onSelect(null)}>
        <g transform={"translate("+vp.x+","+vp.y+") scale("+vp.s+")"}>
          {lines}
          {people.map(p=>{ const pt=pos[p.id]; if(!pt) return null; return <Node key={p.id} person={p} p={pt} sel={selId===p.id} onClick={onSelect}/>; })}
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
            <select style={inp} value={form.p1} onChange={e=>set("p1",e.target.value)}>
              <option value="">Seçin…</option>
              {people.map(p=><option key={p.id} value={p.id}>{optLabel(p)}</option>)}
            </select>
          </div>
          <div><label style={lbl}>{relDef.bi?"KİŞİ 2":"ALTTAKİ (Çocuk / Torun / Yeğen vb.)"}</label>
            <select style={inp} value={form.p2} onChange={e=>set("p2",e.target.value)}>
              <option value="">Seçin…</option>
              {people.filter(p=>p.id!==form.p1).map(p=><option key={p.id} value={p.id}>{optLabel(p)}</option>)}
            </select>
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

function buildPrintHTML(tree,treeImg) {
  const people=tree.people||[],rels=tree.rels||[];
  const pname=id=>(people.find(p=>p.id===id)||{}).name||"?";
  const today=new Date().toLocaleDateString("tr-TR",{day:"2-digit",month:"long",year:"numeric"});
  const peopleRows=people.map((p,i)=>'<tr style="border-bottom:1px solid #eee;background:'+(i%2===0?"#f9f9f9":"white")+'"><td style="padding:6px 8px;color:#888">'+(i+1)+'</td><td style="padding:6px 8px;font-weight:600">'+(p.photo?'<img src="'+p.photo+'" style="width:20px;height:20px;border-radius:50%;object-fit:cover;vertical-align:middle;margin-right:6px"/>':""+p.name)+'</td><td style="padding:6px 8px">'+(p.gender==="male"?"Erkek":"Kadın")+'</td><td style="padding:6px 8px">'+(p.born||"—")+'</td><td style="padding:6px 8px">'+(p.died||"—")+'</td></tr>').join("");
  const relRows=rels.map((r,i)=>{ const def=RMAP[r.type]||{}; return '<tr style="border-bottom:1px solid #eee;background:'+(i%2===0?"#f9f9f9":"white")+'"><td style="padding:6px 8px;color:#888">'+(i+1)+'</td><td style="padding:6px 8px;font-weight:600">'+pname(r.p1)+'</td><td style="padding:6px 8px"><span style="background:#f0f0f0;border-radius:4px;padding:2px 8px;font-size:12px">'+def.icon+" "+(def.label||r.type)+'</span></td><td style="padding:6px 8px;font-weight:600">'+pname(r.p2)+'</td></tr>'; }).join("");
  return '<!DOCTYPE html><html lang="tr"><head><meta charset="UTF-8"/><title>'+tree.name+'</title><style>*{box-sizing:border-box;margin:0;padding:0;font-family:sans-serif}body{background:white;color:#111}.page{padding:14mm;min-height:100vh}.title{text-align:center;margin-bottom:12px}.title h1{font-size:22px;font-weight:700}.title p{font-size:11px;color:#666;margin-top:4px}hr{border:none;border-top:1px solid #ccc;margin-bottom:14px}table{width:100%;border-collapse:collapse;font-size:12px}th{text-align:left;padding:6px 8px;border-bottom:2px solid #333;font-weight:700}.footer{margin-top:10px;font-size:9px;color:#aaa;text-align:right}@media print{.page{page-break-after:always;break-after:page}.page:last-child{page-break-after:avoid;break-after:avoid}@page{margin:8mm;size:A4}}</style></head><body><div class="page"><div class="title"><h1>'+tree.name+'</h1><p>Soy Ağacı Diyagramı &middot; '+today+'</p></div><hr/>'+(treeImg?'<img src="'+treeImg+'" style="width:100%;height:auto;max-height:225mm;object-fit:contain"/>':"")+'<div class="footer">'+people.length+' kişi &middot; '+rels.length+' ilişki</div></div><div class="page"><div class="title"><h1>'+tree.name+'</h1><p>Aile Üyeleri &middot; '+today+'</p></div><hr/><table><thead><tr><th>#</th><th>Ad Soyad</th><th>Cinsiyet</th><th>Doğum</th><th>Ölüm</th></tr></thead><tbody>'+peopleRows+'</tbody></table></div><div class="page"><div class="title"><h1>'+tree.name+'</h1><p>İlişkiler &middot; '+today+'</p></div><hr/><table><thead><tr><th>#</th><th>Kişi 1</th><th>İlişki</th><th>Kişi 2</th></tr></thead><tbody>'+relRows+'</tbody></table></div><script>window.onload=function(){window.print();window.onafterprint=function(){window.close();};};<\/script></body></html>';
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
            {[{icon:"🌳",l:"Sayfa 1",d:"Soy Ağacı Diyagramı"},{icon:"👥",l:"Sayfa 2",d:"Üyeler — "+people.length+" kişi"},{icon:"🔗",l:"Sayfa 3",d:"İlişkiler — "+rels.length}].map(r=>(
              <div key={r.l} style={{display:"flex",alignItems:"center",gap:10,marginBottom:5}}><span style={{fontSize:16,width:24,textAlign:"center"}}>{r.icon}</span><span style={{color:"#6366f1",fontSize:13,fontWeight:600,minWidth:58,fontFamily:FONT}}>{r.l}</span><span style={{color:"#64748b",fontSize:13,fontFamily:FONT}}>{r.d}</span></div>
            ))}
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

  const selPerson=people.find(p=>p.id===selId);

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
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
              <span style={{fontSize:14,color:"#64748b",fontWeight:600}}>👥 KİŞİLER ({people.length})</span>
              <button onClick={openAddPerson} style={btn(true,true)}>+ Yeni Kişi</button>
            </div>
            <div style={{fontSize:12,color:"#94a3b8",marginBottom:10,display:"flex",alignItems:"center",gap:6}}>
              <span>⠿</span> Sürükle-bırak ile sırala
            </div>
            <DragList
              items={people}
              onReorder={setPeople}
              renderItem={(p)=>(
                <div style={{background:"#ffffff",border:"1px solid "+(selId===p.id?"#6366f1":"#e2e8f0"),borderRadius:12,padding:"12px 14px",display:"flex",alignItems:"center",gap:12,cursor:"pointer",boxShadow:"0 1px 4px rgba(99,102,241,0.05)"}} onClick={()=>setSelId(p.id===selId?null:p.id)}>
                  <span style={{color:"#d1d9f0",fontSize:18,cursor:"grab",flexShrink:0}}>⠿</span>
                  <div style={{width:40,height:40,borderRadius:"50%",flexShrink:0,overflow:"hidden",border:"2px solid "+(p.gender==="male"?C.male:C.female),background:(p.gender==="male"?"#dbeafe":"#fce7f3"),display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>
                    {p.photo?<img src={p.photo} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>:(p.gender==="male"?"♂":"♀")}
                  </div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:14,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.name}{p.died&&<span style={{color:"#94a3b8",marginLeft:6,fontSize:12}}>✝</span>}</div>
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
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
              <span style={{fontSize:14,color:"#64748b",fontWeight:600}}>🔗 İLİŞKİLER ({rels.length})</span>
              <button onClick={openAddRel} style={btn(true,true)}>+ Yeni İlişki</button>
            </div>
            <div style={{fontSize:12,color:"#94a3b8",marginBottom:10,display:"flex",alignItems:"center",gap:6}}>
              <span>⠿</span> Sürükle-bırak ile sırala
            </div>
            <DragList
              items={rels}
              onReorder={setRels}
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
