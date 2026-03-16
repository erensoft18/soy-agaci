import { useState, useRef, useEffect, useCallback } from "react";

// ─── Theme ────────────────────────────────────────────────────────────────────
const C = {
  bg:"#0f0a1e", surface:"#1a1130", card:"#221840", border:"#3d2d6e",
  accent:"#c084fc", accentDim:"#7c3aed", gold:"#f5c842",
  male:"#60a5fa", female:"#f472b6",
  text:"#e9d5ff", muted:"#9d7ec9", line:"#4c3880",
  danger:"#ef4444", success:"#34d399",
};
const NW=140, NH=96, HGAP=40, VGAP=100;

const REL_DEFS = [
  { value:"spouse",      label:"Eşler",                         icon:"💍", color:"#f5c842", bi:true  },
  { value:"parent",      label:"Ebeveyn → Çocuk",               icon:"👨‍👧", color:"#a78bfa", bi:false },
  { value:"sibling",     label:"Kardeş",                        icon:"🤝", color:"#34d399", bi:true  },
  { value:"grandparent", label:"Büyükanne/baba → Torun",        icon:"👴", color:"#fb923c", bi:false },
  { value:"uncle",       label:"Amca/Dayı/Hala/Teyze → Yeğen", icon:"🧑", color:"#38bdf8", bi:false },
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
function readFileAsBase64(file) {
  return new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(r.result); r.onerror=rej; r.readAsDataURL(file); });
}
function resizeImage(dataUrl, max=220) {
  return new Promise(res=>{ const img=new Image(); img.onload=()=>{ const s=Math.min(max/img.width,max/img.height,1); const w=Math.round(img.width*s),h=Math.round(img.height*s); const c=document.createElement("canvas"); c.width=w; c.height=h; c.getContext("2d").drawImage(img,0,0,w,h); res(c.toDataURL("image/jpeg",0.82)); }; img.src=dataUrl; });
}
function exportTree(tree) {
  const blob=new Blob([JSON.stringify(tree,null,2)],{type:"application/json"});
  const url=URL.createObjectURL(blob), a=document.createElement("a");
  a.href=url; a.download=`${tree.name.replace(/[^a-zA-Z0-9_\u00C0-\u024F ]/g,"_")}.ftree.json`; a.click(); URL.revokeObjectURL(url);
}
function importTreeFile(file) {
  return new Promise((res,rej)=>{ const r=new FileReader(); r.onload=e=>{ try { const d=JSON.parse(e.target.result); if(!d.name||!Array.isArray(d.people)||!Array.isArray(d.rels)) return rej(new Error("Geçersiz dosya formatı")); res(d); } catch { rej(new Error("JSON okunamadı")); } }; r.onerror=()=>rej(new Error("Dosya okunamadı")); r.readAsText(file); });
}

// ─── Layout engine ────────────────────────────────────────────────────────────
function buildLayout(people, rels) {
  const down={}, up={}, lat={};
  people.forEach(p=>{ down[p.id]=[]; up[p.id]=[]; lat[p.id]=[]; });
  rels.forEach(({type,p1,p2})=>{
    if (VERTICAL.has(type)) {
      if (!down[p1]) down[p1]=[]; if (!up[p2]) up[p2]=[];
      if (!down[p1].includes(p2)) down[p1].push(p2);
      if (!up[p2].includes(p1))   up[p2].push(p1);
    } else if (HORIZONTAL.has(type)) {
      if (!lat[p1]) lat[p1]=[]; if (!lat[p2]) lat[p2]=[];
      if (!lat[p1].includes(p2)) lat[p1].push(p2);
      if (!lat[p2].includes(p1)) lat[p2].push(p1);
    }
  });
  const lev={}, roots=people.filter(p=>!(up[p.id]||[]).length).map(p=>p.id);
  const q=roots.map(id=>[id,0]); const seen=new Set();
  while(q.length){ const [id,l]=q.shift(); if(lev[id]!==undefined&&lev[id]>=l) continue; lev[id]=l; if(seen.has(id)) continue; seen.add(id); (down[id]||[]).forEach(c=>q.push([c,l+1])); }
  people.forEach(p=>{ if(lev[p.id]===undefined) lev[p.id]=0; });
  for(let i=0;i<5;i++) people.forEach(p=>{ (lat[p.id]||[]).forEach(lid=>{ const nl=Math.max(lev[p.id]||0,lev[lid]||0); lev[p.id]=nl; lev[lid]=nl; }); });
  const byLev={};
  Object.entries(lev).forEach(([id,l])=>{ (byLev[l]=byLev[l]||[]).push(id); });
  const pos={};
  Object.keys(byLev).sort((a,b)=>+a-+b).forEach(l=>{
    const ids=byLev[l], clustered=new Set(), groups=[];
    ids.forEach(id=>{ if(clustered.has(id)) return; const cluster=[id]; clustered.add(id); const bfs=[id]; while(bfs.length){ const cur=bfs.shift(); (lat[cur]||[]).forEach(lid=>{ if(!clustered.has(lid)&&ids.includes(lid)){ cluster.push(lid); clustered.add(lid); bfs.push(lid); } }); } groups.push(cluster); });
    const totalW=groups.reduce((s,g)=>s+g.length*NW+(g.length-1)*8,0)+(groups.length-1)*HGAP;
    let x=-totalW/2; const y=+l*(NH+VGAP);
    groups.forEach(group=>{ group.forEach((id,i)=>{ pos[id]={x:x+i*(NW+8)+NW/2,y:y+NH/2}; }); x+=group.length*NW+(group.length-1)*8+HGAP; });
  });
  const xs=Object.values(pos).map(p=>p.x), ys=Object.values(pos).map(p=>p.y);
  const x0=(xs.length?Math.min(...xs):0)-NW/2-20, x1=(xs.length?Math.max(...xs):400)+NW/2+20;
  const y0=(ys.length?Math.min(...ys):0)-NH/2-20, y1=(ys.length?Math.max(...ys):300)+NH/2+20;
  return {pos, bbox:{x0,y0,w:x1-x0,h:y1-y0}};
}

