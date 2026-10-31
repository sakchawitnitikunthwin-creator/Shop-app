/* Local-only replacement for the Claude runtime: data + photos live in this device's IndexedDB */
(function(){
  const DB_NAME="shop-app", VER=1;
  let dbp=null;
  function open(){ if(dbp) return dbp; dbp=new Promise((res,rej)=>{const r=indexedDB.open(DB_NAME,VER);
    r.onupgradeneeded=()=>{const d=r.result; if(!d.objectStoreNames.contains("docs")) d.createObjectStore("docs"); if(!d.objectStoreNames.contains("blobs")) d.createObjectStore("blobs");};
    r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error);}); return dbp; }
  function tx(store,mode,fn){return open().then(d=>new Promise((res,rej)=>{const t=d.transaction(store,mode);const s=t.objectStore(store);let out;Promise.resolve(fn(s)).then(v=>out=v);t.oncomplete=()=>res(out);t.onerror=()=>rej(t.error);t.onabort=()=>rej(t.error);}));}
  const req=r=>new Promise((res,rej)=>{r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});
  async function all(store){return tx(store,"readonly",async s=>{const keys=await req(s.getAllKeys());const vals=await req(s.getAll());return keys.map((k,i)=>[k,vals[i]]);});}
  const rid=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,8);
  const listeners={};
  async function emit(col){
    const rows=(await all("docs")).filter(([k])=>k.startsWith(col+"/")).map(([k,v])=>({id:k.slice(col.length+1),exists:true,data:()=>v,metadata:{fromCache:false,hasPendingWrites:false}}));
    const snap={docs:rows,size:rows.length,empty:!rows.length,metadata:{fromCache:false,hasPendingWrites:false},docChanges:()=>[]};
    (listeners[col]||[]).forEach(fn=>{try{fn(snap)}catch(e){console.error(e)}});
  }
  function docRef(col,id){const key=col+"/"+id;return{id,path:key,
    get:async()=>{const v=await tx("docs","readonly",s=>req(s.get(key)));return{id,exists:!!v,data:()=>v,metadata:{fromCache:false,hasPendingWrites:false}}},
    set:async d=>{await tx("docs","readwrite",s=>req(s.put(JSON.parse(JSON.stringify(d)),key)));emit(col)},
    update:async d=>{await tx("docs","readwrite",async s=>{const cur=await req(s.get(key));if(!cur)throw{code:"invalid_argument",message:"missing"};await req(s.put(Object.assign({},cur,JSON.parse(JSON.stringify(d))),key));});emit(col)},
    delete:async()=>{await tx("docs","readwrite",s=>req(s.delete(key)));emit(col)}};}
  const db={collection(col){return{path:col,doc:id=>docRef(col,id||rid()),add:async d=>{const r=docRef(col,rid());await r.set(d);return r},
    onSnapshot(next){(listeners[col]=listeners[col]||[]).push(next);emit(col);return()=>{listeners[col]=listeners[col].filter(f=>f!==next)}}}}};
  /* photos */
  const urls={};
  window.localBlobUrl=id=>urls[id]||"";
  const blobsReady=all("blobs").then(rows=>rows.forEach(([k,b])=>urls[k]=URL.createObjectURL(b))).catch(()=>{});
  const assets={upload:async b=>{const id=rid()+rid();await tx("blobs","readwrite",s=>req(s.put(b,id)));urls[id]=URL.createObjectURL(b);return{id,url:urls[id],sizeBytes:b.size,contentType:b.type}},
    delete:async id=>{await tx("blobs","readwrite",s=>req(s.delete(id)));if(urls[id]){URL.revokeObjectURL(urls[id]);delete urls[id]}},
    list:async()=>({assets:[],usage:{}})};
  /* file saving */
  const downloads={save:async({filename,data})=>{
    const blob=data instanceof Blob?data:new Blob([data]);
    const file=new File([blob],filename,{type:blob.type||"application/octet-stream"});
    const standalone=window.matchMedia("(display-mode: standalone)").matches||navigator.standalone;
    if(standalone&&navigator.canShare&&navigator.canShare({files:[file]})){try{await navigator.share({files:[file],title:filename});return{status:"saved"}}catch(e){if(e&&e.name==="AbortError")throw{code:"declined"}}}
    const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=filename;document.body.append(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},4000);return{status:"saved"};}};
  try{navigator.storage&&navigator.storage.persist&&navigator.storage.persist()}catch(e){}
  window.claude={use:async name=>{await blobsReady;return name==="db"?db:name==="assets"?assets:name==="downloads"?downloads:null}};
  /* backup / restore for the menu page */
  const b64=b=>new Promise(r=>{const fr=new FileReader();fr.onload=()=>r(fr.result);fr.readAsDataURL(b)});
  window.shopBackup=async()=>{const docs=await all("docs");const blobs=await all("blobs");const out={app:"shop-app",version:1,at:new Date().toISOString(),docs:Object.fromEntries(docs),blobs:{}};
    for(const [k,b] of blobs) out.blobs[k]=await b64(b);return new Blob([JSON.stringify(out)],{type:"application/json"});};
  window.shopRestore=async file=>{const j=JSON.parse(await file.text());if(j.app!=="shop-app")throw new Error("ไม่ใช่ไฟล์สำรองของแอปนี้");
    await tx("docs","readwrite",async s=>{for(const [k,v] of Object.entries(j.docs||{})) await req(s.put(v,k));});
    for(const [k,d] of Object.entries(j.blobs||{})){const b=await (await fetch(d)).blob();await tx("blobs","readwrite",s=>req(s.put(b,k)));}
    return Object.keys(j.docs||{}).length;};
  window.shopCount=async()=>{const d=await all("docs");return{docs:d.length,blobs:(await all("blobs")).length}};
})();
