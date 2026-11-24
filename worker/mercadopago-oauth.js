// GYM — Mercado Pago seller OAuth (preparación, sin cobros).
// No se activa hasta vincular endpoints, migrar D1 y cargar secretos del Worker.
const enc = new TextEncoder();
const out = (data,status=200)=>new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff"}});
const b64 = bytes=>btoa(String.fromCharCode(...bytes)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const fromB64 = value=>Uint8Array.from(atob(value.replace(/-/g,"+").replace(/_/g,"/")),c=>c.charCodeAt(0));
const ready = env=>!!(env.DB && /^\d{8,25}$/.test(env.MP_CLIENT_ID||"") && env.MP_CLIENT_SECRET && env.MP_TOKEN_ENCRYPTION_KEY && /^https:\/\/[^/]+\/api\/mp\/oauth\/callback$/.test(env.MP_OAUTH_REDIRECT_URI||""));
async function aesKey(env) {
 const bytes=fromB64(env.MP_TOKEN_ENCRYPTION_KEY);
 if(bytes.length!==32)throw Error("invalid_encryption_key");
 return crypto.subtle.importKey("raw",bytes,"AES-GCM",false,["encrypt","decrypt"]);
}
async function encrypt(env,plain){
 const iv=crypto.getRandomValues(new Uint8Array(12));
 const cipher=new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM",iv},await aesKey(env),enc.encode(plain)));
 return b64(iv)+"."+b64(cipher);
}
async function decrypt(env,data){
 const [iv,cipher]=data.split(".");
 return new TextDecoder().decode(await crypto.subtle.decrypt({name:"AES-GCM",iv:fromB64(iv)},await aesKey(env),fromB64(cipher)));
}
function go(status){return new Response(null,{status:303,headers:{location:"/admin/?mp="+encodeURIComponent(status),"cache-control":"no-store","referrer-policy":"no-referrer"}});}
async function tokenRequest(env,data){
 const response=await fetch("https://api.mercadopago.com/oauth/token",{
  method:"POST",headers:{"content-type":"application/json",accept:"application/json"},
  body:JSON.stringify({client_id:env.MP_CLIENT_ID,client_secret:env.MP_CLIENT_SECRET,...data})
 });
 if(!response.ok)throw Error("provider_rejected_"+response.status);
 const token=await response.json();
 if(!token.access_token||!token.refresh_token||!token.user_id)throw Error("invalid_provider_response");
 return token;
}
export async function mpStatus(env){
 if(!ready(env))return out({configured:false,connected:false});
 try{
  const row=await env.DB.prepare("SELECT seller_id,connected_at,expires_at FROM gym_mp_connections WHERE id=1").first();
  return out({configured:true,connected:!!row,sellerId:row?.seller_id||null,connectedAt:row?.connected_at||null,tokenNeedsRefresh:!!row&&row.expires_at<Date.now()+86400000});
 }catch{return out({configured:false,connected:false,error:"schema_unavailable"},503);}
}
export async function mpStart(env){
 if(!ready(env))return out({error:"mp_not_configured"},503);
 try{
  const state=b64(crypto.getRandomValues(new Uint8Array(32)));
  const verifier=b64(crypto.getRandomValues(new Uint8Array(48)));
  const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",enc.encode(verifier)));
  await env.DB.prepare("INSERT INTO gym_mp_oauth_attempts(state,verifier,expires_at) VALUES(?,?,?)")
   .bind(state,await encrypt(env,verifier),Date.now()+600000).run();
  const u=new URL("https://auth.mercadopago.com/authorization");
  for(const [k,v] of Object.entries({client_id:env.MP_CLIENT_ID,response_type:"code",platform_id:"mp",state,redirect_uri:env.MP_OAUTH_REDIRECT_URI,code_challenge:b64(digest),code_challenge_method:"S256"}))u.searchParams.set(k,v);
  return out({url:u.toString()});
 }catch{return out({error:"oauth_start_failed"},503);}
}
export async function mpCallback(env,url){
 if(!ready(env))return go("config");
 const state=url.searchParams.get("state")||"",code=url.searchParams.get("code")||"";
 if(!/^[A-Za-z0-9_-]{42,64}$/.test(state)||!code||code.length>300)return go("invalid");
 try{
  const row=await env.DB.prepare("SELECT verifier,expires_at FROM gym_mp_oauth_attempts WHERE state=?").bind(state).first();
  if(!row||row.expires_at<Date.now())return go("expired");
  const deleted=await env.DB.prepare("DELETE FROM gym_mp_oauth_attempts WHERE state=? AND expires_at>?").bind(state,Date.now()).run();
  if(deleted.meta.changes!==1)return go("expired");
  const verifier=await decrypt(env,row.verifier);
  const token=await tokenRequest(env,{grant_type:"authorization_code",code,redirect_uri:env.MP_OAUTH_REDIRECT_URI,code_verifier:verifier});
  const seller=String(token.user_id);
  if(!/^\d{1,30}$/.test(seller))return go("invalid");
  const existing=await env.DB.prepare("SELECT seller_id FROM gym_mp_connections WHERE id=1").first();
  if(existing&&existing.seller_id!==seller)return go("switch-blocked");
  const encrypted=await encrypt(env,JSON.stringify({access:token.access_token,refresh:token.refresh_token}));
  const expires=Date.now()+Math.max(300,Number(token.expires_in)||15552000)*1000;
  await env.DB.prepare("INSERT INTO gym_mp_connections(id,seller_id,secrets,expires_at) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET secrets=excluded.secrets,expires_at=excluded.expires_at,connected_at=CURRENT_TIMESTAMP")
   .bind(seller,encrypted,expires).run();
  return go("connected");
 }catch{return go("error");}
}
export async function mpAccessToken(env){
 if(!ready(env))return null;
 const row=await env.DB.prepare("SELECT seller_id,secrets,expires_at FROM gym_mp_connections WHERE id=1").first();
 if(!row)return null;
 let pair=JSON.parse(await decrypt(env,row.secrets));
 if(row.expires_at<Date.now()+86400000){
  const newToken=await tokenRequest(env,{grant_type:"refresh_token",refresh_token:pair.refresh});
  if(String(newToken.user_id)!==row.seller_id)throw Error("seller_changed");
  pair={access:newToken.access_token,refresh:newToken.refresh_token};
  await env.DB.prepare("UPDATE gym_mp_connections SET secrets=?,expires_at=? WHERE id=1 AND seller_id=?")
   .bind(await encrypt(env,JSON.stringify(pair)),Date.now()+Math.max(300,Number(newToken.expires_in)||15552000)*1000,row.seller_id).run();
 }
 return {token:pair.access,sellerId:row.seller_id};
}
export async function mpDisconnect(env,request){
 if(!ready(env))return out({error:"mp_not_configured"},503);
 try{
  const row=await env.DB.prepare("SELECT seller_id FROM gym_mp_connections WHERE id=1").first();
  if(!row)return out({ok:true,disconnected:true,alreadyDisconnected:true});
  const open=await env.DB.prepare("SELECT COUNT(*) AS n FROM gym_mp_payment_intents WHERE seller_id=? AND status IN ('created','pending','in_process')").bind(row.seller_id).first();
  const pendingCount=Number(open?.n||0);
  let confirmPending=false;
  if(pendingCount){
   try{const payload=await request.json();confirmPending=payload?.confirmPending===true&&payload?.sellerId===row.seller_id;}catch{}
   if(!confirmPending)return out({error:"pending_payments",pendingCount,sellerId:row.seller_id,message:"Hay "+pendingCount+" pagos anteriores pendientes. Si desvinculás igualmente, no se podrán verificar automáticamente mientras esta cuenta no esté vinculada."},409);
  }
  const result=await env.DB.prepare("DELETE FROM gym_mp_connections WHERE id=1 AND seller_id=?").bind(row.seller_id).run();
  return out({ok:true,disconnected:true,pendingCount,changed:result.meta?.changes||0});
 }catch(e){console.error("GYM MP disconnect:",e?.message);return out({error:"disconnect_failed"},503);}
}
