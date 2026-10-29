/* TOTP reaproveitado da implementação histórica (RFC6238 SHA1/6/30), sem exceções administrativas.
   Seed AES-256-GCM vinculada ao usuário; consumo e elevação atômicos; segredo nunca em logs/URLs HTTP. */
const crypto = require('node:crypto');
const cfg = require('./config');
const { db, tx, sha, audit, notificar } = require('./db');
const { Erro, cookie } = require('./http');
const { consumirLimite } = require('./registration');
const ADMIN = ['ADMIN','SUPER_ADMIN'], ELEVACAO_MS = 15 * 60000, SESSAO_MS = 8 * 3600000;
const sessionHash = ctx => sha(cookie(ctx.req, 'sid') || '');
const configurado = () => /^[a-f0-9]{64}$/i.test(cfg.MFA_ENCRYPTION_KEY || '');
function chave() {
  if (!configurado()) throw new Erro('A verificação administrativa está indisponível. Configure MFA_ENCRYPTION_KEY no servidor.', 503);
  return Buffer.from(cfg.MFA_ENCRYPTION_KEY, 'hex');
}
function exigirPapel(ctx) {
  if (!ctx.user || !ADMIN.includes(ctx.user.role)) throw new Erro('Acesso negado.', 403);
  chave();
}
const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(buffer) {
  let bits=0, value=0, out='';
  for (const byte of buffer) {
    value=(value<<8)|byte; bits+=8;
    while(bits>=5) {out+=abc[(value>>>(bits-5))&31]; bits-=5;}
  }
  if(bits)out+=abc[(value<<(5-bits))&31];
  return out;
}
function decode(secret) {
  if(typeof secret!=='string'||!secret||!/^[A-Z2-7]+$/.test(secret))throw new Error('MFA_SECRET_INVALIDO');
  let bits=0,value=0;const bytes=[];
  for(const char of secret) {value=(value<<5)|abc.indexOf(char);bits+=5;if(bits>=8){bytes.push((value>>>(bits-8))&255);bits-=8;}}
  return Buffer.from(bytes);
}
function totp(secret, step, digits=6) {
  if(!Number.isSafeInteger(step)||step<0||![6,8].includes(digits))throw new Error('MFA_PASSO_INVALIDO');
  const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(step));
  const h=crypto.createHmac('sha1',decode(secret)).update(counter).digest(), offset=h[19]&15;
  return String((h.readUInt32BE(offset)&0x7fffffff) % 10**digits).padStart(digits,'0');
}
function check(secret, code, last=-1, now=Date.now()) {
  if(typeof code!=='string'||!/^\d{6}$/.test(code))return -1;
  const step=Math.floor(now/30000);
  // Monotônico por conta, não por sessão: o mesmo TOTP não eleva dois navegadores.
  for(const candidate of [step,step-1,step+1])
    if(candidate>=0&&candidate>last&&crypto.timingSafeEqual(Buffer.from(totp(secret,candidate)),Buffer.from(code)))return candidate;
  return -1;
}
const aad = uid => Buffer.from('GOATSKINS:admin-mfa:v1:' + uid);
function encrypt(secret, uid) {
  const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',chave(),iv);
  cipher.setAAD(aad(uid));
  const ciphertext=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);
  return ['v1',iv.toString('base64'),cipher.getAuthTag().toString('base64'),ciphertext.toString('base64')].join('.');
}
function decrypt(value, uid) {
  const parts=typeof value==='string'?value.split('.'):[];
  if(parts.length!==4||parts[0]!=='v1')throw new Error('MFA_CIFRA_INVALIDA');
  const [iv,tag,body]=parts.slice(1).map(s=>Buffer.from(s,'base64'));
  if(iv.length!==12||tag.length!==16||body.length!==32)throw new Error('MFA_CIFRA_INVALIDA');
  const cipher=crypto.createDecipheriv('aes-256-gcm',chave(),iv);cipher.setAAD(aad(uid));cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(body),cipher.final()]).toString('utf8');
}
const atual = ctx => db.get(`SELECT u.id,u.email,u.hash,u.role,s.expira,s.mfa_until,s.mfa_role
  FROM sessions s JOIN users u ON u.id=s.user_id
  WHERE s.token=? AND s.user_id=? AND s.expira>? AND u.status='ACTIVE' AND u.email_verificado=1`,
  [sessionHash(ctx),ctx.user.id,Date.now()]);
