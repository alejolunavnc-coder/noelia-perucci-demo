// GYM Checkout Pro — OAuth seller isolation, server-side payment verification.
// No client supplied prices, seller IDs, or return statuses are trusted.
import {mpAccessToken} from './mercadopago-oauth.js';
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
 const preference={
  items:[{id:planId,title:'Rutina digital '+level+' - '+days+' días',description:'Entrenamiento digital PDF - Noelia Perucci',category_id:'services',quantity:1,currency_id:'ARS',unit_price:amount}],
  payer:{email},
  external_reference:id,
  back_urls:{success:landing('success'),pending:landing('pending'),failure:landing('failure')},
  auto_return:'approved',
  notification_url:origin+'/api/mp/webhook',
  statement_descriptor:'NOELIA PERUCCI',
  metadata:{gym_order:id}
 };
 try{
  const result=await mpFetch(account.token,'/checkout/preferences',{method:'POST',headers:{'X-Idempotency-Key':id},body:JSON.stringify(preference)});
  if(!result.id||!allowedUrl(result.init_point))throw Error('invalid_checkout_url');
  await env.DB.prepare("UPDATE gym_mp_payment_intents SET preference_id=?,status='pending' WHERE id=? AND seller_id=?")
   .bind(String(result.id),id,account.sellerId).run();
  return output({ok:true,orderId:id,checkoutUrl:result.init_point},201);
 }catch(e){
  await env.DB.batch([
   env.DB.prepare("UPDATE orders SET status='cancelled',updated_at=datetime('now') WHERE id=? AND status='pending'").bind(id),
   env.DB.prepare("UPDATE gym_mp_payment_intents SET status='cancelled' WHERE id=? AND status IN ('created','pending')").bind(id)
  ]);
  console.error('GYM checkout preference failed:',e.message);
  return output({error:'Mercado Pago no pudo iniciar la compra. Probá nuevamente o revisá el importe.'},502);
 }
}
async function reconcilePayment(env,id,orderHint){
 if(!paymentId.test(String(id||'')))return false;
 const account=await mpAccessToken(env).catch(()=>null);
 if(!account)return false;
 let payment;
 try{payment=await mpFetch(account.token,'/v1/payments/'+id);}catch{return false;}
 const orderId=String(payment.external_reference||'');
 if(!uuid.test(orderId)||orderHint&&orderId!==orderHint)return false;
 const row=await env.DB.prepare("SELECT o.id,o.amount_ars,o.status AS order_status,i.seller_id,i.payment_id,i.status AS intent_status FROM orders o JOIN gym_mp_payment_intents i ON i.order_id=o.id WHERE o.id=?").bind(orderId).first();
 if(!row||row.seller_id!==account.sellerId||String(payment.collector_id)!==account.sellerId||payment.currency_id!=='ARS'||Math.abs(Number(payment.transaction_amount)-Number(row.amount_ars))>0.001)return false;
 if(payment.live_mode===false&&env.MP_ALLOW_TEST_PAYMENTS!=='true')return false;
 const status=String(payment.status||'');
 const mapped={approved:'approved',pending:'pending',in_process:'in_process',rejected:'rejected',cancelled:'cancelled',refunded:'refunded',charged_back:'charged_back'}[status];
 if(!mapped)return false;
 // One order cannot become approved through a different payment after approval.
 if(row.order_status==='approved'&&row.payment_id&&row.payment_id!==String(id))return false;
 // Failed notifications can never downgrade an already approved order.
 if(row.order_status==='approved'&&mapped!=='approved')return true;
 // A pending attempt must not overwrite a successful payment ID.
 if(mapped==='approved'||!row.payment_id){
  await env.DB.batch([
   env.DB.prepare('UPDATE gym_mp_payment_intents SET payment_id=?,status=? WHERE id=? AND seller_id=?').bind(String(id),mapped,orderId,account.sellerId),
   env.DB.prepare("UPDATE orders SET status=?,provider_payment_id=?,updated_at=datetime('now') WHERE id=?").bind(mapped,String(id),orderId)
  ]);
 }
 return true;
}
export async function paymentWebhook(request,env){
 // Incoming webhook data is NEVER trusted as payment confirmation.
 // A remote authenticated GET using the linked seller token is mandatory.
 const url=new URL(request.url);
 let id=url.searchParams.get('data.id'),type=url.searchParams.get('type')||url.searchParams.get('topic');
 if(!id){
  const text=await request.text();
  if(text.length>8192)return output({ok:true});
  try{const body=JSON.parse(text);id=String(body?.data?.id||'');type=body?.type||body?.topic||type;}catch{}
 }
 if((type==='payment'||type==='payments')&&paymentId.test(String(id||''))){
  try{await reconcilePayment(env,id);}catch(e){console.error('GYM payment notification processing failed',e.message);}
 }
 return output({ok:true},200);
}
const hmac=async(secret,payload)=>{
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return [...new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode('gym-paid-pdf:v1:'+payload)))].map(n=>n.toString(16).padStart(2,'0')).join('');
};
export async function paymentStatus(request,env){
 const q=new URL(request.url).searchParams,orderId=q.get('order')||'',id=q.get('payment_id')||'';
 if(!uuid.test(orderId))return output({error:'Número de compra inválido.'},400);
 if(id&&paymentId.test(id))await reconcilePayment(env,id,orderId).catch(()=>false);
 const row=await env.DB.prepare("SELECT o.id,o.status,o.plan_id,o.provider_payment_id,o.amount_ars,o.customer_email FROM orders o JOIN gym_mp_payment_intents i ON i.order_id=o.id WHERE o.id=? AND o.provider='mercadopago'").bind(orderId).first();
 if(!row)return output({error:'Compra no encontrada.'},404);
 if(row.status!=='approved'||!row.provider_payment_id)return output({ok:true,status:row.status,approved:false,orderId});
 const expire=Date.now()+30*60*1000,nonce=crypto.randomUUID().replaceAll('-','');
 const payload=[orderId,expire,nonce,row.provider_payment_id].join('.');
 const token='paid.'+orderId+'.'+expire+'.'+nonce+'.'+await hmac(env.CLOUDINARY_API_SECRET,payload);
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
