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
async function logout() {
  return json({ok:true},200,{"set-cookie":cookie("",0)});
}
export default {
  async fetch(request,env) {
    const url=new URL(request.url),path=url.pathname,method=request.method;
    try{
      if(path==="/api/health" && method==="GET"){
        return json({ok:true,service:"gym",databaseConfigured:Boolean(env.DB)});
      }
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
        if(method==="POST" && !validOrigin(request)) return json({error:"Origen no autorizado."},403);
        if(path==="/api/auth/login" && method==="POST") return login(request,env);
        if(path==="/api/auth/logout" && method==="POST") return logout(request,env);
        return json({error:"Not found"},404);
      }
      return env.ASSETS.fetch(request);
    }catch(err){
      console.error("GYM Worker request failed",err?.message || "unknown");
      return json({error:"Error de servidor."},500);
    }
  }
};
