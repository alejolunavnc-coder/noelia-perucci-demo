import {mpStatus,mpStart,mpCallback,mpDisconnect} from './mercadopago-oauth.js';
import {adminExportRoutines} from './routine-export.js';
import {startPayment,paymentStatus,paymentWebhook,verifyPaidDownload,syncPendingOrders,issueDownloadToken} from './mercadopago-checkout.js';
import {mailReady,processDeliveryQueue,syncPastPurchases,recoverRequest,redeemRecovery,deliveryStatus,cleanupDelivery} from './transactional-email.js';
// GYM: password-only admin access, validating the existing Cloudflare secret.
// ADMIN_SETUP_TOKEN remains encrypted in Cloudflare; no account setup is required.
const COOKIE = "__Host-gym_session";
const SESSION_AGE = 60 * 60 * 24 * 7;
const enc = new TextEncoder();

function json(value, status = 200, extra = {}) {
  return new Response(JSON.stringify(value), { status, headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store", "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer", ...extra,
  } });
}
function html(markup, status = 200) {
  return new Response(markup, { status, headers: {
    "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
    "x-frame-options": "DENY", "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  } });
}
function redirect(location, clearCookie = false) {
  return new Response(null, { status: 303, headers: {
    location, "cache-control": "no-store",
    ...(clearCookie ? { "set-cookie": cookie("", 0) } : {}),
  } });
}
function cookie(token, age = SESSION_AGE) {
  return COOKIE + "=" + token + "; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=" + age;
}
function bytesHex(buffer) {
  return Array.from(new Uint8Array(buffer), b => b.toString(16).padStart(2, "0")).join("");
}
async function sha256(s) {
  return bytesHex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}
function randomHex(len) {
  const arr = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(arr, b => b.toString(16).padStart(2, "0")).join("");
}
function adminSecret(env) {
  return typeof env.ADMIN_SETUP_TOKEN === "string" && env.ADMIN_SETUP_TOKEN.length > 0
    ? env.ADMIN_SETUP_TOKEN : null;
}
function secureEquals(a,b) {
  if (a.length !== b.length) return false;
  let diff=0;
  for(let i=0;i<a.length;i++) diff|=a.charCodeAt(i)^b.charCodeAt(i);
  return diff===0;
}
async function hmacHex(secret, payload) {
  const key=await crypto.subtle.importKey("raw",enc.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  return bytesHex(await crypto.subtle.sign("HMAC",key,enc.encode("gym-admin-session:v2:"+payload)));
}
function readCookie(request) {
  const items=(request.headers.get("cookie")||"").split(";").map(c=>c.trim());
  const item=items.find(c=>c.startsWith(COOKIE+"="));
  return item ? item.slice(COOKIE.length+1) : null;
}
async function userFromRequest(request,env) {
  const secret=adminSecret(env);
  if(!secret)return null;
  const token=readCookie(request);
  if(!token || token.length>250)return null;
  const match=/^v2\.(\d{10,13})\.([a-f0-9]{32})\.([a-f0-9]{64})$/.exec(token);
  if(!match)return null;
  const expires=Number(match[1]);
  if(!Number.isSafeInteger(expires)||expires<Date.now()||expires>Date.now()+SESSION_AGE*1000)return null;
  const payload="v2."+match[1]+"."+match[2];
  const expected=await hmacHex(secret,payload);
  return secureEquals(expected,match[3]) ? {id:"gym-admin",role:"admin"} : null;
}
async function issueSession(secret) {
  const payload="v2."+(Date.now()+SESSION_AGE*1000)+"."+randomHex(16);
  return payload+"."+await hmacHex(secret,payload);
}
async function postedJson(request) {
  if (!(request.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) return null;
  const length = Number(request.headers.get("content-length") || 0);
  if (length > 8192) return null;
  const raw = await request.text();
  if (raw.length > 8192) return null;
  try { const obj = JSON.parse(raw); return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : null; } catch { return null; }
}
function validOrigin(request) {
  const origin = request.headers.get("origin");
  return origin === new URL(request.url).origin;
}

function page(title, content, script) {
  return html('<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>' + title + ' | Noelia Perucci</title><style>*{box-sizing:border-box}body{margin:0;min-height:100dvh;background:#151419;color:white;font:16px system-ui,Arial;display:grid;place-items:center;padding:20px}main{width:min(100%,420px);background:#242028;padding:32px;border-radius:16px;border:1px solid #54434f}h1{font-size:27px;margin:0 0 8px}p{color:#d5c5ce;line-height:1.5}label{display:block;margin:18px 0 8px}input{display:block;width:100%;padding:12px;border-radius:9px;border:1px solid #bbb;background:white;color:#111;font-size:16px}button{width:100%;padding:14px;margin-top:24px;color:white;background:#d00073;border:none;border-radius:9px;font-weight:700;font-size:16px;cursor:pointer}button:disabled{opacity:.6}small{display:block;margin-top:18px;color:#d8a8c4}#notice{min-height:22px;color:#ffb5d6}</style></head><body><main>' + content + '<p id="notice" role="status"></p></main><script>' + script + '</script></body></html>');
}
const formScript = String.raw`
const form=document.querySelector('form'),button=document.querySelector('button'),notice=document.getElementById('notice');
form.addEventListener('submit',async event=>{
 event.preventDefault();button.disabled=true;notice.textContent='Verificando…';
 try {
  const payload=Object.fromEntries(new FormData(form));
  const res=await fetch(form.dataset.endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),credentials:'same-origin'});
  const data=await res.json();
  if(!res.ok)throw Error(data.error||'No se pudo completar.');
  location.replace('/admin/');
 }catch(error){notice.textContent=error.message;button.disabled=false;}
});
`;
function loginPage() {
  return page("Ingresar", '<h1>Administración</h1><p>Ingresá a tu panel de Noelia Perucci.</p><form data-endpoint="/api/auth/login"><label for="password">Contraseña</label><input id="password" name="password" type="password" required autocomplete="current-password" autofocus><button type="submit">Ingresar</button></form>', formScript);
}

async function login(request,env) {
  const secret=adminSecret(env);
  if(!secret)return json({error:"El secreto ADMIN_SETUP_TOKEN no está disponible en este despliegue."},503);
  const data=await postedJson(request);
  if(!data||typeof data.password!=="string"||data.password.length>512) {
    return json({error:"Ingresá la contraseña configurada en Cloudflare."},400);
  }
  const valid=secureEquals(await sha256(data.password),await sha256(secret));
  if(!valid) {
    // Invalid attempts are limited in D1. Valid credentials do not depend on D1 availability.
    if(!env.DB)return json({error:"Protección de acceso temporalmente no disponible."},503);
    const ip=request.headers.get("cf-connecting-ip")||"unknown";
    const key=await sha256("admin-login:"+ip);
    const recent=await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM admin_audit_log WHERE action='auth_failed' AND entity_id=? AND created_at >= datetime('now','-15 minutes')"
    ).bind(key).first();
    if(recent.total>=8)return json({error:"Demasiados intentos. Intentá nuevamente en 15 minutos."},429,{"retry-after":"900"});
    await env.DB.prepare("INSERT INTO admin_audit_log(id,action,entity_type,entity_id) VALUES(?,'auth_failed','login',?)")
      .bind(crypto.randomUUID(),key).run();
    return json({error:"Contraseña incorrecta."},401);
  }
  const token=await issueSession(secret);
  return json({ok:true},200,{"set-cookie":cookie(token)});
}

const LEVELS=new Set(["principiante","intermedio","avanzado"]);
const DEFAULT_PRICES={2:50000,3:60000,4:80000,5:80000};
function cloudinaryReady(env) {
  return ["CLOUDINARY_CLOUD_NAME","CLOUDINARY_API_KEY","CLOUDINARY_API_SECRET"].every(k=>typeof env[k]==="string"&&env[k].length>0)
    && /^[a-z0-9_-]+$/i.test(env.CLOUDINARY_CLOUD_NAME);
}
function validSlot(level,days) { return LEVELS.has(level)&&Number.isInteger(days)&&days>=2&&days<=5; }
async function cloudinarySignature(parameters,secret) {
  const str=Object.entries(parameters).sort(([a],[b])=>a.localeCompare(b,"en")).map(([k,v])=>k+"="+v).join("&")+secret;
  return bytesHex(await crypto.subtle.digest("SHA-1",enc.encode(str)));
}
// Shared prices by days are stored in D1 site_content, without modifying PDF associations.
async function getSavedPrices(env) {
  if(!env.DB)throw Error("D1 no disponible");
  const r=await env.DB.prepare(
    "SELECT content_key,content_value FROM site_content WHERE content_key IN ('gym_price_days_2','gym_price_days_3','gym_price_days_4','gym_price_days_5')"
  ).all();
  const prices={...DEFAULT_PRICES};
  for(const item of r.results||[]) {
    const match=/^gym_price_days_([2-5])$/.exec(item.content_key);
    const value=Number(item.content_value);
    if(match&&Number.isSafeInteger(value)&&value>=1&&value<=10000000)prices[Number(match[1])]=value;
  }
  return prices;
}
async function publicPrices(env) {
  if(!env.DB)return json({error:"Precios no disponibles temporalmente."},503);
  const prices=await getSavedPrices(env);
  return json({ok:true,prices});
}
async function savePrices(request,env) {
  if(!env.DB)return json({error:"Base de datos no disponible."},503);
  const data=await postedJson(request);
  if(!data||!data.prices||typeof data.prices!=="object"||Array.isArray(data.prices))
    return json({error:"Ingresá los cuatro precios."},400);
  const prices={};
  for(const day of [2,3,4,5]) {
    const value=data.prices[day];
    if(typeof value!=="number"||!Number.isSafeInteger(value)||value<1||value>10000000)
      return json({error:"Precio inválido para "+day+" días. Usá un número entre $1 y $10.000.000."},400);
    prices[day]=value;
  }
  const entries=[2,3,4,5].map(day=>env.DB.prepare(
    "INSERT INTO site_content(content_key,content_value,kind,updated_at) VALUES(?,?,'text',datetime('now')) ON CONFLICT(content_key) DO UPDATE SET content_value=excluded.content_value,updated_at=datetime('now')"
  ).bind("gym_price_days_"+day,String(prices[day])));
  // Keep existing plan rows consistent with the public prices, without touching PDF assets.
  for(const day of [2,3,4,5])entries.push(env.DB.prepare(
    "UPDATE training_plans SET price_ars=?,updated_at=datetime('now') WHERE days_per_week=?"
  ).bind(prices[day],day));
  await env.DB.batch(entries);
  return json({ok:true,prices:await getSavedPrices(env)});
}
async function adminOrders(env) {
  if(!env.DB)return json({error:"Base de datos no disponible."},503);
  await syncPendingOrders(env).catch(error=>console.error('GYM admin payment sync failed',error?.message||'unknown'));
  await syncPastPurchases(env).catch(error=>console.error('GYM past-purchase email queue failed',error?.message||'unknown'));
  const r=await env.DB.prepare(
    "SELECT o.id,o.customer_email,o.amount_ars,o.status,o.provider,o.created_at,p.level,p.days_per_week AS days FROM orders o LEFT JOIN training_plans p ON p.id=o.plan_id ORDER BY o.created_at DESC LIMIT 100"
  ).all();
  return json({ok:true,orders:r.results||[]});
}

async function listRoutinePdfs(env) {
  if(!env.DB)return json({error:"Base de datos no disponible."},503);
  const result=await env.DB.prepare(
    "SELECT p.level,p.days_per_week AS days,m.original_filename AS filename,m.bytes,m.created_at AS uploaded_at FROM training_plans p LEFT JOIN media_assets m ON m.id=p.pdf_asset_id WHERE p.pdf_asset_id IS NOT NULL ORDER BY p.level,p.days_per_week"
  ).all();
  return json({ok:true,files:result.results||[],cloudinaryConfigured:cloudinaryReady(env)});
}
// Checkout without payment gateway: temporary public delivery until payment verification is integrated.
// NEVER use this endpoint as a verified purchase after Mercado Pago is enabled.
async function checkoutToken(secret,payload) {
  const key=await crypto.subtle.importKey("raw",enc.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  return bytesHex(await crypto.subtle.sign("HMAC",key,enc.encode("gym-checkout-delivery:v1:"+payload)));
}
async function planPdf(env,level,days) {
  return env.DB.prepare(
    "SELECT m.cloudinary_public_id,m.delivery_type,m.original_filename FROM training_plans p JOIN media_assets m ON m.id=p.pdf_asset_id WHERE p.level=? AND p.days_per_week=? AND p.active=1 AND m.resource_type='raw' LIMIT 1"
  ).bind(level,days).first();
}
async function completeCheckout(request,env) {
  if(!env.DB||!cloudinaryReady(env))return json({error:"La descarga no está disponible en este momento."},503);
  const data=await postedJson(request);
  const level=data?.level,days=Number(data?.days),email=String(data?.email||"").trim();
  if(!validSlot(level,days)||email.length>140||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return json({error:"Revisá el correo y la rutina seleccionada."},400);
  const asset=await planPdf(env,level,days);
  if(!asset)return json({error:"La rutina elegida no está disponible todavía. Elegí otra combinación."},409);
  if(asset.delivery_type!=="authenticated")return json({error:"El PDF no tiene configurada la entrega protegida."},503);
  const expires=Date.now()+30*60*1000;
  const payload=[level,days,expires,randomHex(16)].join(".");
  const token=payload+"."+(await checkoutToken(env.CLOUDINARY_API_SECRET,payload));
  return json({ok:true,level,days,downloadToken:token},200);
}
async function downloadCheckoutPdf(request,env) {
  if(!env.DB||!cloudinaryReady(env))return json({error:"La descarga no está disponible."},503);
  const verified=await verifyPaidDownload(request,env);
  if(!verified)return json({error:"No existe un pago aprobado que autorice esta descarga."},403);
  const {level,days}=verified;
  const asset=await planPdf(env,level,days);
  if(!asset||asset.delivery_type!=="authenticated"||!/^[a-zA-Z0-9_/-]+\.pdf$/.test(asset.cloudinary_public_id)){
    return json({error:"No encontramos el PDF de esta rutina."},404);
  }
  // Cloudinary's private_download_url signature. File is fetched server-side;
  // the browser never receives API credentials or a permanent public link.
  const timestamp=Math.floor(Date.now()/1000);
  const params={expires_at:String(timestamp+180),format:"pdf",public_id:asset.cloudinary_public_id,timestamp:String(timestamp),type:"authenticated"};
  const signatureCloud=await cloudinarySignature(params,env.CLOUDINARY_API_SECRET);
  const url="https://api.cloudinary.com/v1_1/"+env.CLOUDINARY_CLOUD_NAME+"/raw/download?"+
    new URLSearchParams({...params,api_key:env.CLOUDINARY_API_KEY,signature:signatureCloud});
  let remote;
  try{remote=await fetch(url,{headers:{accept:"application/pdf"}});}
  catch{return json({error:"No se pudo conectar con el archivo. Intentá nuevamente."},502);}
  if(!remote.ok)return json({error:"No se pudo recuperar el PDF. Código Cloudinary: "+remote.status},502);
  const type=(remote.headers.get("content-type")||"").toLowerCase();
  if(type&&!type.includes("pdf")&&!type.includes("octet-stream"))return json({error:"El archivo recibido no tiene un formato PDF válido."},502);
  return new Response(remote.body,{status:200,headers:{
    "content-type":"application/pdf",
    "content-disposition":'attachment; filename="rutina-'+level+'-'+days+'-dias.pdf"',
    "cache-control":"private, no-store",
    "x-content-type-options":"nosniff","x-frame-options":"DENY","referrer-policy":"no-referrer"
  }});
}

async function uploadRoutinePdf(request,env) {
  if(!env.DB)return json({error:"Base de datos no disponible."},503);
  if(!cloudinaryReady(env))return json({error:"Faltan las variables de Cloudinary en Cloudflare."},503);
  const size=Number(request.headers.get("content-length")||0);
  if(size>21*1024*1024)return json({error:"Máximo permitido: PDF de 20 MB."},413);
  if(!(request.headers.get("content-type")||"").toLowerCase().startsWith("multipart/form-data"))return json({error:"Formulario inválido."},415);
  const data=await request.formData();
  const level=data.get("level"),days=Number(data.get("days")),file=data.get("file");
  if(!validSlot(level,days))return json({error:"Seleccioná un nivel y días válidos."},400);
  if(!(file instanceof File)||file.size<5||file.size>20*1024*1024||!String(file.name).toLowerCase().endsWith(".pdf"))return json({error:"Elegí un PDF válido de hasta 20 MB."},400);
  const header=new Uint8Array(await file.slice(0,5).arrayBuffer());
  if(header[0]!==37||header[1]!==80||header[2]!==68||header[3]!==70||header[4]!==45)return json({error:"El archivo no tiene un formato PDF válido."},400);
  const timestamp=Math.floor(Date.now()/1000),folder="gym/noelia-perucci/rutinas",publicId=crypto.randomUUID()+".pdf";
  // Authenticated delivery prevents exposing paid routines as public Cloudinary URLs.
  const params={folder,public_id:publicId,timestamp:String(timestamp),type:"authenticated"};
  const signature=await cloudinarySignature(params,env.CLOUDINARY_API_SECRET);
  const upload=new FormData();
  upload.set("file",file,file.name);
  upload.set("api_key",env.CLOUDINARY_API_KEY);
  upload.set("signature",signature);
  for(const [k,v] of Object.entries(params))upload.set(k,v);
  let cloudResponse;
  try {
    cloudResponse=await fetch("https://api.cloudinary.com/v1_1/"+env.CLOUDINARY_CLOUD_NAME+"/raw/upload",{method:"POST",body:upload});
  }catch(e){return json({error:"No se pudo conectar con Cloudinary."},502);}
  const cloud=await cloudResponse.json().catch(()=>({}));
  if(!cloudResponse.ok)return json({error:"Cloudinary rechazó la subida. Verificá la API Key y el API Secret en Cloudflare."},502);
  if(typeof cloud.public_id!=="string"||cloud.resource_type!=="raw"||cloud.type!=="authenticated")return json({error:"Respuesta inesperada de Cloudinary."},502);
  const assetId=crypto.randomUUID(),planId=level+"-"+days;
  const activePrices=await getSavedPrices(env);
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO media_assets(id,cloudinary_public_id,resource_type,delivery_type,secure_url,original_filename,bytes,mime_type) VALUES(?,?,'raw','authenticated',NULL,?,?,'application/pdf')")
        .bind(assetId,cloud.public_id,file.name,file.size),
      env.DB.prepare("INSERT INTO training_plans(id,level,days_per_week,price_ars,pdf_asset_id) VALUES(?,?,?,?,?) ON CONFLICT(level,days_per_week) DO UPDATE SET pdf_asset_id=excluded.pdf_asset_id,updated_at=datetime('now')")
        .bind(planId,level,days,activePrices[days],assetId)
    ]);
  }catch(error) {
    console.error("GYM Cloudinary uploaded but DB save failed",error?.message||"unknown");
    return json({error:"El archivo se subió, pero no se pudo registrar en D1. No vuelvas a subirlo hasta revisar el error."},500);
  }
  return json({ok:true,level,days,filename:file.name,bytes:file.size},201);
}

async function logout() {
  return json({ok:true},200,{"set-cookie":cookie("",0)});
}
export default {
  async fetch(request,env,ctx) {
    const url=new URL(request.url),path=url.pathname,method=request.method;
    try{
      if(path==="/api/health" && method==="GET"){
        return json({ok:true,service:"gym",databaseConfigured:Boolean(env.DB)});
      }
      if(path==="/api/mp/oauth/callback" && method==="GET") return mpCallback(env,url);
      if(path==="/api/checkout/recover" && method==="GET")return redeemRecovery(request,env,issueDownloadToken);
      if(path==="/api/auth/status" && method==="GET"){
        return json({databaseConfigured:Boolean(env.DB),passwordConfigured:Boolean(adminSecret(env))});
      }
      if(path==="/admin") return redirect("/admin/");
      if(path==="/admin/login" || path==="/admin/login/") {
        if(method!=="GET") return json({error:"Método no permitido."},405);
        if(await userFromRequest(request,env)) return redirect("/admin/");
        return loginPage();
      }
      if(path==="/admin/setup" || path==="/admin/setup/") return redirect("/admin/login/");
      if(path==="/admin/" || path.startsWith("/admin/")) {
        const user=await userFromRequest(request,env);
        if(!user) return redirect("/admin/login/");
        const response=await env.ASSETS.fetch(request);
        const headers=new Headers(response.headers);
        headers.set("cache-control","private, no-store");
        headers.set("x-frame-options","DENY");
        headers.set("x-content-type-options","nosniff");
        return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
      }
      if(path==="/api/auth/me" && method==="GET"){
        const user=await userFromRequest(request,env);
        return user ? json({authenticated:true,user}) : json({authenticated:false},401);
      }
      if(path.startsWith("/api/")) {
        if(!["GET","POST"].includes(method)) return json({error:"Método no permitido."},405);
        if(method==="POST" && path!=="/api/mp/webhook" && !validOrigin(request)) return json({error:"Origen no autorizado."},403);
        if(path==="/api/auth/login" && method==="POST") return login(request,env);
        if(path==="/api/auth/logout" && method==="POST") return logout(request,env);
        if(path==="/api/prices" && method==="GET") return publicPrices(env);
        if(path==="/api/checkout/mail-status" && method==="GET")return json({configured:mailReady(env)});
        if(path==="/api/checkout/recover-request" && method==="POST")return recoverRequest(request,env,postedJson);
        if(path==="/api/admin/delivery-status" && method==="GET"){
          if(!await userFromRequest(request,env))return json({error:"Sesión vencida."},401);
          return deliveryStatus(env);
        }
        if(path==="/api/admin/delivery-retry" && method==="POST"){
          if(!await userFromRequest(request,env))return json({error:"Sesión vencida."},401);
          await syncPastPurchases(env);
          const report=await processDeliveryQueue(env);
          return json({ok:true,report});
        }

        if(path==="/api/mp/webhook" && method==="POST"){
          const response=await paymentWebhook(request,env);
          if(ctx?.waitUntil)ctx.waitUntil(processDeliveryQueue(env).catch(e=>console.error('GYM email delivery failed',e?.message)));
          return response;
        }
        if(path==="/api/checkout/start" && method==="POST")return startPayment(request,env,getSavedPrices,planPdf,postedJson);
        if(path==="/api/checkout/status" && method==="GET"){
          const response=await paymentStatus(request,env);
          if(ctx?.waitUntil)ctx.waitUntil(processDeliveryQueue(env).catch(e=>console.error('GYM email delivery failed',e?.message)));
          return response;
        }

        if(path==="/api/admin/mp/status" && method==="GET"){
          if(!await userFromRequest(request,env))return json({error:"Sesión vencida. Volvé a ingresar."},401);
          return mpStatus(env);
        }
        if(path==="/api/admin/mp/start" && method==="POST"){
          if(!await userFromRequest(request,env))return json({error:"Sesión vencida. Volvé a ingresar."},401);
          return mpStart(env);
        }
        if(path==="/api/admin/mp/disconnect" && method==="POST"){
          if(!await userFromRequest(request,env))return json({error:"Sesión vencida. Volvé a ingresar."},401);
          return mpDisconnect(env,request);
        }
        if(path==="/api/admin/prices" && ["GET","POST"].includes(method)){
          if(!await userFromRequest(request,env))return json({error:"Sesión vencida. Volvé a ingresar."},401);
          return method==="GET"?publicPrices(env):savePrices(request,env);
        }
        if(path==="/api/admin/orders" && method==="GET"){
          if(!await userFromRequest(request,env))return json({error:"Sesión vencida. Volvé a ingresar."},401);
          return adminOrders(env);
        }
        // Do not restore the old unpaid checkout/complete endpoint.
        if(path==="/api/checkout/complete" && method==="POST")return json({error:"Usá el checkout seguro de Mercado Pago."},410);
        if(path==="/api/checkout/download" && method==="GET")return downloadCheckoutPdf(request,env);
        if(path==="/api/admin/routine-pdfs/export" && method==="GET"){
          if(!await userFromRequest(request,env))return json({error:"Acceso restringido al administrador."},401);
          return adminExportRoutines(env);
        }
        if(path==="/api/admin/routine-pdfs" && method==="GET"){
          if(!await userFromRequest(request,env))return json({error:"Sesión vencida. Volvé a ingresar."},401);
          return listRoutinePdfs(env);
        }
        if(path==="/api/admin/routine-pdfs" && method==="POST"){
          if(!await userFromRequest(request,env))return json({error:"Sesión vencida. Volvé a ingresar."},401);
          return uploadRoutinePdf(request,env);
        }
        return json({error:"Not found"},404);
      }
      return env.ASSETS.fetch(request);
    }catch(err){
      console.error("GYM Worker request failed",err?.message || "unknown");
      return json({error:"Error de servidor."},500);
    }
  },
  async scheduled(_event,env,ctx){
    // Every 10 minutes: reconcile payment status and deliver pending emails.
    if(!env.DB)return;
    await syncPendingOrders(env).catch(e=>console.error('GYM scheduled MP sync error',e?.message));
    await syncPastPurchases(env).catch(e=>console.error('GYM scheduled mail queue error',e?.message));
    await processDeliveryQueue(env).catch(e=>console.error('GYM scheduled mail send error',e?.message));
    await cleanupDelivery(env).catch(e=>console.error('GYM scheduled cleanup error',e?.message));
  }
};
