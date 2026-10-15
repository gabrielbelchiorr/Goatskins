/* Boundary controls. No external service is contacted until local limits pass. */
const cfg = require('./config');
const { Erro, ipDe } = require('./http');
const { db, sha } = require('./db');
const { consumirLimite } = require('./registration');
const enabled = () => !!(cfg.TURNSTILE_SITE_KEY && cfg.TURNSTILE_SECRET_KEY);
function csrf(req, guarda) {
  if (req.method === 'GET' || req.method === 'HEAD' || guarda === 'webhook') return;
  const origin = req.headers.origin;
  if (req.headers['x-requested-with'] !== 'goatskins' || (origin && origin !== new URL(cfg.APP_URL).origin) || req.headers['sec-fetch-site'] === 'cross-site') throw new Erro('Requisição não permitida.', 403);
}
// Direciona apenas navegacao GET/HEAD do alias www para a origem canonica.
// Evita que o formulario carregue em www e tenha POST recusado pelo CSRF.
// Nao redireciona POST/webhooks, nem usa Host de forma aberta (open redirect).
function redirecionamentoWww(req, url) {
  if (!cfg.PRODUCAO || (req.method !== 'GET' && req.method !== 'HEAD')) return null;
  // API e health check nao podem ser redirecionados.
  if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') return null;
  const canonica = new URL(cfg.APP_URL);
  if (req.headers.host !== 'www.' + canonica.host) return null;
  return new URL(url.pathname + url.search, canonica).href;
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
    if (!d || typeof d !== "object" || Array.isArray(d) || typeof d.success !== "boolean") throw new Error("Resposta malformada do Turnstile");
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
module.exports={rotas,csrf,verificar,proteger,redirecionamentoWww};