// ─── SVG Node ─────────────────────────────────────────────────────────────────
function Node({person,p,sel,onClick}) {
  const col=person.gender==="male"?C.male:C.female;
  const isDead=!!person.died;
  return (
    <g transform={`translate(${p.x-NW/2},${p.y-NH/2})`} data-node="1"
       onClick={e=>{e.stopPropagation();onClick(person.id);}} style={{cursor:"pointer"}}>
      <defs><clipPath id={`cp-${person.id}`}><circle cx={NW/2} cy={34} r={22}/></clipPath></defs>
      <rect width={NW} height={NH} rx={12} fill={sel?"#2a1a55":C.card} stroke={sel?C.accent:col} strokeWidth={sel?2.5:1.5} opacity={isDead?0.75:1}/>
      <rect width={NW} height={3} rx={1} fill={col} opacity={0.85}/>
      {person.photo
        ?<image href={person.photo} x={NW/2-22} y={12} width={44} height={44} clipPath={`url(#cp-${person.id})`} preserveAspectRatio="xMidYMid slice"/>
        :<><circle cx={NW/2} cy={34} r={22} fill={col+"22"} stroke={col} strokeWidth={1.5}/><text x={NW/2} y={40} textAnchor="middle" fill={col} fontSize={16} fontFamily="serif">{person.gender==="male"?"♂":"♀"}</text></>
      }
      <circle cx={NW/2} cy={34} r={22} fill="none" stroke={col} strokeWidth={1.5} opacity={0.7}/>
      {isDead&&<text x={NW-12} y={16} fill={C.muted} fontSize={11} fontFamily="serif">✝</text>}
      <text x={NW/2} y={66} textAnchor="middle" fill={C.text} fontSize={10} fontWeight="600" fontFamily="Georgia,serif">{person.name.length>17?person.name.slice(0,16)+"…":person.name}</text>
      <text x={NW/2} y={80} textAnchor="middle" fill={C.muted} fontSize={9} fontFamily="monospace">{person.born||"?"}{person.died?" – "+person.died:""}</text>
    </g>
  );
}

// ─── Canvas ───────────────────────────────────────────────────────────────────
function Canvas({people,rels,selId,onSelect}) {
  const wrapRef=useRef(null), svgRef=useRef(null);
  const vpRef=useRef({x:0,y:0,s:1});
  const [vp,setVp]=useState({x:0,y:0,s:1});
  const [sz,setSz]=useState({w:360,h:480});
  const drag=useRef({on:false,lx:0,ly:0,pinch:false,ld:0});
  const {pos,bbox}=buildLayout(people,rels);

  const fit=useCallback((w,h)=>{
    if(!bbox.w||!bbox.h) return {x:w/2,y:50,s:1};
    const s=Math.min((w-30)/bbox.w,(h-30)/bbox.h,1.4);
    return {x:w/2-(bbox.x0+bbox.w/2)*s, y:h/2-(bbox.y0+bbox.h/2)*s, s};
  },[bbox.x0,bbox.y0,bbox.w,bbox.h]);

  useEffect(()=>{
    const el=wrapRef.current; if(!el) return;
    const w=el.offsetWidth,h=el.offsetHeight; setSz({w,h});
    const v=fit(w,h); vpRef.current=v; setVp(v);
  },[people.length,rels.length]);

  useEffect(()=>{
    const el=wrapRef.current; if(!el) return;
    const ro=new ResizeObserver(([e])=>{ const {width:w,height:h}=e.contentRect; setSz({w,h}); });
    ro.observe(el); return ()=>ro.disconnect();
  },[]);

  useEffect(()=>{
    const el=svgRef.current; if(!el) return;
    const ts=e=>{
      if(e.touches.length===1) drag.current={on:true,lx:e.touches[0].clientX,ly:e.touches[0].clientY,pinch:false,ld:0};
      else if(e.touches.length===2){ const dx=e.touches[0].clientX-e.touches[1].clientX,dy=e.touches[0].clientY-e.touches[1].clientY; drag.current={on:false,pinch:true,lx:0,ly:0,ld:Math.hypot(dx,dy)}; }
    };
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
    const def=RMAP[r.type]||{}, col=def.color||C.line;
    if(HORIZONTAL.has(r.type)){ const key=[r.p1,r.p2].sort().join("|")+r.type; if(drawn.has(key)) return null; drawn.add(key); const mx=(a.x+b.x)/2,my=(a.y+b.y)/2;
      return(<g key={`h-${key}`}><line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={col} strokeWidth={1.8} strokeDasharray={r.type==="spouse"?"5 3":"none"} opacity={0.8}/>{r.type==="spouse"&&<text x={mx} y={my-4} textAnchor="middle" fontSize={10} fill={col}>♥</text>}</g>); }
    if(VERTICAL.has(r.type)){ const dash=r.type==="grandparent"?"7 4":r.type==="uncle"?"3 3":"none"; const cy=(a.y+b.y)/2;
      return <path key={`v-${r.id}`} d={`M${a.x},${a.y+NH/2} C${a.x},${cy+15} ${b.x},${cy-15} ${b.x},${b.y-NH/2}`} fill="none" stroke={col} strokeWidth={1.8} strokeDasharray={dash} opacity={0.85}/>; }
    return null;
  });

  return (
    <div ref={wrapRef} style={{position:"relative",width:"100%",height:"100%",background:C.bg,borderRadius:14,overflow:"hidden"}}>
      <svg ref={svgRef} width={sz.w} height={sz.h} style={{display:"block",userSelect:"none"}}
        onMouseDown={md} onMouseMove={mm} onMouseUp={mu} onMouseLeave={mu} onWheel={wh}
        onClick={()=>onSelect(null)}>
        <g transform={`translate(${vp.x},${vp.y}) scale(${vp.s})`}>
          {lines}
          {people.map(p=>{ const pt=pos[p.id]; if(!pt) return null; return <Node key={p.id} person={p} p={pt} sel={selId===p.id} onClick={onSelect}/>; })}
        </g>
      </svg>
      <button onClick={doFit} style={{position:"absolute",top:10,right:10,background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,color:C.text,padding:"6px 11px",fontSize:12,cursor:"pointer"}}>⊡ Sığdır</button>
      <div style={{position:"absolute",bottom:10,left:10,background:C.surface+"dd",borderRadius:9,padding:"7px 10px",fontSize:9,color:C.muted,fontFamily:"monospace",lineHeight:2}}>
        {REL_DEFS.map(r=><div key={r.value}><span style={{color:r.color}}>{HORIZONTAL.has(r.value)?"╌╌ ":"── "}</span>{r.label.split(" ")[0]}</div>)}
      </div>
      <div style={{position:"absolute",bottom:10,right:10,fontSize:9,color:C.muted+"77",fontFamily:"monospace",textAlign:"right"}}>Sürükle · Pinch zoom</div>
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
  const inp={background:C.card,border:`1px solid ${C.border}`,borderRadius:8,color:C.text,padding:"10px 12px",fontSize:14,outline:"none",width:"100%",fontFamily:"Georgia,serif"};
  const lbl={fontSize:11,color:C.muted,display:"block",marginBottom:5,letterSpacing:"0.06em"};

  return (
    <div style={{position:"fixed",inset:0,background:"#00000099",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000,padding:16}}>
      <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:18,width:"100%",maxWidth:400,maxHeight:"90vh",overflow:"auto"}}>
        <div style={{padding:"14px 16px",borderBottom:`1px solid ${C.border}`,display:"flex",alignItems:"center",justifyContent:"space-between",position:"sticky",top:0,background:C.surface}}>
          <span style={{fontSize:13,fontWeight:700,color:C.accent,fontFamily:"'Cinzel',serif"}}>{isEdit?"KİŞİYİ DÜZENLE":"YENİ KİŞİ"}</span>
          <button onClick={onClose} style={{background:"transparent",border:"none",color:C.muted,fontSize:22,cursor:"pointer"}}>✕</button>
        </div>
        <div style={{padding:"16px",display:"flex",flexDirection:"column",gap:14}}>
          {/* Photo */}
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:8}}>
            <div onClick={()=>fileRef.current?.click()} style={{width:84,height:84,borderRadius:"50%",cursor:"pointer",position:"relative",border:`2px solid ${col}`,overflow:"hidden",background:form.photo?"transparent":col+"22",display:"flex",alignItems:"center",justifyContent:"center"}}>
              {form.photo?<img src={form.photo} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>:<span style={{fontSize:28,color:col}}>{form.gender==="male"?"♂":"♀"}</span>}
            </div>
            <input ref={fileRef} type="file" accept="image/*" style={{display:"none"}} onChange={handlePhoto}/>
            <div style={{display:"flex",gap:8}}>
              <button onClick={()=>fileRef.current?.click()} disabled={uploading} style={{background:C.accentDim,border:`1px solid ${C.accent}`,borderRadius:8,color:C.text,padding:"7px 12px",fontSize:12,cursor:"pointer"}}>
                {uploading?"Yükleniyor…":form.photo?"📷 Değiştir":"📷 Fotoğraf Ekle"}
              </button>
              {form.photo&&<button onClick={()=>set("photo",null)} style={{background:"transparent",border:`1px solid ${C.danger}55`,borderRadius:8,color:C.danger,padding:"7px 10px",fontSize:12,cursor:"pointer"}}>🗑</button>}
            </div>
          </div>
          {/* Name */}
          <div><label style={lbl}>AD SOYAD *</label><input style={inp} placeholder="Örn: Ahmet Yılmaz" value={form.name} onChange={e=>set("name",e.target.value)} onKeyDown={e=>e.key==="Enter"&&handleSave()}/></div>
          {/* Gender */}
          <div><label style={lbl}>CİNSİYET</label>
            <div style={{display:"flex",gap:8}}>
              {["male","female"].map(g=>(
                <button key={g} onClick={()=>set("gender",g)} style={{flex:1,padding:"10px",borderRadius:8,cursor:"pointer",fontSize:13,background:form.gender===g?(g==="male"?C.male:C.female)+"33":"transparent",border:`1.5px solid ${form.gender===g?(g==="male"?C.male:C.female):C.border}`,color:form.gender===g?(g==="male"?C.male:C.female):C.muted}}>
                  {g==="male"?"♂ Erkek":"♀ Kadın"}
                </button>
              ))}
            </div>
          </div>
          {/* Dates */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
            <div><label style={lbl}>DOĞUM YILI</label><input style={inp} placeholder="1980" value={form.born} onChange={e=>set("born",e.target.value)}/></div>
            <div><label style={lbl}>ÖLÜM YILI</label><input style={inp} placeholder="—" value={form.died} onChange={e=>set("died",e.target.value)}/></div>
          </div>
          {/* Buttons */}
          <div style={{display:"flex",gap:10}}>
            <button onClick={handleSave} disabled={!form.name.trim()} style={{flex:1,background:C.accentDim,border:`1px solid ${C.accent}`,borderRadius:8,color:C.text,padding:"11px",fontSize:14,cursor:"pointer",fontWeight:600,opacity:form.name.trim()?1:0.5}}>{isEdit?"💾 Güncelle":"✓ Ekle"}</button>
            <button onClick={onClose} style={{flex:1,background:"transparent",border:`1px solid ${C.border}`,borderRadius:8,color:C.text,padding:"11px",fontSize:14,cursor:"pointer"}}>İptal</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Confirm Dialog ───────────────────────────────────────────────────────────
function Confirm({message,onYes,onNo}) {
  return (
    <div style={{position:"fixed",inset:0,background:"#00000088",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1001,padding:20}}>
      <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:16,padding:24,maxWidth:320,width:"100%"}}>
        <div style={{fontSize:14,marginBottom:20,color:C.text,lineHeight:1.6}}>{message}</div>
        <div style={{display:"flex",gap:10}}>
          <button onClick={onYes} style={{flex:1,background:C.danger+"33",border:`1px solid ${C.danger}`,borderRadius:8,color:C.danger,padding:"10px",fontSize:13,cursor:"pointer"}}>Evet, Sil</button>
          <button onClick={onNo}  style={{flex:1,background:"transparent",border:`1px solid ${C.border}`,borderRadius:8,color:C.text,padding:"10px",fontSize:13,cursor:"pointer"}}>İptal</button>
        </div>
      </div>
    </div>
  );
}