async function vivo(ctx, esperado) {
  const u=await atual(ctx);
  if(!u||!ADMIN.includes(u.role)||u.role!==ctx.user.role||
    (esperado&&(u.hash!==esperado.hash||u.role!==esperado.role)))throw new Erro('Entre novamente para confirmar sua identidade.',401);
  return u;
}
async function exigir(ctx) {
  exigirPapel(ctx);
  const u=await vivo(ctx), m=await db.get('SELECT enabled FROM admin_mfa WHERE user_id=?',[u.id]);
  if(!m||m.enabled!==1||u.mfa_role!==u.role||!(u.mfa_until>Date.now())) {
    const error=new Erro('Confirme sua identidade com o autenticador para acessar a administração.',403);
    error.tipo='MFA_REQUIRED';throw error;
  }
}
async function senha(ctx) {
  exigirPapel(ctx);
  // Fora da tx de verificação: erros não apagam as tentativas. Nunca desativados por TESTE.
  await tx(async()=>{
    await consumirLimite('mfa-account:'+ctx.user.id,8,600000);
    await consumirLimite('mfa-ip:'+sha(String(ctx.ip)),40,600000);
  });
  const u=await vivo(ctx);
  if(typeof ctx.body.senha!=='string'||!await require('./auth').confere(ctx.body.senha,u.hash)) {
    await audit(u.id,'MFA_FALHA',null,ctx.ip);throw new Erro('Senha ou código inválido.',401);
  }
  return u;
}
const recoveryDigest = (uid,code) => sha('GOATSKINS:mfa-recovery:v1:'+uid+':'+code);
function recoveryCode(code) {
  if(typeof code!=='string')return null;
  const text=code.trim().toLowerCase();
  return /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{8}){3})$/.test(text)?text.replace(/-/g,''):null;
}
function hashesDe(value) {
  const hashes=JSON.parse(value);
  if(!Array.isArray(hashes)||hashes.length>8||hashes.some(h=>typeof h!=='string'||!/^[a-f0-9]{64}$/.test(h)))throw new Error('MFA_RECUPERACAO_INVALIDA');
  return hashes;
}
const rotas=[
  ['GET',/^\/api\/mfa\/status$/,async ctx=>{
    exigirPapel(ctx);const u=await vivo(ctx), m=await db.get('SELECT enabled,recovery_hashes FROM admin_mfa WHERE user_id=?',[u.id]);
    return {required:true,enabled:!!(m&&m.enabled===1),verified:!!(m&&m.enabled===1&&u.mfa_role===u.role&&u.mfa_until>Date.now()),
      remainingRecoveryCodes:m&&m.enabled===1?hashesDe(m.recovery_hashes).length:0};
  },'user'],
  ['POST',/^\/api\/mfa\/preparar$/,async ctx=>{
    const esperado=await senha(ctx),secret=base32(crypto.randomBytes(20));
    const uri='otpauth://totp/'+encodeURIComponent('GOATSKINS:'+esperado.email)+'?secret='+secret+'&issuer=GOATSKINS&algorithm=SHA1&digits=6&period=30';
    const qr=require('qrcode-generator')(0,'M');qr.addData(uri,'Byte');qr.make();
    const qrCode=qr.createDataURL(4,16);
    await tx(async()=>{
      const u=await vivo(ctx,esperado);
      const m=await db.get('SELECT enabled FROM admin_mfa WHERE user_id=? FOR UPDATE',[u.id]);
      if(m&&m.enabled===1)throw new Erro('Autenticador já configurado. Use o código do aplicativo ou de recuperação.',409);
      await db.run(`INSERT INTO admin_mfa(user_id,secret,pending_session,pending_expira) VALUES(?,?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET secret=excluded.secret,pending_session=excluded.pending_session,
        pending_expira=excluded.pending_expira,last_step=-1,recovery_hashes='[]' WHERE admin_mfa.enabled=0`,
        [u.id,encrypt(secret,u.id),sessionHash(ctx),Date.now()+600000]);
      await audit(u.id,'MFA_PREPARADO',null,ctx.ip);
    });
    return {secret,uri,qrCode};
  },'user'],
  ['POST',/^\/api\/mfa\/verificar$/,async ctx=>{
    const esperado=await senha(ctx),fresh=crypto.randomBytes(32).toString('hex');
    const result=await tx(async()=>{
      const u=await vivo(ctx,esperado),m=await db.get('SELECT * FROM admin_mfa WHERE user_id=? FOR UPDATE',[u.id]);
      if(!m||(!m.enabled&&(m.pending_session!==sessionHash(ctx)||m.pending_expira<=Date.now())))
        throw new Erro('A configuração expirou ou pertence a outra sessão. Configure o autenticador novamente.',400);
      const code=typeof ctx.body.codigo==='string'?ctx.body.codigo.trim():'';
      const step=/^\d{6}$/.test(code)?check(decrypt(m.secret,u.id),code,Number(m.last_step)):-1;
      const hashes=hashesDe(m.recovery_hashes),recovery=m.enabled===1?recoveryCode(code):null;
      const digest=recovery?recoveryDigest(u.id,recovery):null;
      const used=digest?hashes.find(h=>crypto.timingSafeEqual(Buffer.from(h,'hex'),Buffer.from(digest,'hex'))):null;
      if(step<0&&!used)return {invalid:true,uid:u.id};
      const codes=!m.enabled?Array.from({length:8},()=>crypto.randomBytes(16).toString('hex')):null;
      await db.run(`UPDATE admin_mfa SET enabled=1,last_step=?,pending_session=NULL,pending_expira=0,recovery_hashes=? WHERE user_id=?`,
        [step>=0?step:m.last_step,JSON.stringify(codes?codes.map(c=>recoveryDigest(u.id,c)):hashes.filter(h=>h!==used)),u.id]);
      if(codes||used)await db.run('DELETE FROM sessions WHERE user_id=? AND token<>?',[u.id,sessionHash(ctx)]);
      const now=Date.now(),expira=Math.min(u.expira,now+SESSAO_MS);
      if(!(await db.run(`UPDATE sessions SET token=?,mfa_until=?,mfa_role=?,expira=?
        WHERE token=? AND user_id=? AND expira>?`,[sha(fresh),Math.min(expira,now+ELEVACAO_MS),u.role,expira,sessionHash(ctx),u.id,now])).changes)
        throw new Erro('Entre novamente.',401);
      await audit(u.id,codes?'MFA_ATIVADO':used?'MFA_RECUPERACAO_USADA':'MFA_VERIFICADO',null,ctx.ip);
      if(codes||used)await notificar(u.id,codes?'Autenticador ativado':'Código de recuperação usado',
        codes?'A autenticação em dois fatores protege sua administração. Guarde os códigos de recuperação.':'Um código de recuperação foi utilizado. As outras sessões foram encerradas.');
      return {expira,...(codes?{recoveryCodes:codes.map(c=>c.match(/.{8}/g).join('-'))}:{})};
    });
    if(result.invalid){await audit(result.uid,'MFA_FALHA',null,ctx.ip);throw new Erro('Senha ou código inválido, expirado ou já utilizado.',401);}
    // Somente após COMMIT: falha na auditoria/consumo nunca deixa cookie de sessão elevada no cliente.
    const secure=cfg.PRODUCAO||ctx.req.headers['x-forwarded-proto']==='https';
    ctx.res.setHeader('Set-Cookie','sid='+fresh+'; HttpOnly; SameSite=Lax; Path=/; Max-Age='+Math.max(1,Math.floor((result.expira-Date.now())/1000))+(secure?'; Secure':''));
    return {ok:true,...(result.recoveryCodes?{recoveryCodes:result.recoveryCodes}:{})};
  },'user']
];
module.exports={rotas,exigir,totp,check,base32,encrypt,decrypt};
