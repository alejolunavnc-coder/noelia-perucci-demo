// Private, streamed ZIP backup of Noelia Perucci's 12 authenticated routine PDFs.
// ZIP 'store' entries: no compression, preserving originals and avoiding whole-archive RAM usage.
const enc=new TextEncoder();
function u16(view,at,n){view.setUint16(at,n,true);}
function u32(view,at,n){view.setUint32(at,n>>>0,true);}
const table=new Uint32Array(256);
for(let n=0;n<256;n++){let x=n;for(let i=0;i<8;i++)x=x&1?0xedb88320^(x>>>1):x>>>1;table[n]=x>>>0;}
function crcUpdate(crc,chunk){let x=crc;for(const b of chunk)x=table[(x^b)&255]^(x>>>8);return x>>>0;}
function local(name,time,date){
 const buf=new Uint8Array(30+name.length),v=new DataView(buf.buffer);
 u32(v,0,0x04034b50);u16(v,4,20);u16(v,6,0x808);u16(v,8,0);
 u16(v,10,time);u16(v,12,date);u16(v,26,name.length);buf.set(name,30);return buf;
}
function descriptor(crc,len){
 const b=new Uint8Array(16),v=new DataView(b.buffer);
 u32(v,0,0x08074b50);u32(v,4,crc);u32(v,8,len);u32(v,12,len);return b;
}
function central(e){
 const b=new Uint8Array(46+e.name.length),v=new DataView(b.buffer);
 u32(v,0,0x02014b50);u16(v,4,20);u16(v,6,20);u16(v,8,0x808);u16(v,10,0);
 u16(v,12,e.time);u16(v,14,e.date);u32(v,16,e.crc);u32(v,20,e.len);u32(v,24,e.len);
 u16(v,28,e.name.length);u32(v,42,e.offset);b.set(e.name,46);return b;
}
function end(count,bytes,offset){
 const b=new Uint8Array(22),v=new DataView(b.buffer);
 u32(v,0,0x06054b50);u16(v,8,count);u16(v,10,count);u32(v,12,bytes);u32(v,16,offset);return b;
}
function dosTime(date){
 const year=Math.max(1980,date.getUTCFullYear());
 return {time:(date.getUTCHours()<<11)|(date.getUTCMinutes()<<5)|(date.getUTCSeconds()>>1),
 date:((year-1980)<<9)|((date.getUTCMonth()+1)<<5)|date.getUTCDate()};
}
function sha1hex(buffer){return Array.from(new Uint8Array(buffer),x=>x.toString(16).padStart(2,'0')).join('');}
async function cloudinaryLink(env,publicId){
 const now=Math.floor(Date.now()/1000);
 const params={expires_at:String(now+180),format:'pdf',public_id:publicId,timestamp:String(now),type:'authenticated'};
 const str=Object.entries(params).sort(([a],[b])=>a.localeCompare(b,'en')).map(([k,v])=>k+'='+v).join('&')+env.CLOUDINARY_API_SECRET;
 const signature=sha1hex(await crypto.subtle.digest('SHA-1',enc.encode(str)));
 return 'https://api.cloudinary.com/v1_1/'+env.CLOUDINARY_CLOUD_NAME+'/raw/download?'+
  new URLSearchParams({...params,api_key:env.CLOUDINARY_API_KEY,signature});
}
async function* archive(env,items){
 const {time,date}=dosTime(new Date()),entries=[];
 let offset=0;
 for(const item of items){
  const name=enc.encode(item.level+'-'+item.days+'-dias.pdf'),entryOffset=offset;
  const header=local(name,time,date);yield header;offset+=header.length;
  const remote=await fetch(await cloudinaryLink(env,item.cloudinary_public_id),{headers:{accept:'application/pdf'}});
  if(!remote.ok||!remote.body)throw Error('Cloudinary PDF download failed ('+remote.status+')');
  const mime=(remote.headers.get('content-type')||'').toLowerCase();
  if(mime&&!mime.includes('pdf')&&!mime.includes('octet-stream'))throw Error('Unexpected Cloudinary PDF content type');
  const reader=remote.body.getReader();
  let crc=0xffffffff,len=0;
  try{
   while(true){
    const {done,value}=await reader.read();if(done)break;
    if(!value?.byteLength)continue;
    len+=value.byteLength;
    if(len>21*1024*1024)throw Error('PDF size exceeds limit');
    crc=crcUpdate(crc,value);yield value;offset+=value.byteLength;
   }
  }finally{reader.releaseLock();}
  crc=(crc^0xffffffff)>>>0;
  const desc=descriptor(crc,len);yield desc;offset+=desc.length;
  entries.push({name,crc,len,offset:entryOffset,date,time});
 }
 const start=offset;
 for(const entry of entries){const v=central(entry);yield v;offset+=v.length;}
 yield end(entries.length,offset-start,start);
}
export async function adminExportRoutines(env){
 if(!env.DB||!env.CLOUDINARY_API_SECRET||!env.CLOUDINARY_API_KEY||!env.CLOUDINARY_CLOUD_NAME)
  return new Response(JSON.stringify({error:'Almacenamiento no configurado.'}),{status:503,headers:{'content-type':'application/json','cache-control':'no-store'}});
 const result=await env.DB.prepare("SELECT p.level,p.days_per_week AS days,m.cloudinary_public_id FROM training_plans p JOIN media_assets m ON m.id=p.pdf_asset_id WHERE p.active=1 AND m.resource_type='raw' AND m.delivery_type='authenticated' ORDER BY p.level,p.days_per_week").all();
 const items=result.results||[];
 const valid=new Set(['principiante','intermedio','avanzado']);
 const keys=new Set(items.map(x=>x.level+'-'+x.days));
 if(items.length!==12||keys.size!==12||items.some(x=>!valid.has(x.level)||![2,3,4,5].includes(x.days)||!/^[a-zA-Z0-9_/-]+\.pdf$/.test(x.cloudinary_public_id)))
  return new Response(JSON.stringify({error:'No están disponibles las 12 rutinas. Revisá los PDF antes de descargar el respaldo.'}),{status:409,headers:{'content-type':'application/json','cache-control':'no-store'}});
 const iterator=archive(env,items);
 const body=new ReadableStream({
  async pull(controller){try{const next=await iterator.next();if(next.done)controller.close();else controller.enqueue(next.value);}catch(e){console.error('GYM ZIP export error:',e?.message);controller.error(e);}},
  async cancel(){if(iterator.return)await iterator.return();}
 });
 return new Response(body,{status:200,headers:{
  'content-type':'application/zip',
  'content-disposition':'attachment; filename="noelia-perucci-rutinas-completas.zip"',
  'cache-control':'private, no-store',
  'x-content-type-options':'nosniff',
  'referrer-policy':'no-referrer'
 }});
}
