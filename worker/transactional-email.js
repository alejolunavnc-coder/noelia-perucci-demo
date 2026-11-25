// GYM transactional delivery: encrypted-at-rest MP tokens remain in oauth module.
// Email is sent only for approved orders, via the configured Resend account.
// Purchase recovery is proof-of-email-possession (a secret link sent to that mailbox).
const response=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'}});
const emailPattern=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const orderPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const encoder=new TextEncoder();
const hex=buffer=>Array.from(new Uint8Array(buffer),b=>b.toString(16).padStart(2,'0')).join('');
const digest=async value=>hex(await crypto.subtle.digest('SHA-256',encoder.encode(value)));
const bytesUrl=arr=>btoa(String.fromCharCode(...arr)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const site='https://peruccinoelia.com.ar';
const configured=env=>typeof env.RESEND_API_KEY==='string'&&env.RESEND_API_KEY.startsWith('re_')&&typeof env.GYM_MAIL_FROM==='string'&&/^[^\s@]+@(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(env.GYM_MAIL_FROM);
export const mailReady=env=>configured(env);
async function newLink(env,orderId){
 const raw=bytesUrl(crypto.getRandomValues(new Uint8Array(32)));
 const tokenHash=await digest(raw);
 const expiry=Date.now()+30*24*3600*1000;
 await env.DB.prepare('INSERT INTO gym_delivery_links(token_hash,order_id,created_at,expires_at) VALUES(?,?,?,?)')
 .bind(tokenHash,orderId,Date.now(),expiry).run();
 return site+'/api/checkout/recover?token='+encodeURIComponent(raw);
}
async function sendMail(env,to,subject,html,text,idempotencyKey){
 const r=await fetch('https://api.resend.com/emails',{
  method:'POST',
  headers:{authorization:'Bearer '+env.RESEND_API_KEY,'content-type':'application/json','Idempotency-Key':idempotencyKey},
  body:JSON.stringify({from:'Noelia Perucci <'+env.GYM_MAIL_FROM+'>',to:[to],subject,html,text})
 });
 const result=await r.json().catch(()=>({}));
 if(!r.ok||typeof result.id!=='string'){
  console.error('GYM mail service error status',r.status);
  throw Error('mail_http_'+r.status);
 }
 return result.id;
}
async function sendPersonalizedConfirmation(env,row,purpose='purchase'){
 const heading=purpose==='recover'?'Comprobante de tu plan personalizado':'¡Tu compra está confirmada!';
 const subject=purpose==='recover'?'Comprobante de compra | Noelia Perucci':'Plan personalizado confirmado | Noelia Perucci';
 const note='Compraste un plan de entrenamiento personalizado. Esta compra no incluye un PDF de descarga automática. Conservá este número de pedido para coordinar los detalles del servicio directamente con Noelia.';
 const html='<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>'+
 '<body style="margin:0;padding:32px 16px;background:#f4f2ee;font-family:Arial,sans-serif;color:#191619"><table role="presentation" style="max-width:550px;margin:auto;width:100%;background:#fff;border-collapse:collapse"><tr><td style="background:#161216;padding:24px;color:white;font-size:23px;font-weight:bold">NOELIA PERUCCI</td></tr><tr><td style="padding:32px">'+
 '<h1 style="font-size:25px">'+heading+'</h1><p style="line-height:1.6">'+note+'</p>'+
 '<p style="line-height:1.6"><b>Número de compra:</b> '+esc(row.id)+'</p>'+
 '<p style="font-weight:600;margin-top:28px">Gracias por confiar. Haremos un gran equipo.</p>'+
 '<p style="font-size:12px;color:#777">Si no realizaste esta compra, podés ignorar este mensaje.</p></td></tr></table></body></html>';
 const text=heading+'\n\n'+note+'\n\nNúmero de compra: '+row.id+'\n\nGracias por confiar. Haremos un gran equipo.';
 return sendMail(env,row.customer_email,subject,html,text,'gym-personalized-'+purpose+'-'+crypto.randomUUID());
}
async function sendPurchase(env,row,purpose='purchase'){
 if(row.product_type==='personalizado')return sendPersonalizedConfirmation(env,row,purpose);
 const level=row.plan_id.split('-')[0],days=row.plan_id.split('-')[1];
 const names={principiante:'Principiante',intermedio:'Intermedio',avanzado:'Avanzado'};
 const label=(names[level]||'Entrenamiento')+' · '+days+' días';
 const link=await newLink(env,row.id);
 const subject=purpose==='recover'?'Recuperá tu rutina | Noelia Perucci':'Tu rutina de entrenamiento está lista | Noelia Perucci';
 const header=purpose==='recover'?'Recuperá tu rutina':'¡Tu compra está confirmada!';
 const button='DESCARGAR MI RUTINA';
 const html='<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>'+
  '<body style="margin:0;padding:32px 16px;background:#f4f2ee;font-family:Arial,sans-serif;color:#191619"><table role="presentation" style="width:100%;max-width:550px;margin:0 auto;border-collapse:collapse;background:#fff"><tr><td style="background:#161216;padding:24px;color:#fff;font-size:23px;font-weight:800">NOELIA PERUCCI</td></tr><tr><td style="padding:32px">'+
  '<h1 style="font-size:25px;line-height:1.2;margin:0 0 18px">'+header+'</h1><p style="line-height:1.6">Tu rutina <b>'+esc(label)+'</b> está disponible para descargar.</p>'+ 
  '<p style="line-height:1.6">Podés guardarla cuando quieras usando este enlace privado:</p>'+
  '<p style="margin:30px 0"><a href="'+esc(link)+'" style="display:inline-block;background:#cf006d;color:#fff;text-decoration:none;font-weight:bold;padding:16px 24px;border-radius:7px">'+button+'</a></p>'+
  '<p style="line-height:1.6;font-weight:600">Gracias por confiar. Haremos un gran equipo.</p>'+
  '<p style="font-size:13px;color:#555;line-height:1.5">Este enlace tiene validez de 30 días. No lo compartas. Si vence, pedí uno nuevo desde la web.</p>'+
  '<p style="font-size:12px;color:#777;line-height:1.5">Pedido: '+esc(row.id)+'<br>Si no realizaste esta compra, podés ignorar este mensaje.</p></td></tr></table></body></html>';
 const text=header+'\n\nTu rutina '+label+' está disponible para descargar.\n\nDescargar: '+link+'\n\nGracias por confiar. Haremos un gran equipo.\n\nEnlace privado, válido 30 días.\nPedido: '+row.id;
 // Unique per attempt, so intentionally requesting a replacement link always sends a new email.
 return sendMail(env,row.customer_email,subject,html,text,'gym-'+purpose+'-'+crypto.randomUUID());
}
export async function queueDelivery(env,orderId){
 if(!env.DB||!orderPattern.test(orderId))return;
 await env.DB.prepare("INSERT OR IGNORE INTO gym_delivery_emails(order_id,status,next_attempt_at) SELECT id,'queued',0 FROM orders WHERE id=? AND status='approved' AND provider='mercadopago' AND provider_payment_id IS NOT NULL")
  .bind(orderId).run();
}
export async function processDeliveryQueue(env){
 if(!env.DB||!configured(env))return {configured:false,processed:0};
 const now=Date.now();
 // Recover abandoned leases, then claim individual rows with conditional UPDATE.
 const rows=await env.DB.prepare("SELECT e.order_id FROM gym_delivery_emails e JOIN orders o ON o.id=e.order_id WHERE ((e.status IN ('queued','failed') AND e.next_attempt_at<=?) OR (e.status='sending' AND e.lease_until<?)) AND e.attempts<8 AND o.status='approved' ORDER BY e.created_at LIMIT 8").bind(now,now).all();
 let processed=0;
 for(const item of rows.results||[]){
  const claimed=await env.DB.prepare("UPDATE gym_delivery_emails SET status='sending',lease_until=?,attempts=attempts+1 WHERE order_id=? AND ((status IN ('queued','failed') AND next_attempt_at<=?) OR (status='sending' AND lease_until<?)) AND attempts<8").bind(now+120000,item.order_id,now,now).run();
  if(claimed.meta?.changes!==1)continue;
  try{
   const order=await env.DB.prepare("SELECT id,plan_id,product_type,customer_email FROM orders WHERE id=? AND status='approved' AND provider_payment_id IS NOT NULL").bind(item.order_id).first();
   if(!order)throw Error('not_approved');
   const providerId=await sendPurchase(env,order);
   await env.DB.prepare("UPDATE gym_delivery_emails SET status='sent',sent_at=?,lease_until=0,provider_message_id=?,last_error=NULL WHERE order_id=?")
    .bind(Date.now(),providerId,item.order_id).run();
   processed++;
  }catch(error){
   const row=await env.DB.prepare('SELECT attempts FROM gym_delivery_emails WHERE order_id=?').bind(item.order_id).first();
   const delay=Math.min(24*3600000,Math.pow(2,Math.min(10,Number(row?.attempts||1)))*60000);
   await env.DB.prepare("UPDATE gym_delivery_emails SET status='failed',lease_until=0,next_attempt_at=?,last_error=? WHERE order_id=?")
    .bind(Date.now()+delay,String(error?.message||'unknown').slice(0,100),item.order_id).run();
  }
 }
 return {configured:true,processed};
}
export async function syncPastPurchases(env){
 if(!env.DB)return;
 await env.DB.prepare("INSERT OR IGNORE INTO gym_delivery_emails(order_id,status,next_attempt_at) SELECT id,'queued',0 FROM orders WHERE provider='mercadopago' AND status='approved' AND provider_payment_id IS NOT NULL").run();
}
export async function recoverRequest(request,env,parseJson){
 if(!env.DB)return response({error:'Servicio temporalmente no disponible.'},503);
 if(!configured(env))return response({error:'La recuperación por correo está en preparación. Intentá nuevamente más adelante.'},503);
 const data=await parseJson(request),email=String(data?.email||'').trim().toLowerCase();
 if(email.length>140||!emailPattern.test(email))return response({error:'Ingresá un correo válido.'},400);
 const ip=request.headers.get('CF-Connecting-IP')||'unknown';
 const emailHash=await digest('recover-email:'+email),ipHash=await digest('recover-ip:'+ip);
 const since=Date.now()-15*60000;
 const [ec,ic]=await Promise.all([
  env.DB.prepare('SELECT COUNT(*) AS n FROM gym_recovery_requests WHERE email_hash=? AND created_at>?').bind(emailHash,since).first(),
  env.DB.prepare('SELECT COUNT(*) AS n FROM gym_recovery_requests WHERE ip_hash=? AND created_at>?').bind(ipHash,since).first()
 ]);
 if(Number(ec?.n||0)>=3||Number(ic?.n||0)>=8)return response({error:'Demasiadas solicitudes. Volvé a intentarlo en 15 minutos.'},429);
 await env.DB.prepare('INSERT INTO gym_recovery_requests(id,email_hash,ip_hash,created_at) VALUES(?,?,?,?)').bind(crypto.randomUUID(),emailHash,ipHash,Date.now()).run();
 const orders=await env.DB.prepare("SELECT id,plan_id,product_type,customer_email FROM orders WHERE customer_email=? AND status='approved' AND provider='mercadopago' AND provider_payment_id IS NOT NULL ORDER BY created_at DESC LIMIT 5").bind(email).all();
 // Generic response to prevent email/order enumeration.
 for(const order of orders.results||[]){
  try{await sendPurchase(env,order,'recover');}
  catch(error){console.error('GYM recovery email failed',error?.message||'unknown');}
 }
 return response({ok:true,message:'Si existe una compra aprobada con ese correo, recibirás el comprobante o un enlace para recuperar tu rutina.'});
}
export async function redeemRecovery(request,env,createGrant){
 if(!env.DB)return response({error:'Servicio temporalmente no disponible.'},503);
 const raw=new URL(request.url).searchParams.get('token')||'';
 if(!/^[A-Za-z0-9_-]{40,50}$/.test(raw))return response({error:'El enlace no es válido.'},403);
 const hash=await digest(raw);
 const row=await env.DB.prepare("SELECT o.id,o.plan_id,o.product_type,o.provider_payment_id FROM gym_delivery_links l JOIN orders o ON o.id=l.order_id WHERE l.token_hash=? AND l.expires_at>? AND o.status='approved' AND o.provider='mercadopago' AND o.provider_payment_id IS NOT NULL").bind(hash,Date.now()).first();
 if(!row)return response({error:'El enlace venció o el pago ya no está aprobado. Solicitá otro correo desde la página.'},403);
 if(row.product_type==='personalizado')return new Response(null,{status:303,headers:{location:site+'/#contacto','cache-control':'no-store','referrer-policy':'no-referrer'}});
 const grant=await createGrant(env,row);
 const [level,days]=row.plan_id.split('-');
 const url=site+'/?gym_download='+encodeURIComponent(grant)+'&gym_level='+encodeURIComponent(level)+'&gym_days='+encodeURIComponent(days)+'#confirmacion';
 return new Response(null,{status:303,headers:{location:url,'cache-control':'no-store','referrer-policy':'no-referrer'}});
}
export async function deliveryStatus(env){
 if(!env.DB)return response({error:'D1 no disponible'},503);
 const result=await env.DB.prepare("SELECT status,COUNT(*) AS total FROM gym_delivery_emails GROUP BY status").all();
 return response({configured:configured(env),fromConfigured:!!env.GYM_MAIL_FROM,counts:result.results||[]});
}
export async function cleanupDelivery(env){
 if(!env.DB)return;
 const limit=Date.now();
 await env.DB.batch([
  env.DB.prepare('DELETE FROM gym_delivery_links WHERE expires_at<?').bind(limit),
  env.DB.prepare('DELETE FROM gym_recovery_requests WHERE created_at<?').bind(limit-24*3600000)
 ]);
}
