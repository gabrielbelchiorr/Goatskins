/* TOTP (RFC 6238, SHA-1/6 digits/30 seconds). Secrets encrypted with AES-256-GCM.
   A password-only session cannot call any administrative route. */
const crypto = require('node:crypto'), cfg = require('./config');
const {db,tx,sha,audit}=require('./db');
const {Erro,cookie}=require('./http');
const {consumirLimite}=require('./registration');
const active=()=>!!cfg.MFA_ENCRYPTION_KEY;
const sid=ctx=>sha(cookie(ctx.req,'sid')||'');
function exigir(u) { if ((cfg.PRODUCAO || active()) && (!u || !(u.mfa_until > Date.now()))) {const e=new Erro('Confirme sua identidade com o autenticador para acessar a administração.',403);e.tipo='MFA_REQUIRED';throw e;} }
function papel(ctx) { if(!['ADMIN','SUPER_ADMIN'].includes(ctx.user.role))throw new Erro('Acesso negado.',403);if(!active())throw new Erro('Configure MFA_ENCRYPTION_KEY no servidor.',503); }
function encrypt(secret) { const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',Buffer.from(cfg.MFA_ENCRYPTION_KEY,'hex'),iv);const b=Buffer.concat([c.update(secret,'utf8'),c.final()]);return [iv,c.getAuthTag(),b].map(x=>x.toString('base64')).join('.'); }
function decrypt(s) { const [iv,tag,b]=s.split('.').map(x=>Buffer.from(x,'base64')),c=crypto.createDecipheriv('aes-256-gcm',Buffer.from(cfg.MFA_ENCRYPTION_KEY,'hex'),iv);c.setAuthTag(tag);return Buffer.concat([c.update(b),c.final()]).toString('utf8'); }
const abc='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(b) { let bits=0,v=0,out='';for(const x of b){v=(v<<8)|x;bits+=8;while(bits>=5){out+=abc[(v>>>(bits-5))&31];bits-=5;}}if(bits)out+=abc[(v<<(5-bits))&31];return out; }
function decode(s) {let bits=0,v=0,b=[];for(const x of s){v=(v<<5)|abc.indexOf(x);bits+=5;if(bits>=8){b.push((v>>>(bits-8))&255);bits-=8;}}return Buffer.from(b);}
function totp(secret,step) {const b=Buffer.alloc(8);b.writeBigUInt64BE(BigInt(step));const h=crypto.createHmac('sha1',decode(secret)).update(b).digest(),i=h[19]&15;return String((h.readUInt32BE(i)&0x7fffffff)%1000000).padStart(6,'0');}
function check(secret,code,last=-1,now=Date.now()) {if(typeof code!=='string'||!/^\d{6}$/.test(code))return -1;const step=Math.floor(now/30000);for(const t of [step,step-1,step+1])if(t>last&&crypto.timingSafeEqual(Buffer.from(totp(secret,t)),Buffer.from(code)))return t;return -1;}
async function senha(ctx) {papel(ctx);await consumirLimite('mfa:'+ctx.user.id,10,600000);const u=await db.get('SELECT hash FROM users WHERE id=?',[ctx.user.id]);if(!await require('./auth').confere(ctx.body.senha,u.hash))throw new Erro('Credenciais inválidas.',401);return u.hash;}
async function liberar(ctx) {
 const old=sid(ctx),fresh=crypto.randomBytes(32).toString('hex');
 // Rotate the session after privilege elevation; old bearer token is never elevated.
 const r=await db.run('UPDATE sessions SET token=?,mfa_until=? WHERE token=? AND user_id=? AND expira>?',[sha(fresh),Date.now()+15*60000,old,ctx.user.id,Date.now()]);
 if(!r.changes)throw new Erro('Entre novamente.',401);
 ctx.res.setHeader('Set-Cookie','sid='+fresh+'; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800'+(cfg.PRODUCAO?'; Secure':''));
 await db.run('UPDATE sessions SET expira=LEAST(expira,?) WHERE token=?',[Date.now()+8*3600000,sha(fresh)]);
 await audit(ctx.user.id,'MFA_VERIFICADO',null,ctx.ip);
}
const rotas=[
 ['GET',/^\/api\/mfa\/status$/,async ctx=>{papel(ctx);const m=await db.get('SELECT enabled FROM admin_mfa WHERE user_id=?',[ctx.user.id]);return {enabled:!!(m&&m.enabled),verified:ctx.user.mfa_until>Date.now()};},'user'],
 ['POST',/^\/api\/mfa\/preparar$/,async ctx=>{
  const hash=await senha(ctx),secret=base32(crypto.randomBytes(20));
  await tx(async()=>{
   const u=await db.get('SELECT hash FROM users WHERE id=?',[ctx.user.id]);if(u.hash!==hash)throw new Erro('Entre novamente.',401);
   const m=await db.get('SELECT enabled FROM admin_mfa WHERE user_id=?',[ctx.user.id]);if(m&&m.enabled)throw new Erro('Autenticador já configurado.',409);
   await db.run(`INSERT INTO admin_mfa(user_id,secret,pending_session,pending_expira) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET secret=excluded.secret,pending_session=excluded.pending_session,pending_expira=excluded.pending_expira WHERE admin_mfa.enabled=0`,[ctx.user.id,encrypt(secret),sid(ctx),Date.now()+600000]);
  });
  return {secret,uri:'otpauth://totp/'+encodeURIComponent('GOATSKINS:'+ctx.user.email)+'?secret='+secret+'&issuer=GOATSKINS&algorithm=SHA1&digits=6&period=30'};
 },'user'],
 ['POST',/^\/api\/mfa\/verificar$/,async ctx=>{
  const hash=await senha(ctx);
  return tx(async()=>{
   const u=await db.get('SELECT hash FROM users WHERE id=?',[ctx.user.id]);if(u.hash!==hash)throw new Erro('Entre novamente.',401);
   const m=await db.get('SELECT * FROM admin_mfa WHERE user_id=? FOR UPDATE',[ctx.user.id]);
   if(!m||(!m.enabled&&(m.pending_session!==sid(ctx)||m.pending_expira<Date.now())))throw new Erro('Configure novamente o autenticador.',400);
   const code=String(ctx.body.codigo||'').trim(),step=check(decrypt(m.secret),code,Number(m.last_step));
   const hashes=JSON.parse(m.recovery_hashes);const recovery=m.enabled&&/^[a-f0-9]{16}$/.test(code)&&hashes.includes(sha(code));
   if(step<0&&!recovery)throw new Erro('Código inválido ou já utilizado.',401);
   const codes=m.enabled?null:Array.from({length:8},()=>crypto.randomBytes(8).toString('hex'));
   await db.run('UPDATE admin_mfa SET enabled=1,last_step=?,pending_session=NULL,pending_expira=0,recovery_hashes=? WHERE user_id=?',[step>=0?step:m.last_step,JSON.stringify(codes?codes.map(sha):hashes.filter(h=>!recovery||h!==sha(code))),ctx.user.id]);
   if(codes||recovery)await db.run('DELETE FROM sessions WHERE user_id=? AND token<>?',[ctx.user.id,sid(ctx)]);
   await liberar(ctx);
   return {ok:true,...(codes?{recoveryCodes:codes}:{})};
  });
 },'user']
];
module.exports={rotas,exigir,totp,check,base32,encrypt,decrypt};
