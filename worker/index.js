// GYM — Cloudflare Worker / D1 administration authentication.
// Secrets: ADMIN_SETUP_TOKEN (Cloudflare encrypted secret, never committed).
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
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
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
async function passwordHash(password, salt = randomHex(16)) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const value = await crypto.subtle.deriveBits({ name:"PBKDF2", hash:"SHA-256", salt:enc.encode(salt), iterations:310000 }, key, 256);
  return "pbkdf2-sha256$310000$" + salt + "$" + bytesHex(value);
}
async function verifyPassword(password, saved) {
  const parts = String(saved || "").split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2-sha256" || parts[1] !== "310000" || !/^[a-f0-9]{32}$/.test(parts[2])) return false;
  const computed = (await passwordHash(password, parts[2])).split("$")[3];
  const expected = parts[3];
  if (expected.length !== computed.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) diff |= computed.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
function readCookie(request) {
  const items = (request.headers.get("cookie") || "").split(";").map(c => c.trim());
  const item = items.find(c => c.startsWith(COOKIE + "="));
  const token = item?.slice(COOKIE.length + 1) || "";
  return /^[a-f0-9]{64}$/.test(token) ? token : null;
}
async function userFromRequest(request, env) {
  if (!env.DB) return null;
  const token = readCookie(request);
  if (!token) return null;
  const hash = await sha256(token);
  return env.DB.prepare(
    "SELECT u.id, u.email, u.role FROM admin_sessions s JOIN admin_users u ON u.id=s.user_id WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at > datetime('now') AND u.disabled=0 LIMIT 1"
  ).bind(hash).first();
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
function validEmail(email) {
  return typeof email === "string" && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
function validPassword(password) {
  return typeof password === "string" && password.length >= 12 && password.length <= 128;
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
function setupPage() {
  return page("Crear administrador", '<h1>Crear acceso inicial</h1><p>Esta pantalla funciona una sola vez. Configurá primero ADMIN_SETUP_TOKEN como secreto de Cloudflare.</p><form data-endpoint="/api/auth/setup"><label for="email">Correo del administrador</label><input id="email" name="email" type="email" required autocomplete="username"><label for="password">Contraseña (12 caracteres mínimo)</label><input id="password" name="password" type="password" minlength="12" required autocomplete="new-password"><label for="token">Código secreto de configuración</label><input id="token" name="token" type="password" required autocomplete="off"><button type="submit">Crear administrador</button></form>', formScript);
}
async function issueSession(db, userId) {
  const token = randomHex(32);
  const hash = await sha256(token);
  await db.prepare("INSERT INTO admin_sessions(id,user_id,token_hash,expires_at) VALUES(?,?,?,datetime('now','+7 days'))").bind(crypto.randomUUID(), userId, hash).run();
  return token;
}
async function setup(request, env) {
  if (!env.DB || typeof env.ADMIN_SETUP_TOKEN !== "string" || env.ADMIN_SETUP_TOKEN.length < 32) return json({error:"Configuración no habilitada."},503);
  const data = await postedJson(request);
  if (!data || !validEmail(data.email) || !validPassword(data.password) || typeof data.token !== "string") return json({error:"Revisá los datos (contraseña mínima de 12 caracteres)."},400);
  const count = await env.DB.prepare("SELECT COUNT(*) AS total FROM admin_users").first();
  if (count.total > 0) return json({error:"Ya existe un administrador."},409);
  const expected = await sha256(env.ADMIN_SETUP_TOKEN), actual = await sha256(data.token);
  if (expected !== actual) return json({error:"Código de configuración incorrecto."},403);
  const id=crypto.randomUUID(), email=data.email.trim().toLowerCase(), hash=await passwordHash(data.password);
  const result=await env.DB.prepare("INSERT INTO admin_users(id,email,password_hash) SELECT ?,?,? WHERE NOT EXISTS(SELECT 1 FROM admin_users)").bind(id,email,hash).run();
  if (result.meta?.changes !== 1) return json({error:"Ya existe un administrador."},409);
  const token=await issueSession(env.DB,id);
  return json({ok:true},201, {"set-cookie":cookie(token)});
}
async function login(request, env) {
  if (!env.DB) return json({error:"Base de datos no disponible."},503);
  const data = await postedJson(request);
  if (!data || typeof data.password !== "string" || data.password.length > 128) return json({error:"Credenciales incorrectas."},401);
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const key = await sha256("admin-login:" + ip);
  const recent = await env.DB.prepare("SELECT COUNT(*) AS total FROM admin_audit_log WHERE action='auth_failed' AND entity_id=? AND created_at >= datetime('now','-15 minutes')").bind(key).first();
  if (recent.total >= 8) return json({error:"Demasiados intentos. Probá nuevamente más tarde."},429,{"retry-after":"900"});
  const users = await env.DB.prepare("SELECT id,password_hash FROM admin_users WHERE disabled=0 LIMIT 2").all();
  // Password-only login is safe only for this single-administrator installation.
  if (users.results.length !== 1) return json({error:"El acceso requiere configurar un único administrador."},503);
  const user=users.results[0];
  if (!(await verifyPassword(data.password,user.password_hash))) {
    await env.DB.prepare("INSERT INTO admin_audit_log(id,action,entity_type,entity_id) VALUES(?,'auth_failed','login',?)").bind(crypto.randomUUID(),key).run();
    return json({error:"Contraseña incorrecta."},401);
  }
  const token=await issueSession(env.DB,user.id);
  return json({ok:true},200,{"set-cookie":cookie(token)});
}
async function logout(request,env) {
  const token=readCookie(request);
  if(token && env.DB) await env.DB.prepare("UPDATE admin_sessions SET revoked_at=datetime('now') WHERE token_hash=?").bind(await sha256(token)).run();
  return json({ok:true},200,{"set-cookie":cookie("",0)});
}
export default {
  async fetch(request,env) {
    const url=new URL(request.url),path=url.pathname,method=request.method;
    try{
      if(path==="/api/health" && method==="GET"){
        return json({ok:true,service:"gym",databaseConfigured:Boolean(env.DB)});
      }
      if(path==="/admin") return redirect("/admin/");
      if(path==="/admin/login" || path==="/admin/login/") {
        if(method!=="GET") return json({error:"Método no permitido."},405);
        if(await userFromRequest(request,env)) return redirect("/admin/");
        if(!env.DB) return json({error:"Base de datos no disponible."},503);
        const count=await env.DB.prepare("SELECT COUNT(*) AS total FROM admin_users").first();
        if(count.total===0 && env.ADMIN_SETUP_TOKEN) return redirect("/admin/setup/");
        return loginPage();
      }
      if(path==="/admin/setup" || path==="/admin/setup/") {
        if(method!=="GET") return json({error:"Método no permitido."},405);
        if(!env.ADMIN_SETUP_TOKEN) return new Response("Not found",{status:404});
        const total=await env.DB.prepare("SELECT COUNT(*) AS total FROM admin_users").first();
        if(total.total>0) return redirect("/admin/login/");
        return setupPage();
      }
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
        if(path==="/api/auth/setup" && method==="POST") return setup(request,env);
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
