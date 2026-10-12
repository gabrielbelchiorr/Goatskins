/* Boundary controls. No external service is contacted until local limits pass. */
const cfg = require('./config');
const crypto = require('node:crypto');
const { Erro, ipDe } = require('./http');
const { db, sha } = require('./db');
const { consumirLimite } = require('./registration');
const enabled = () => !!(cfg.TURNSTILE_SITE_KEY && cfg.TURNSTILE_SECRET_KEY);
function origem(req, rota) {
  if (!cfg.ORIGIN_VERIFY_SECRET) return;
  // O monitor interno do Render precisa continuar verificando o banco.
  // Esta exceção não autoriza a API nem o webhook.
  if (rota === '/healthz' && ['GET','HEAD'].includes(req.method)) return;
  const recebido = req.headers['x-goatskins-origin'];
  if (typeof recebido !== 'string' || recebido.length !== cfg.ORIGIN_VERIFY_SECRET.length ||
      !/^[a-f0-9]{64}$/i.test(recebido) ||
      !crypto.timingSafeEqual(Buffer.from(recebido),Buffer.from(cfg.ORIGIN_VERIFY_SECRET))) {
    throw new Erro('Origem não autorizada.',403);
  }
}
function canonico(req, rota) {
  if (!cfg.PRODUCAO || !['GET','HEAD'].includes(req.method) ||
      !['/','/index.html','/termos.html','/privacidade.html','/cookies.html'].includes(rota)) return null;
  const alvo = new URL(cfg.APP_URL);
  let host = '';
  try { host = new URL('https://' + String(req.headers.host || '')).host; } catch (_) { /* redireciona para a origem fixa */ }
  if (host === alvo.host) return null;
  // Só a origem configurada decide o destino. Nunca usamos um host enviado pelo cliente.
  const url = req.urlObj || new URL(req.url,'http://localhost');
  return alvo.origin + url.pathname + url.search;
}
function csrf(req, guarda) {
  if (req.method === 'GET' || req.method === 'HEAD' || guarda === 'webhook') return;
  const origin = req.headers.origin;
  if (req.headers['x-requested-with'] !== 'goatskins' || (origin && origin !== new URL(cfg.APP_URL).origin) || req.headers['sec-fetch-site'] === 'cross-site') throw new Erro('Requisição não permitida.', 403);
}
async function verificar(token, action) {
  if (!enabled()) { if (cfg.PRODUCAO) throw new Erro('Verificação indisponível.',503); return; }
  if (typeof token !== 'string' || !token || token.length > 2048) {
    const e = new Erro('Conclua a verificação de segurança.',403); e.tipo = 'TURNSTILE_REQUIRED'; throw e;
  }
  let d;
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method:'POST',
      headers:{'Content-Type':'application/json'}, signal:AbortSignal.timeout(8000),
      body:JSON.stringify({secret:cfg.TURNSTILE_SECRET_KEY,response:token}) });
    if (!r.ok) throw new Error(); d = await r.json();
    if (!d || typeof d !== 'object' || Array.isArray(d) || typeof d.success !== 'boolean') throw new Error();
  } catch (_) { throw new Erro('Verificação indisponível. Tente novamente.',503); }
  // Nunca aceite o hostname informado pelo cliente. Confira somente os hosts configurados
  // no servidor: APP_URL (canônico) e aliases explícitos, sem curingas.
  const permitidos = new Set([new URL(cfg.APP_URL).hostname.toLowerCase(),
    ...String(cfg.TURNSTILE_HOSTNAMES || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)]);
  if (d.success !== true || typeof d.hostname !== 'string' || !permitidos.has(d.hostname.toLowerCase()) || d.action !== action) {
    const e = new Erro('Verificação inválida ou expirada. Tente novamente.',403); e.tipo='TURNSTILE_REQUIRED'; throw e;
  }
}
async function proteger(req, body, rota) {
  if (req.method !== 'POST') return;
  const actions = {'/api/registro':'registro','/api/esqueci-senha':'recuperacao','/api/login':'login'};
  const action = actions[rota]; if (!action) return;
  const ip = sha(String(ipDe(req)));
  // Atomic SQL limits persist across process restarts and instances; no global write lock needed.
  if (!cfg.TESTE) await consumirLimite('auth-ip:'+action+':'+ip, action==='login'?30:10, 600000);
  if (action === 'login') {
    const key = 'captcha-login:'+ip;
    const r = await db.get('SELECT n FROM auth_rate_limits WHERE chave=? AND expira>?',[key,Date.now()]);
    if (r && r.n >= 3) await verificar(body.turnstileToken,'login');
    if (!cfg.TESTE) await consumirLimite(key, 30, 600000);
  } else await verificar(body.turnstileToken,action);
}
const rotas = [['GET', /^\/api\/seguranca$/, async()=>({turnstileSiteKey:enabled()?cfg.TURNSTILE_SITE_KEY:null})]];
module.exports={rotas,csrf,verificar,proteger,origem,canonico};
