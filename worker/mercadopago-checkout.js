// GYM Checkout Pro — OAuth seller isolation, server-side payment verification.
// No client supplied prices, seller IDs, or return statuses are trusted.
import {mpAccessToken} from './mercadopago-oauth.js';
import {queueDelivery} from './transactional-email.js';
const output=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'}});
const levels=new Set(['principiante','intermedio','avanzado']);
const validEmail=s=>typeof s==='string'&&s.length<=140&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const paymentId=/^[0-9]{1,28}$/;
async function mpFetch(token,path,options={}){
 const response=await fetch('https://api.mercadopago.com'+path,{
  ...options,
  headers:{authorization:'Bearer '+token,accept:'application/json',...(options.body?{'content-type':'application/json'}:{}),...(options.headers||{})}
 });
 const data=await response.json().catch(()=>({}));
 if(!response.ok)throw Error('mercadopago_http_'+response.status);
 return data;
}
function allowedUrl(u){
 try{const x=new URL(u);return x.protocol==='https:'&&(/(^|\.)mercadopago\.com(\.ar)?$/.test(x.hostname)||x.hostname==='sandbox.mercadopago.com');}catch{return false;}
}
export async function startPayment(request,env,getPrices,planPdf,postedJson){
 if(!env.DB)return output({error:'Base de datos no disponible.'},503);
 const data=await postedJson(request);
 const level=data?.level,days=data?.days,email=String(data?.email||'').trim().toLowerCase();
 if(!levels.has(level)||!Number.isInteger(days)||days<2||days>5||!validEmail(email))
   return output({error:'Revisá la rutina y el correo electrónico.'},400);
 const account=await mpAccessToken(env).catch(()=>null);
 if(!account)return output({error:'Mercado Pago no está disponible. Consultá con el administrador.'},503);
 const pdf=await planPdf(env,level,days);
 if(!pdf||pdf.delivery_type!=='authenticated')return output({error:'Esta rutina todavía no tiene su PDF disponible.'},409);
 const prices=await getPrices(env),amount=prices[days];
 if(!Number.isSafeInteger(amount)||amount<1||amount>10000000)return output({error:'Precio inválido.'},409);
 const id=crypto.randomUUID(),planId=level+'-'+days;
 await env.DB.batch([
  env.DB.prepare("INSERT INTO orders(id,plan_id,customer_email,amount_ars,status,provider) VALUES(?,?,?,?,'pending','mercadopago')").bind(id,planId,email,amount),
  env.DB.prepare("INSERT INTO gym_mp_payment_intents(id,seller_id,order_id,status,amount_cents) VALUES(?,?,?,'created',?)").bind(id,account.sellerId,id,amount*100)
 ]);
 const url=new URL(request.url),origin=url.origin;
 // The URL is created on this host, never from user-controlled headers.
 const landing=kind=>origin+'/?gym_order='+encodeURIComponent(id)+'&gym_result='+kind+'#pago';
 const total=amount.toFixed(2);
 const order={
  type:'online',processing_mode:'manual',capture_mode:'automatic_async',
  total_amount:total,external_reference:id,
  description:'Rutina digital Noelia Perucci',
  payer:{email},
  items:[{title:'Rutina digital '+level+' - '+days+' días',quantity:1,unit_price:total,external_code:planId}],
  config:{statement_descriptor:'NOELIA PERUCCI',
   online:{success_url:landing('success'),failure_url:landing('failure'),pending_url:landing('pending'),auto_return:'approved',retries:{allowed:false}}}
 };
 try{
  const result=await mpFetch(account.token,'/v1/orders',{method:'POST',headers:{'X-Idempotency-Key':id},body:JSON.stringify(order)});
  if(!result.id||!allowedUrl(result.checkout_url)||String(result.user_id)!==account.sellerId)throw Error('invalid_checkout_order');
  await env.DB.prepare("UPDATE gym_mp_payment_intents SET preference_id=?,status='pending' WHERE id=? AND seller_id=?")
   .bind(String(result.id),id,account.sellerId).run();
  return output({ok:true,orderId:id,checkoutUrl:result.checkout_url},201);
 }catch(e){
  await env.DB.batch([
   env.DB.prepare("UPDATE orders SET status='cancelled',updated_at=datetime('now') WHERE id=? AND status='pending'").bind(id),
   env.DB.prepare("UPDATE gym_mp_payment_intents SET status='cancelled' WHERE id=? AND status IN ('created','pending')").bind(id)
  ]);
  console.error('GYM checkout preference failed:',e.message);
  return output({error:'Mercado Pago no pudo iniciar la compra. Probá nuevamente o revisá el importe.'},502);
 }
}
async function reconcileOrder(env,mpOrderId,orderHint){
 if(!/^ORD[A-Z0-9_-]{10,90}$/.test(String(mpOrderId||'')))return false;
 // Match a known order before making any authenticated API request.
 const row=await env.DB.prepare("SELECT o.id,o.amount_ars,o.status AS order_status,i.seller_id,i.payment_id,i.preference_id FROM orders o JOIN gym_mp_payment_intents i ON i.order_id=o.id WHERE i.preference_id=? AND o.provider='mercadopago'").bind(mpOrderId).first();
 if(!row||orderHint&&row.id!==orderHint)return false;
 const account=await mpAccessToken(env).catch(()=>null);
 if(!account||row.seller_id!==account.sellerId)return false;
 let remote;
 try{remote=await mpFetch(account.token,'/v1/orders/'+encodeURIComponent(mpOrderId));}catch{return false;}
 if(String(remote.id)!==mpOrderId||String(remote.user_id)!==account.sellerId||String(remote.external_reference)!==row.id||
  remote.currency!=='ARS'||Math.abs(Number(remote.total_amount)-Number(row.amount_ars))>0.001)return false;
 if(remote.live_mode===false&&env.MP_ALLOW_TEST_PAYMENTS!=='true')return false;
 const raw=String(remote.status||''),detail=String(remote.status_detail||'');
 let status=({created:'pending',processing:'in_process',action_required:'in_process',failed:'rejected',canceled:'cancelled',refunded:'refunded'})[raw];
 if(raw==='processed'){
  if(detail==='accredited'&&Math.abs(Number(remote.total_paid_amount)-Number(row.amount_ars))<0.001)status='approved';
  else if(detail==='partially_refunded')status='refunded';
  else status='in_process';
 }
 if(!status)return false;
 // An approved order is never downgraded due to stale pending/failed events.
 if(row.order_status==='approved'&&['pending','in_process','rejected','cancelled'].includes(status)){await queueDelivery(env,row.id);return true;}
 await env.DB.batch([
  env.DB.prepare("UPDATE gym_mp_payment_intents SET payment_id=?,status=? WHERE order_id=? AND seller_id=?")
   .bind(String(mpOrderId),status,row.id,account.sellerId),
  env.DB.prepare("UPDATE orders SET status=?,provider_payment_id=?,updated_at=datetime('now') WHERE id=?")
   .bind(status,String(mpOrderId),row.id)
 ]);
 if(status==='approved')await queueDelivery(env,row.id);
 return true;
}
export async function syncPendingOrders(env){
 if(!env.DB)return 0;
 const rows=await env.DB.prepare("SELECT preference_id FROM gym_mp_payment_intents WHERE preference_id IS NOT NULL AND status IN ('created','pending','in_process') ORDER BY created_at DESC LIMIT 12").all();
 let checked=0;
 for(const row of rows.results||[]){
  try{if(await reconcileOrder(env,row.preference_id))checked++;}catch(e){console.error('GYM order reconciliation error',e.message);}
 }
 return checked;
}
export async function paymentWebhook(request,env){
 // Untrusted notification is only a trigger; the order is verified via Mercado Pago API.
 const url=new URL(request.url);
 let id=url.searchParams.get('data.id'),type=url.searchParams.get('type')||url.searchParams.get('topic');
 if(!id){
  const text=await request.text();
  if(text.length>8192)return output({ok:true});
  try{const body=JSON.parse(text);id=String(body?.data?.id||'');type=body?.type||body?.topic||type;}catch{}
 }
 if(type==='order'&&/^ORD[A-Z0-9_-]{10,90}$/.test(String(id||''))){
  try{await reconcileOrder(env,id);}catch(e){console.error('GYM order webhook failed',e.message);}
 }
 return output({ok:true});
}
const hmac=async(secret,payload)=>{
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return [...new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode('gym-paid-pdf:v1:'+payload)))].map(n=>n.toString(16).padStart(2,'0')).join('');
};
export async function issueDownloadToken(env,order){
 if(!env.CLOUDINARY_API_SECRET||!order?.provider_payment_id||!orderPatternCheck(order.id))throw Error('invalid_order_grant');
 const expire=Date.now()+30*60*1000,nonce=crypto.randomUUID().replaceAll('-');
 const payload=[order.id,expire,nonce,order.provider_payment_id].join('.');
 return 'paid.'+order.id+'.'+expire+'.'+nonce+'.'+await hmac(env.CLOUDINARY_API_SECRET,payload);
}
const orderPatternCheck=s=>uuid.test(String(s||''));
export async function paymentStatus(request,env){
 const q=new URL(request.url).searchParams,orderId=q.get('order')||'';
 if(!uuid.test(orderId))return output({error:'Número de compra inválido.'},400);
 const row=await env.DB.prepare("SELECT o.id,o.status,o.plan_id,o.provider_payment_id,o.amount_ars,o.customer_email,i.preference_id FROM orders o JOIN gym_mp_payment_intents i ON i.order_id=o.id WHERE o.id=? AND o.provider='mercadopago'").bind(orderId).first();
 if(row?.preference_id)await reconcileOrder(env,row.preference_id,orderId).catch(()=>false);
 if(row){const latest=await env.DB.prepare("SELECT status,provider_payment_id FROM orders WHERE id=?").bind(orderId).first();if(latest){row.status=latest.status;row.provider_payment_id=latest.provider_payment_id;}}
 if(!row)return output({error:'Compra no encontrada.'},404);
 if(row.status!=='approved'||!row.provider_payment_id)return output({ok:true,status:row.status,approved:false,orderId});
 const token=await issueDownloadToken(env,row);
 const [level,days]=row.plan_id.split('-');
 return output({ok:true,status:'approved',approved:true,orderId,level,days:Number(days),downloadToken:token});
}
export async function verifyPaidDownload(request,env){
 const token=new URL(request.url).searchParams.get('token')||'';
 const m=/^paid\.([a-f0-9-]{36})\.(\d{13})\.([a-f0-9]{32})\.([a-f0-9]{64})$/.exec(token);
 if(!m||!uuid.test(m[1])||!env.CLOUDINARY_API_SECRET)return null;
 const [,id,exp,nonce,signature]=m;
 if(Number(exp)<Date.now()||Number(exp)>Date.now()+30*60*1000)return null;
 const row=await env.DB.prepare("SELECT plan_id,provider_payment_id FROM orders WHERE id=? AND provider='mercadopago' AND status='approved' AND provider_payment_id IS NOT NULL").bind(id).first();
 if(!row)return null;
 const expected=await hmac(env.CLOUDINARY_API_SECRET,[id,exp,nonce,row.provider_payment_id].join('.'));
 if(expected.length!==signature.length)return null;
 let diff=0;for(let i=0;i<expected.length;i++)diff|=expected.charCodeAt(i)^signature.charCodeAt(i);
 if(diff!==0)return null;
 const [level,daysText]=String(row.plan_id||'').split('-'),days=Number(daysText);
 return levels.has(level)&&Number.isInteger(days)&&days>=2&&days<=5?{level,days}:null;
}