// ─── Print helpers ────────────────────────────────────────────────────────────
function buildTreeSVGString(people, rels) {
  const {pos}=buildLayout(people,rels);
  const xs=Object.values(pos).map(p=>p.x), ys=Object.values(pos).map(p=>p.y);
  if(!xs.length) return null;
  const pad=30, minX=Math.min(...xs)-NW/2-pad, minY=Math.min(...ys)-NH/2-pad;
  const maxX=Math.max(...xs)+NW/2+pad, maxY=Math.max(...ys)+NH/2+pad;
  const W=maxX-minX, H=maxY-minY;
  const drawn=new Set(); let svgLines=[];
  rels.forEach(r=>{
    const a=pos[r.p1],b=pos[r.p2]; if(!a||!b) return;
    const def=RMAP[r.type]||{}, col=def.color||"#4c3880";
    if(HORIZONTAL.has(r.type)){ const key=[r.p1,r.p2].sort().join("|")+r.type; if(drawn.has(key)) return; drawn.add(key); const dash=r.type==="spouse"?'stroke-dasharray="5,3"':""; svgLines.push(`<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${col}" stroke-width="1.8" ${dash} opacity="0.85"/>`); if(r.type==="spouse") svgLines.push(`<text x="${(a.x+b.x)/2}" y="${(a.y+b.y)/2-4}" text-anchor="middle" font-size="10" fill="${col}">♥</text>`); }
    else if(VERTICAL.has(r.type)){ const cy=(a.y+b.y)/2; const dash=r.type==="grandparent"?'stroke-dasharray="7,4"':r.type==="uncle"?'stroke-dasharray="3,3"':""; svgLines.push(`<path d="M${a.x},${a.y+NH/2} C${a.x},${cy+15} ${b.x},${cy-15} ${b.x},${b.y-NH/2}" fill="none" stroke="${col}" stroke-width="1.8" ${dash} opacity="0.9"/>`); }
  });
  people.forEach(p=>{ const pt=pos[p.id]; if(!pt) return; const col=p.gender==="male"?"#60a5fa":"#f472b6"; const x=pt.x-NW/2,y=pt.y-NH/2; const isDead=!!p.died; const clipId=`cpr-${p.id}`; svgLines.push(`<defs><clipPath id="${clipId}"><circle cx="${pt.x}" cy="${y+34}" r="22"/></clipPath></defs>`); svgLines.push(`<rect x="${x}" y="${y}" width="${NW}" height="${NH}" rx="12" fill="${isDead?"#1a1a2e":"#221840"}" stroke="${col}" stroke-width="1.5" opacity="${isDead?0.75:1}"/>`); svgLines.push(`<rect x="${x}" y="${y}" width="${NW}" height="3" rx="1" fill="${col}" opacity="0.85"/>`); if(p.photo){ svgLines.push(`<image href="${p.photo}" x="${pt.x-22}" y="${y+12}" width="44" height="44" clip-path="url(#${clipId})" preserveAspectRatio="xMidYMid slice"/>`); } else { svgLines.push(`<circle cx="${pt.x}" cy="${y+34}" r="22" fill="${col}22" stroke="${col}" stroke-width="1.5"/>`); svgLines.push(`<text x="${pt.x}" y="${y+40}" text-anchor="middle" fill="${col}" font-size="16" font-family="serif">${p.gender==="male"?"♂":"♀"}</text>`); } svgLines.push(`<circle cx="${pt.x}" cy="${y+34}" r="22" fill="none" stroke="${col}" stroke-width="1.5" opacity="0.7"/>`); if(isDead) svgLines.push(`<text x="${x+NW-12}" y="${y+16}" fill="#888" font-size="11">✝</text>`); const nm=p.name.length>17?p.name.slice(0,16)+"…":p.name; svgLines.push(`<text x="${pt.x}" y="${y+66}" text-anchor="middle" fill="#e9d5ff" font-size="10" font-weight="600" font-family="Georgia,serif">${nm}</text>`); svgLines.push(`<text x="${pt.x}" y="${y+80}" text-anchor="middle" fill="#9d7ec9" font-size="9" font-family="monospace">${p.born||"?"}${p.died?" – "+p.died:""}</text>`); });
  return {svgString:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${W} ${H}" width="${W}" height="${H}">${svgLines.join("")}</svg>`,W,H};
}

async function svgToDataUrl(svgString) {
  return new Promise((res,rej)=>{ const blob=new Blob([svgString],{type:"image/svg+xml"}); const url=URL.createObjectURL(blob); const img=new Image(); img.onload=()=>{ const scale=Math.min(2400/img.naturalWidth,1600/img.naturalHeight,2); const canvas=document.createElement("canvas"); canvas.width=img.naturalWidth*scale; canvas.height=img.naturalHeight*scale; const ctx=canvas.getContext("2d"); ctx.fillStyle="#0f0a1e"; ctx.fillRect(0,0,canvas.width,canvas.height); ctx.scale(scale,scale); ctx.drawImage(img,0,0); URL.revokeObjectURL(url); res(canvas.toDataURL("image/png")); }; img.onerror=rej; img.src=url; });
}

// ─── Print Modal ──────────────────────────────────────────────────────────────
function PrintModal({tree,onClose}) {
  const [generating,setGenerating]=useState(false);
  const [treeImg,setTreeImg]=useState(null);
  const people=tree.people||[], rels=tree.rels||[];
  const pname=id=>(people.find(p=>p.id===id)||{}).name||"?";
  const today=new Date().toLocaleDateString("tr-TR",{day:"2-digit",month:"long",year:"numeric"});

  useEffect(()=>{ (async()=>{ setGenerating(true); try { const r=buildTreeSVGString(people,rels); if(r){ const u=await svgToDataUrl(r.svgString); setTreeImg(u); } } catch(e){console.error(e);} setGenerating(false); })(); },[]);

  return (
    <>
      <style>{`
        @media print {
          body > *:not(#print-root) { display: none !important; }
          #print-root { display: block !important; }
          .print-page { page-break-after: always; break-after: page; padding: 14mm; background: white !important; color: #111 !important; font-family: Georgia, serif; }
          .print-page:last-child { page-break-after: avoid; break-after: avoid; }
          @page { margin: 8mm; size: A4; }
        }
        #print-root { display: none; }
      `}</style>
      {/* Hidden print pages */}
      <div id="print-root">
        <div className="print-page">
          <div style={{textAlign:"center",marginBottom:10}}><div style={{fontSize:20,fontWeight:700}}>{tree.name}</div><div style={{fontSize:10,color:"#666",marginTop:3}}>Soy Ağacı Diyagramı · {today}</div></div>
          <hr style={{border:"none",borderTop:"1px solid #ccc",marginBottom:12}}/>
          {treeImg?<img src={treeImg} alt="" style={{width:"100%",height:"auto",maxHeight:"230mm",objectFit:"contain"}}/>:<div style={{textAlign:"center",color:"#999",padding:"30px 0"}}>Hazırlanıyor…</div>}
          <div style={{marginTop:8,fontSize:9,color:"#aaa",textAlign:"right"}}>{people.length} kişi · {rels.length} ilişki</div>
        </div>
        <div className="print-page">
          <div style={{textAlign:"center",marginBottom:10}}><div style={{fontSize:20,fontWeight:700}}>{tree.name}</div><div style={{fontSize:10,color:"#666",marginTop:3}}>Aile Üyeleri · {today}</div></div>
          <hr style={{border:"none",borderTop:"1px solid #ccc",marginBottom:12}}/>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
            <thead><tr style={{borderBottom:"2px solid #333"}}><th style={{textAlign:"left",padding:"5px 6px"}}>#</th><th style={{textAlign:"left",padding:"5px 6px"}}>Ad Soyad</th><th style={{textAlign:"left",padding:"5px 6px"}}>Cinsiyet</th><th style={{textAlign:"left",padding:"5px 6px"}}>Doğum</th><th style={{textAlign:"left",padding:"5px 6px"}}>Ölüm</th></tr></thead>
            <tbody>{people.map((p,i)=>(<tr key={p.id} style={{borderBottom:"1px solid #eee",background:i%2===0?"#f9f9f9":"white"}}><td style={{padding:"5px 6px",color:"#888"}}>{i+1}</td><td style={{padding:"5px 6px",fontWeight:600}}>{p.photo&&<img src={p.photo} alt="" style={{width:18,height:18,borderRadius:"50%",objectFit:"cover",verticalAlign:"middle",marginRight:5}}/>}{p.name}</td><td style={{padding:"5px 6px"}}>{p.gender==="male"?"Erkek":"Kadın"}</td><td style={{padding:"5px 6px"}}>{p.born||"—"}</td><td style={{padding:"5px 6px"}}>{p.died||"—"}</td></tr>))}</tbody>
          </table>
        </div>
        <div className="print-page">
          <div style={{textAlign:"center",marginBottom:10}}><div style={{fontSize:20,fontWeight:700}}>{tree.name}</div><div style={{fontSize:10,color:"#666",marginTop:3}}>İlişkiler · {today}</div></div>
          <hr style={{border:"none",borderTop:"1px solid #ccc",marginBottom:12}}/>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
            <thead><tr style={{borderBottom:"2px solid #333"}}><th style={{textAlign:"left",padding:"5px 6px"}}>#</th><th style={{textAlign:"left",padding:"5px 6px"}}>Kişi 1</th><th style={{textAlign:"left",padding:"5px 6px"}}>İlişki</th><th style={{textAlign:"left",padding:"5px 6px"}}>Kişi 2</th></tr></thead>
            <tbody>{rels.map((r,i)=>{ const def=RMAP[r.type]||{}; return(<tr key={r.id} style={{borderBottom:"1px solid #eee",background:i%2===0?"#f9f9f9":"white"}}><td style={{padding:"5px 6px",color:"#888"}}>{i+1}</td><td style={{padding:"5px 6px",fontWeight:600}}>{pname(r.p1)}</td><td style={{padding:"5px 6px"}}><span style={{background:"#f0f0f0",borderRadius:4,padding:"2px 6px",fontSize:10}}>{def.icon} {def.label||r.type}</span></td><td style={{padding:"5px 6px",fontWeight:600}}>{pname(r.p2)}</td></tr>); })}</tbody>
          </table>
        </div>
      </div>
      {/* Bottom-sheet modal */}
      <div style={{position:"fixed",inset:0,background:"#00000099",display:"flex",alignItems:"flex-end",justifyContent:"center",zIndex:1002}}>
        <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:"18px 18px 0 0",width:"100%",maxWidth:520,maxHeight:"80vh",overflow:"auto",paddingBottom:"env(safe-area-inset-bottom)"}}>
          <div style={{display:"flex",justifyContent:"center",padding:"10px 0 0"}}><div style={{width:36,height:4,borderRadius:2,background:C.border}}/></div>
          <div style={{padding:"10px 16px 6px",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
            <span style={{fontSize:14,fontWeight:700,color:C.accent,fontFamily:"'Cinzel',serif"}}>🖨️ YAZDIR / PDF KAYDET</span>
            <button onClick={onClose} style={{background:"transparent",border:"none",color:C.muted,fontSize:22,cursor:"pointer",padding:"2px 6px"}}>✕</button>
          </div>
          <div style={{padding:"0 14px 16px",display:"flex",flexDirection:"column",gap:10}}>
            <div style={{background:C.card,borderRadius:12,padding:12}}>
              <div style={{fontSize:13,fontWeight:700,color:C.text,marginBottom:8,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",fontFamily:"'Cinzel',serif"}}>{tree.name}</div>
              {[{icon:"🌳",l:"Sayfa 1",d:"Soy Ağacı Diyagramı"},{icon:"👥",l:"Sayfa 2",d:`Üyeler — ${people.length} kişi`},{icon:"🔗",l:"Sayfa 3",d:`İlişkiler — ${rels.length}`}].map(r=>(
                <div key={r.l} style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}><span style={{fontSize:14,width:22,textAlign:"center"}}>{r.icon}</span><span style={{color:C.accent,fontSize:12,fontWeight:600,minWidth:54}}>{r.l}</span><span style={{color:C.muted,fontSize:12}}>{r.d}</span></div>
              ))}
            </div>
            {generating?<div style={{textAlign:"center",color:C.muted,fontSize:13}}>🔄 Diyagram hazırlanıyor…</div>:<div style={{textAlign:"center",color:C.success,fontSize:13}}>✓ Hazır</div>}
            <div style={{background:"#7c3aed18",border:"1px solid #7c3aed44",borderRadius:10,padding:"10px 12px",fontSize:12,color:C.muted,lineHeight:1.6}}>💡 Print penceresinde <strong style={{color:C.text}}>"PDF Olarak Kaydet"</strong> seçin.</div>
            <button onClick={()=>window.print()} disabled={generating} style={{background:generating?C.accentDim+"55":C.accentDim,border:`1px solid ${C.accent}`,borderRadius:12,color:C.text,padding:"14px",fontSize:15,cursor:generating?"not-allowed":"pointer",fontWeight:700,width:"100%"}}>
              {generating?"🔄 Hazırlanıyor…":"🖨️ Yazdır / PDF Kaydet"}
            </button>
          </div>
        </div>
      </div>
    </>
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
  const [addR,setAddR]=useState(false);
  const [newR,setNewR]=useState({type:"spouse",p1:"",p2:""});
  const [confirmPerson,setConfirmPerson]=useState(null);
  const [confirmRel,setConfirmRel]=useState(null);
  const [showPrint,setShowPrint]=useState(false);

  const selPerson=people.find(p=>p.id===selId);
  const relDef=RMAP[newR.type]||{};

  const openAddPerson=()=>setPersonModal("new");
  const openEditPerson=person=>setPersonModal(person);
  const handleSavePerson=formData=>{ if(personModal==="new") setPeople(prev=>[...prev,{...formData,id:String(Date.now())}]); else setPeople(prev=>prev.map(p=>p.id===personModal.id?{...p,...formData}:p)); setPersonModal(null); };
  const delPerson=id=>{ setPeople(prev=>prev.filter(p=>p.id!==id)); setRels(prev=>prev.filter(r=>r.p1!==id&&r.p2!==id)); if(selId===id) setSelId(null); setConfirmPerson(null); };
  const saveRel=()=>{ const{type,p1,p2}=newR; if(!p1||!p2||p1===p2) return; const dup=rels.some(r=>r.type===type&&((r.p1===p1&&r.p2===p2)||(r.p1===p2&&r.p2===p1))); if(!dup) setRels(prev=>[...prev,{type,p1,p2,id:"r"+Date.now()}]); setNewR({type:"spouse",p1:"",p2:""}); setAddR(false); };
  const delRel=id=>{ setRels(prev=>prev.filter(r=>r.id!==id)); setConfirmRel(null); };
  const pname=id=>(people.find(p=>p.id===id)||{}).name||"?";
  const handleSave=async()=>{ if(!treeName.trim()) return; setSaving(true); await onSave({...tree,name:treeName.trim(),people,rels,updatedAt:Date.now()}); setSaving(false); setSaved(true); setTimeout(()=>setSaved(false),2000); };

  const S={
    inp:{background:C.card,border:`1px solid ${C.border}`,borderRadius:8,color:C.text,padding:"10px 12px",fontSize:14,outline:"none",width:"100%",fontFamily:"Georgia,serif"},
    btn:(primary)=>({background:primary?C.accentDim:"transparent",border:`1px solid ${primary?C.accent:C.border}`,borderRadius:8,color:C.text,padding:"10px 16px",fontSize:13,cursor:"pointer"}),
  };

  return (
    <div style={{display:"flex",flexDirection:"column",height:"100vh",background:C.bg,color:C.text,overflow:"hidden"}}>
      {/* Header */}
      <div style={{background:C.surface,borderBottom:`1px solid ${C.border}`,padding:"10px 12px",display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
        <button onClick={onBack} style={{background:"transparent",border:`1px solid ${C.border}`,borderRadius:8,color:C.muted,padding:"6px 10px",fontSize:13,cursor:"pointer",flexShrink:0}}>← Geri</button>
        <input value={treeName} onChange={e=>setTreeName(e.target.value)} placeholder="Ağaç adı…"
          style={{flex:1,background:"transparent",border:"none",borderBottom:`1px solid ${C.border}`,color:C.text,fontSize:14,fontWeight:700,padding:"4px 2px",outline:"none",fontFamily:"'Cinzel',serif",minWidth:0}}/>
        <button onClick={()=>setShowPrint(true)} style={{background:"transparent",border:`1px solid ${C.border}`,borderRadius:8,color:C.muted,padding:"7px 10px",fontSize:13,cursor:"pointer",flexShrink:0}}>🖨️</button>
        <button onClick={handleSave} disabled={saving||!treeName.trim()} style={{background:saved?C.success+"33":C.accentDim,border:`1px solid ${saved?C.success:C.accent}`,borderRadius:8,color:saved?C.success:C.text,padding:"7px 11px",fontSize:12,cursor:"pointer",flexShrink:0,opacity:(!treeName.trim()||saving)?0.5:1}}>
          {saving?"…":saved?"✓":"💾"}
        </button>
      </div>
      {/* Tabs */}
      <div style={{display:"flex",background:C.surface,borderBottom:`1px solid ${C.border}`,flexShrink:0}}>
        {["ağaç","kişiler","ilişkiler"].map(t=>(
          <button key={t} onClick={()=>setTab(t)} style={{flex:1,background:tab===t?C.accentDim+"44":"transparent",border:"none",borderBottom:`2px solid ${tab===t?C.accent:"transparent"}`,color:tab===t?C.accent:C.muted,padding:"10px 4px",fontSize:12,cursor:"pointer"}}>
            {t==="ağaç"?"🌳 Ağaç":t==="kişiler"?"👥 Kişiler":"🔗 İlişkiler"}
          </button>
        ))}
      </div>

      <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",minHeight:0}}>

        {/* Ağaç */}
        {tab==="ağaç"&&(
          <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",minHeight:0}}>
            <div style={{padding:"8px 10px 4px",display:"flex",gap:8,flexShrink:0}}>
              <button onClick={openAddPerson} style={{...S.btn(true),flex:1,padding:"8px",fontSize:12}}>+ Kişi</button>
              <button onClick={()=>{setTab("ilişkiler");setAddR(true);}} style={{...S.btn(false),flex:1,padding:"8px",fontSize:12}}>+ İlişki</button>
            </div>
            <div style={{flex:1,margin:"0 10px",minHeight:0}}>
              <Canvas people={people} rels={rels} selId={selId} onSelect={id=>setSelId(id===selId?null:id)}/>
            </div>
            {selPerson&&(
              <div style={{margin:"6px 10px",background:C.surface,border:`1px solid ${C.border}`,borderRadius:12,padding:"10px 12px",display:"flex",alignItems:"center",gap:10,flexShrink:0}}>
                <div style={{width:40,height:40,borderRadius:"50%",flexShrink:0,overflow:"hidden",border:`2px solid ${selPerson.gender==="male"?C.male:C.female}`,background:(selPerson.gender==="male"?C.male:C.female)+"22",display:"flex",alignItems:"center",justifyContent:"center",fontSize:17}}>
                  {selPerson.photo?<img src={selPerson.photo} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>:(selPerson.gender==="male"?"♂":"♀")}
                </div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontWeight:700,fontSize:13,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{selPerson.name}</div>
                  <div style={{fontSize:11,color:C.muted}}>{selPerson.born&&`Doğum: ${selPerson.born}`}{selPerson.died&&` · Ölüm: ${selPerson.died} ✝`}</div>
                </div>
                <button onClick={()=>openEditPerson(selPerson)} style={{background:C.accentDim+"44",border:`1px solid ${C.accent}55`,borderRadius:7,color:C.accent,padding:"5px 9px",fontSize:12,cursor:"pointer"}}>✏️</button>
                <button onClick={()=>setSelId(null)} style={{background:"transparent",border:"none",color:C.muted,fontSize:18,cursor:"pointer"}}>✕</button>
              </div>
            )}
            <div style={{height:6,flexShrink:0}}/>
          </div>
        )}

        {/* Kişiler */}
        {tab==="kişiler"&&(
          <div style={{flex:1,overflow:"auto",padding:12}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
              <span style={{fontSize:12,color:C.muted}}>KİŞİLER ({people.length})</span>
              <button onClick={openAddPerson} style={S.btn(true)}>+ Yeni Kişi</button>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              {people.map(p=>(
                <div key={p.id} style={{background:C.card,border:`1px solid ${selId===p.id?C.accent:C.border}`,borderRadius:10,padding:"10px 12px",display:"flex",alignItems:"center",gap:10,cursor:"pointer"}} onClick={()=>setSelId(p.id===selId?null:p.id)}>
                  <div style={{width:36,height:36,borderRadius:"50%",flexShrink:0,overflow:"hidden",border:`1.5px solid ${p.gender==="male"?C.male:C.female}`,background:(p.gender==="male"?C.male:C.female)+"22",display:"flex",alignItems:"center",justifyContent:"center",fontSize:15}}>
                    {p.photo?<img src={p.photo} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>:(p.gender==="male"?"♂":"♀")}
                  </div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:13,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.name}{p.died&&<span style={{color:C.muted,marginLeft:5,fontSize:11}}>✝</span>}</div>
                    <div style={{fontSize:11,color:C.muted}}>{p.born||"?"}{p.died?` – ${p.died}`:""}</div>
                  </div>
                  <div style={{display:"flex",gap:5}} onClick={e=>e.stopPropagation()}>
                    <button onClick={()=>openEditPerson(p)} style={{background:C.accentDim+"44",border:`1px solid ${C.accent}55`,borderRadius:7,color:C.accent,padding:"5px 8px",fontSize:12,cursor:"pointer"}}>✏️</button>
                    <button onClick={()=>setConfirmPerson(p.id)} style={{background:"transparent",border:"none",color:C.danger,cursor:"pointer",fontSize:15,padding:"4px"}}>🗑</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* İlişkiler */}
        {tab==="ilişkiler"&&(
          <div style={{flex:1,overflow:"auto",padding:12}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
              <span style={{fontSize:12,color:C.muted}}>İLİŞKİLER ({rels.length})</span>
              <button onClick={()=>setAddR(!addR)} style={S.btn(true)}>{addR?"✕ Kapat":"+ Yeni İlişki"}</button>
            </div>
            {addR&&(
              <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:12,padding:12,marginBottom:12}}>
                <div style={{fontSize:11,color:C.accent,marginBottom:10,letterSpacing:"0.1em"}}>YENİ İLİŞKİ</div>
                <div style={{display:"flex",flexDirection:"column",gap:10}}>
                  <div><div style={{fontSize:11,color:C.muted,marginBottom:4}}>İLİŞKİ TÜRÜ</div><select style={S.inp} value={newR.type} onChange={e=>setNewR(r=>({...r,type:e.target.value,p1:"",p2:""}))}>
                    {REL_DEFS.map(rd=><option key={rd.value} value={rd.value}>{rd.icon} {rd.label}</option>)}</select></div>
                  {relDef.bi&&<div style={{background:"#7c3aed22",border:"1px solid #7c3aed55",borderRadius:8,padding:"8px 10px",fontSize:11,color:C.muted}}>ℹ️ Çift yönlü — tek kez tanımlamanız yeterlidir.</div>}
                  <div><div style={{fontSize:11,color:C.muted,marginBottom:4}}>{relDef.bi?"KİŞİ 1":"ÜSTTEKI"}</div><select style={S.inp} value={newR.p1} onChange={e=>setNewR(r=>({...r,p1:e.target.value}))}><option value="">Seçin…</option>{people.map(p=><option key={p.id} value={p.id}>{p.gender==="male"?"♂":"♀"} {p.name}</option>)}</select></div>
                  <div><div style={{fontSize:11,color:C.muted,marginBottom:4}}>{relDef.bi?"KİŞİ 2":"ALTTAKİ"}</div><select style={S.inp} value={newR.p2} onChange={e=>setNewR(r=>({...r,p2:e.target.value}))}><option value="">Seçin…</option>{people.filter(p=>p.id!==newR.p1).map(p=><option key={p.id} value={p.id}>{p.gender==="male"?"♂":"♀"} {p.name}</option>)}</select></div>
                  <div style={{display:"flex",gap:8}}><button onClick={saveRel} style={{...S.btn(true),flex:1}}>Kaydet</button><button onClick={()=>setAddR(false)} style={{...S.btn(false),flex:1}}>İptal</button></div>
                </div>
              </div>
            )}
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              {rels.map(r=>{ const d=RMAP[r.type]||{}; return(
                <div key={r.id} style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:"10px 12px",display:"flex",alignItems:"center",gap:8}}>
                  <span style={{fontSize:15,flexShrink:0}}>{d.icon||"🔗"}</span>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:12,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{pname(r.p1)} <span style={{color:d.color||C.accent,fontSize:10}}>{d.bi?"↔":"→"}</span> {pname(r.p2)}</div>
                    <div style={{fontSize:10,color:d.color||C.muted,marginTop:2}}>{d.label||r.type}</div>
                  </div>
                  <button onClick={()=>setConfirmRel(r.id)} style={{background:"transparent",border:"none",color:C.danger,cursor:"pointer",fontSize:15,padding:4}}>🗑</button>
                </div>
              ); })}
            </div>
          </div>
        )}
      </div>

      {personModal&&<PersonModal person={personModal==="new"?null:personModal} onSave={handleSavePerson} onClose={()=>setPersonModal(null)}/>}
      {confirmPerson&&<Confirm message={`"${people.find(p=>p.id===confirmPerson)?.name}" silinsin mi?`} onYes={()=>delPerson(confirmPerson)} onNo={()=>setConfirmPerson(null)}/>}
      {confirmRel&&<Confirm message="Bu ilişkiyi silmek istediğinizden emin misiniz?" onYes={()=>delRel(confirmRel)} onNo={()=>setConfirmRel(null)}/>}
      {showPrint&&<PrintModal tree={{name:treeName,people,rels}} onClose={()=>setShowPrint(false)}/>}
    </div>
  );
}

// ─── Home Screen ──────────────────────────────────────────────────────────────
function Home({trees,loading,onOpen,onCreate,onDelete,onImport,onExport}) {
  const [confirmId,setConfirmId]=useState(null);
  const [newName,setNewName]=useState("");
  const [view,setView]=useState("list");
  const [importErr,setImportErr]=useState("");
  const [importing,setImporting]=useState(false);
  const importRef=useRef(null);

  const fmt=ts=>ts?new Date(ts).toLocaleDateString("tr-TR",{day:"2-digit",month:"short",year:"numeric"}):"";

  const handleCreate=()=>{ if(!newName.trim()) return; onCreate(newName.trim()); setNewName(""); setView("list"); };

  const handleImportFile=async e=>{ const file=e.target.files?.[0]; if(!file) return; setImporting(true); setImportErr(""); try { const data=await importTreeFile(file); await onImport(data); } catch(err){ setImportErr(err.message); } setImporting(false); e.target.value=""; };

  return (
    <div style={{display:"flex",flexDirection:"column",height:"100vh",background:C.bg,color:C.text,fontFamily:"Georgia,serif"}}>
      {/* Header */}
      <div style={{background:C.surface,borderBottom:`1px solid ${C.border}`,padding:"12px 16px",display:"flex",alignItems:"center",gap:10,flexShrink:0}}>
        <span style={{fontSize:22}}>🌳</span>
        <div>
          <div style={{fontSize:17,fontWeight:700,color:C.accent,fontFamily:"'Cinzel',serif",letterSpacing:"0.06em"}}>SOY AĞACI</div>
          <div style={{fontSize:9,color:C.muted,letterSpacing:"0.12em"}}>AİLE BAĞLARI HARİTASI</div>
        </div>
        <div style={{marginLeft:"auto",fontSize:11,color:C.muted}}>{trees.length} proje</div>
      </div>

      {/* Action bar */}
      <div style={{background:C.surface,borderBottom:`1px solid ${C.border}`,padding:"10px 14px",display:"flex",gap:8,flexShrink:0}}>
        <button onClick={()=>setView(view==="new"?"list":"new")} style={{flex:1,background:view==="new"?C.accentDim:C.accentDim+"55",border:`1px solid ${C.accent}`,borderRadius:10,color:C.text,padding:"10px 8px",fontSize:13,cursor:"pointer",fontWeight:600}}>
          {view==="new"?"✕ İptal":"＋ Yeni Proje"}
        </button>
        <button onClick={()=>importRef.current?.click()} disabled={importing} style={{flex:1,background:"transparent",border:`1px solid ${C.border}`,borderRadius:10,color:C.muted,padding:"10px 8px",fontSize:13,cursor:"pointer"}}>
          {importing?"⏳ Yükleniyor…":"📥 İçe Aktar"}
        </button>
        <input ref={importRef} type="file" accept=".json,.ftree.json" style={{display:"none"}} onChange={handleImportFile}/>
      </div>

      <div style={{flex:1,overflow:"auto",padding:14}}>
        {/* New project form */}
        {view==="new"&&(
          <div style={{background:C.surface,border:`1px solid ${C.accent}55`,borderRadius:14,padding:16,marginBottom:16}}>
            <div style={{fontSize:12,color:C.accent,marginBottom:10,letterSpacing:"0.1em",fontFamily:"'Cinzel',serif"}}>YENİ SOY AĞACI</div>
            <input autoFocus placeholder="Proje adı (örn: Yılmaz Ailesi)" value={newName}
              onChange={e=>setNewName(e.target.value)} onKeyDown={e=>e.key==="Enter"&&handleCreate()}
              style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:8,color:C.text,padding:"11px 14px",fontSize:14,outline:"none",width:"100%",marginBottom:10,fontFamily:"Georgia,serif"}}/>
            <div style={{display:"flex",gap:10}}>
              <button onClick={handleCreate} disabled={!newName.trim()} style={{flex:1,background:C.accentDim,border:`1px solid ${C.accent}`,borderRadius:8,color:C.text,padding:"11px",fontSize:14,cursor:"pointer",fontWeight:600,opacity:newName.trim()?1:0.5}}>Oluştur</button>
              <button onClick={()=>{setView("list");setNewName("");}} style={{flex:1,background:"transparent",border:`1px solid ${C.border}`,borderRadius:8,color:C.text,padding:"11px",fontSize:14,cursor:"pointer"}}>İptal</button>
            </div>
          </div>
        )}

        {importErr&&(
          <div style={{background:C.danger+"22",border:`1px solid ${C.danger}55`,borderRadius:10,padding:"10px 14px",marginBottom:12,fontSize:13,color:C.danger,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <span>⚠️ {importErr}</span>
            <button onClick={()=>setImportErr("")} style={{background:"transparent",border:"none",color:C.danger,cursor:"pointer",fontSize:16}}>✕</button>
          </div>
        )}

        {loading&&<div style={{textAlign:"center",color:C.muted,padding:40,fontSize:14}}>Yükleniyor…</div>}

        {!loading&&trees.length===0&&view!=="new"&&(
          <div style={{textAlign:"center",padding:"50px 20px",color:C.muted}}>
            <div style={{fontSize:44,marginBottom:14}}>🌱</div>
            <div style={{fontSize:16,color:C.text,marginBottom:8,fontFamily:"'Cinzel',serif"}}>Henüz proje yok</div>
            <div style={{fontSize:13,lineHeight:1.6}}>Yukarıdan yeni proje oluşturun<br/>veya dışa aktarılmış bir dosyayı içe aktarın.</div>
          </div>
        )}

        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          {trees.map(tree=>{
            const avatars=[...(tree.people||[]).filter(p=>p.photo),...(tree.people||[]).filter(p=>!p.photo)].slice(0,3);
            return (
              <div key={tree.id} style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:14,overflow:"hidden"}}>
                <div style={{padding:"14px 14px",display:"flex",alignItems:"center",gap:12,cursor:"pointer"}} onClick={()=>onOpen(tree.id)}>
                  <div style={{position:"relative",width:avatars.length>1?46:34,height:34,flexShrink:0}}>
                    {avatars.length===0
                      ?<div style={{width:34,height:34,borderRadius:10,background:C.accentDim+"33",border:`1px solid ${C.accent}44`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>🌳</div>
                      :avatars.map((p,i)=>(
                        <div key={p.id} style={{position:"absolute",left:i*11,top:i===1?5:0,width:30,height:30,borderRadius:"50%",overflow:"hidden",border:`2px solid ${C.surface}`,background:(p.gender==="male"?C.male:C.female)+"33",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,zIndex:3-i}}>
                          {p.photo?<img src={p.photo} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>:(p.gender==="male"?"♂":"♀")}
                        </div>
                      ))
                    }
                  </div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:14,fontWeight:700,color:C.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",fontFamily:"'Cinzel',serif"}}>{tree.name}</div>
                    <div style={{fontSize:11,color:C.muted,marginTop:2}}>{tree.people?.length||0} kişi · {tree.rels?.length||0} ilişki{tree.updatedAt&&` · ${fmt(tree.updatedAt)}`}</div>
                  </div>
                  <span style={{color:C.muted,fontSize:18,flexShrink:0}}>›</span>
                </div>
                <div style={{borderTop:`1px solid ${C.border}`,display:"flex"}}>
                  <button onClick={()=>onOpen(tree.id)}  style={{flex:1,background:"transparent",border:"none",borderRight:`1px solid ${C.border}`,color:C.accent,padding:"9px 0",fontSize:12,cursor:"pointer"}}>✏️ Düzenle</button>
                  <button onClick={()=>onExport(tree)}   style={{flex:1,background:"transparent",border:"none",borderRight:`1px solid ${C.border}`,color:C.muted,padding:"9px 0",fontSize:12,cursor:"pointer"}}>📤 Dışa Aktar</button>
                  <button onClick={()=>setConfirmId(tree.id)} style={{flex:1,background:"transparent",border:"none",color:C.danger,padding:"9px 0",fontSize:12,cursor:"pointer"}}>🗑 Sil</button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {confirmId&&<Confirm message={`"${trees.find(t=>t.id===confirmId)?.name}" silinsin mi?`} onYes={()=>{onDelete(confirmId);setConfirmId(null);}} onNo={()=>setConfirmId(null)}/>}
    </div>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────
export default function App() {
  const [trees,setTrees]=useState([]);
  const [openId,setOpenId]=useState(null);
  const [loading,setLoading]=useState(true);

  useEffect(()=>{
    (async()=>{ setLoading(true); try { const keys=await storageList("tree:"); const loaded=await Promise.all(keys.map(k=>storageGet(k))); setTrees(loaded.filter(Boolean).sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0))); } catch(e){console.error(e);} setLoading(false); })();
  },[]);

  const createTree=name=>{ const id="tree:"+Date.now(),now=Date.now(); const t={id,name,people:[],rels:[],createdAt:now,updatedAt:now}; setTrees(prev=>[t,...prev]); setOpenId(id); };
  const saveTree=async tree=>{ await storageSet(tree.id,tree); setTrees(prev=>{ const idx=prev.findIndex(t=>t.id===tree.id); const next=idx===-1?[tree,...prev]:prev.map(t=>t.id===tree.id?tree:t); return next.sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0)); }); };
  const deleteTree=async id=>{ await storageDel(id); setTrees(prev=>prev.filter(t=>t.id!==id)); if(openId===id) setOpenId(null); };
  const importTree=async data=>{ const id="tree:"+Date.now(),now=Date.now(); const tree={...data,id,updatedAt:now,importedAt:now}; await storageSet(id,tree); setTrees(prev=>[tree,...prev]); };

  const currentTree=trees.find(t=>t.id===openId);

  const STYLE=`@import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700&display=swap');*{box-sizing:border-box}input::placeholder{color:#5a3f80}select option{background:#1a1130}::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:#0f0a1e}::-webkit-scrollbar-thumb{background:#3d2d6e;border-radius:3px}`;

  if(openId&&currentTree) return <div><style>{STYLE}</style><TreeEditor tree={currentTree} onSave={saveTree} onBack={()=>setOpenId(null)}/></div>;

  return <div><style>{STYLE}</style><Home trees={trees} loading={loading} onOpen={setOpenId} onCreate={createTree} onDelete={deleteTree} onImport={importTree} onExport={exportTree}/></div>;
}
