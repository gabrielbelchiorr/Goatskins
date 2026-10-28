/* QA local das interfaces de conta. Requer Playwright e Chrome já instalados.
   APIs simuladas, sem banco, envio de e-mail/SMS ou acesso a provedores externos. */
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../public');
const output = path.resolve(__dirname, '../validation/auth-redesign');
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = path.resolve(root, pathname === '/' ? 'index.html' : '.' + pathname);
  if (!file.startsWith(root + path.sep)) { res.writeHead(404); return res.end(); }
  fs.readFile(file, (err, data) => {
    res.writeHead(err ? 404 : 200, {'Content-Type': ({'.html':'text/html; charset=utf-8', '.js':'application/javascript', '.css':'text/css', '.webp':'image/webp', '.jpg':'image/jpeg'})[path.extname(file)] || 'application/octet-stream'});
    res.end(err ? '' : data);
  });
});

(async () => {
  fs.mkdirSync(output, {recursive:true});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({channel:'chrome', headless:true});
  try {
    for (const width of [1440, 768, 390, 320]) {
      const ctx = await browser.newContext({viewport:{width, height:width===320?667:width===390?844:900}, reducedMotion:'reduce'});
      const page = await ctx.newPage(), errors = [], calls = [], external = []; page.setDefaultTimeout(10000);
      let logged = false, pendingLogin = false, wrongPassword = false, badCode = false, phoneFilled = true;
      let turnstile = false;
      const user = {id:1, nome:'Jogador GOAT', email:'jogador@example.com', role:'USER', email_verificado:1, celular_preenchido:true};
      const pending = () => ({pendente:true, token:'a'.repeat(64), expira_em:Date.now()+600000, cadastro_expira_em:Date.now()+1800000, reenviar_em:Date.now()+1500, mensagem:'Use o código mais recente recebido por e-mail.'});
      page.on('pageerror', e => errors.push(e.message));
      await ctx.addInitScript(() => {
        // Simula apenas o widget, para verificar a composição com o desafio nativo.
        window.turnstile = {render(box, op) { const b=document.createElement('button'); b.textContent='Concluir desafio de teste'; b.onclick=()=>op.callback('token-local'); box.append(b); return 1; }, remove(){}, reset(){}};
      });
      await ctx.route('**/*', async route => {
        const req = route.request(), url = new URL(req.url());
        if (url.origin !== base) { external.push(url.origin); return route.abort(); }
        if (!url.pathname.startsWith('/api/')) return route.continue();
        const body = req.postDataJSON();
        calls.push({url:url.pathname, method:req.method(), body, headers:req.headers()});
        let json = {ok:true}, status = 200;
        switch (url.pathname) {
          case '/api/estado': json = {eu:logged ? {...user, celular_preenchido:phoneFilled} : null, naoLidas:0, s:{titulo:'GOATSKINS SORTEIOS', sub:'Escolha seus números e concorra a skins de CS.', cores:{gold:'#e4b45b',copper:'#ae702e',slate:'#102440',navy:'#0c192e'}}, c:[]}; break;
          case '/api/pedidos/pendente': json = null; break;
          case '/api/login':
            await new Promise(r => setTimeout(r, 180));
            if (turnstile && !body.turnstileToken) { status=403; json={tipo:'TURNSTILE_REQUIRED'}; }
            else if (wrongPassword) { status=401; json={erro:'E-mail ou senha incorretos.'}; }
            else if (pendingLogin) json=pending();
            else logged=true;
            break;
          case '/api/registro': json = pending(); break;
          case '/api/confirmar-cadastro': if (badCode) { status=400; json={erro:'Código incorreto ou expirado.'}; } break;
          case '/api/reenviar-verificacao': json=pending(); break;
          case '/api/conta': if (req.method()==='PUT') user.nome=body.nome; json={...user, celular:'+5511999999999'}; break;
          case '/api/notificacoes': json=[{titulo:'Conta protegida', texto:'Sua senha foi alterada.', criado_em:new Date().toISOString(), lida:1}]; break;
          case '/api/conta/excluir': logged=false; break;
          case '/api/celular':
            if (req.method()==='POST') phoneFilled=true;
            json={ok:true, preenchido:phoneFilled, celular:phoneFilled?'+5511999999999':null}; break;
          case '/api/seguranca': json={turnstileSiteKey:'site-local'}; break;
          case '/api/logout': logged=false; break;
        }
        await route.fulfill({status, json});
      });
      const shot = name => page.screenshot({path:path.join(output, `${width}-${name}.png`)});
      const heading = name => page.getByRole('heading', {name, exact:true}).waitFor();
      const ready = async () => { await page.waitForFunction(() => !document.documentElement.classList.contains('page-loading')); };
      const openLogin = async () => {
        if (await page.locator('#loginBtn').evaluate(el => !!el.closest('[inert]'))) await page.locator('#closeBtn').click();
        if (await page.locator('#menuBtn').getAttribute('aria-expanded') === 'false') await page.locator('#menuBtn').click();
        await page.locator('#loginBtn').click(); await heading('Entrar');
      };
      const loginFields = async () => {
        await page.getByLabel('E-mail', {exact:true}).fill('jogador@example.com');
        await page.getByLabel('Senha', {exact:true}).fill('Teste1234');
      };
      const layout = async () => {
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow da página em ${width}`);
        assert(await page.locator('.dialog').evaluate(el => el.scrollWidth <= el.clientWidth+1), `overflow do modal em ${width}`);
        assert.equal(await page.locator('.dialog').getAttribute('aria-labelledby'), 'modalTitle');
        assert(await page.locator('.shell').evaluate(el => el.inert));
      };
      await page.goto(base); await ready(); await page.locator('.cookie-actions button').nth(1).click();
      await openLogin(); await layout(); await shot('login');
      assert(await page.locator('#modalTitle').evaluate(el => el === document.activeElement));
      await page.keyboard.press('Shift+Tab'); assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Privacidade');
      await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.activeElement.id), 'closeBtn');
      await page.keyboard.press('Escape'); assert(await page.locator('#modal').isHidden());
      assert(await page.locator('#loginBtn').evaluate(el => el === document.activeElement));
      await openLogin();
      await page.getByRole('button',{name:'Entrar',exact:true}).click();
      assert.equal(calls.filter(c => c.url==='/api/login').length, 0);
      assert.equal(await page.getByLabel('E-mail',{exact:true}).getAttribute('aria-invalid'), 'true');
      await page.getByLabel('E-mail',{exact:true}).fill('invalido'); await page.getByLabel('Senha',{exact:true}).fill('Teste1234');
      await page.getByRole('button',{name:'Entrar',exact:true}).click(); assert.equal(calls.filter(c => c.url==='/api/login').length, 0);
      await loginFields();
      await page.getByRole('button',{name:'Mostrar senha: Senha',exact:true}).click();
      assert.equal(await page.getByLabel('Senha',{exact:true}).getAttribute('type'), 'text');
      await page.getByRole('button',{name:'Ocultar senha: Senha',exact:true}).click();
      wrongPassword=true;
      await page.getByLabel('Senha',{exact:true}).press('Enter');
      await page.getByRole('button',{name:'Entrando...',exact:true}).waitFor();
      await page.getByLabel('Senha',{exact:true}).press('Enter');
      await page.getByRole('alert').filter({hasText:'E-mail ou senha incorretos.'}).waitFor();
      assert.equal(calls.filter(c => c.url==='/api/login').length,1); await shot('login-erro'); wrongPassword=false;
      await page.getByRole('button',{name:'Esqueci minha senha',exact:true}).click(); await heading('Recuperar senha');
      await page.getByLabel('E-mail',{exact:true}).fill('jogador@example.com'); await shot('recuperar');
      await page.getByLabel('E-mail',{exact:true}).press('Enter'); await heading('Confira seu e-mail'); await shot('recuperar-sucesso');
      await page.getByRole('button',{name:'Voltar para entrar',exact:true}).click();
      await page.getByRole('button',{name:'Criar conta',exact:true}).click(); await heading('Criar conta'); await layout(); await shot('cadastro');
      await page.getByLabel('Nome completo').fill('Jogador GOAT'); await page.getByLabel('E-mail',{exact:true}).fill('jogador@example.com');
      await page.getByLabel('Celular com DDD').fill('11999999999'); assert.equal(await page.getByLabel('Celular com DDD').inputValue(), '(11) 99999-9999');
      await page.getByLabel('Senha',{exact:true}).fill('curta');
      await page.getByRole('button',{name:'Criar conta',exact:true}).click(); assert.equal(calls.filter(c=>c.url==='/api/registro').length,0);
      await page.getByLabel('Senha',{exact:true}).fill('Teste1234');
      await page.getByRole('button',{name:'Criar conta',exact:true}).click(); assert.equal(calls.filter(c=>c.url==='/api/registro').length,0);
      await page.getByLabel('Tenho 18 anos ou mais.').check(); await page.getByLabel(/Li e aceito/).check();
      await page.getByRole('button',{name:'Criar conta',exact:true}).click(); await heading('Confirme seu e-mail'); await layout(); await shot('verificacao');
      assert.deepEqual(calls.find(c=>c.url==='/api/registro').body,{nome:'Jogador GOAT',email:'jogador@example.com',telefone:'(11) 99999-9999',senha:'Teste1234',maior18:true,consentimento:true});
      await page.getByLabel('Código de 6 dígitos').fill('12ab34'); assert.equal(await page.getByLabel('Código de 6 dígitos').inputValue(),'1234');
      await page.getByRole('button',{name:'Confirmar e-mail',exact:true}).click(); assert.equal(calls.filter(c=>c.url==='/api/confirmar-cadastro').length,0);
      await page.getByLabel('Código de 6 dígitos').fill('123456'); badCode=true;
      await page.getByRole('button',{name:'Confirmar e-mail',exact:true}).click(); await page.getByRole('alert').filter({hasText:'Código incorreto ou expirado.'}).waitFor(); await shot('verificacao-erro');
      await page.getByRole('button',{name:'Reenviar código',exact:true}).waitFor(); await page.getByRole('button',{name:'Reenviar código',exact:true}).click();
      await page.getByRole('status').filter({hasText:'Solicitação processada.'}).waitFor(); assert.equal(await page.getByLabel('Código de 6 dígitos').inputValue(),'');
      await page.reload(); await heading('Confirme seu e-mail');
      await page.getByRole('button',{name:'Corrigir e-mail / reiniciar',exact:true}).click(); await heading('Criar conta');
      assert.equal(await page.getByLabel('E-mail',{exact:true}).inputValue(),'jogador@example.com');
      await page.getByRole('button',{name:'Voltar para entrar',exact:true}).click(); await loginFields(); pendingLogin=true; badCode=false;
      await page.getByRole('button',{name:'Entrar',exact:true}).click(); await heading('Confirme seu e-mail');
      await page.getByLabel('Código de 6 dígitos').fill('123456'); await page.getByLabel('Código de 6 dígitos').press('Enter');
      await heading('E-mail confirmado!'); await shot('verificacao-sucesso');
      assert.equal(await page.evaluate(()=>sessionStorage.getItem('goatskins-confirmacao')),null); pendingLogin=false;
      await page.getByRole('button',{name:'Entrar',exact:true}).click(); await loginFields(); turnstile=true;
      await page.getByRole('button',{name:'Entrar',exact:true}).click(); await page.getByRole('dialog',{name:'Verificação de segurança',exact:true}).waitFor();
      await page.keyboard.press('Escape'); assert(await page.getByRole('dialog',{name:'Verificação de segurança',exact:true}).isVisible());
      await page.getByRole('button',{name:'Fechar verificação de segurança',exact:true}).click();
      await page.getByRole('alert').filter({hasText:'Verificação cancelada.'}).waitFor();
      await page.getByRole('button',{name:'Entrar',exact:true}).click();
      await heading('Verificação de segurança'); await shot('turnstile');
      await page.getByRole('button',{name:'Concluir desafio de teste'}).click();
      await page.locator('#modal').waitFor({state:'hidden'}); assert(calls.some(c=>c.url==='/api/login'&&c.body.turnstileToken==='token-local'));
      if (await page.locator('#menuBtn').getAttribute('aria-expanded') === 'false') await page.locator('#menuBtn').click();
      await page.locator('#contaBtn').click(); await heading('Minha conta'); await layout(); await shot('conta');
      await page.getByLabel('Nome',{exact:true}).fill('Jogador Atualizado'); await page.getByRole('button',{name:'Salvar dados',exact:true}).click();
      await page.getByRole('status').filter({hasText:'Dados atualizados com sucesso.'}).waitFor();
      assert.equal(await page.locator('.account-identity strong').textContent(),'Jogador Atualizado');
      assert.deepEqual(calls.find(c=>c.url==='/api/conta'&&c.method==='PUT').body,{nome:'Jogador Atualizado',telefone:'(11) 99999-9999'});
      await page.getByLabel('Senha atual',{exact:true}).fill('Teste1234'); await page.locator('input').and(page.getByLabel('Nova senha',{exact:true})).fill('Nova1234');
      await page.locator('input').and(page.getByLabel('Nova senha',{exact:true})).press('Enter');
      await page.getByRole('status').filter({hasText:'Senha alterada!'}).waitFor(); assert.equal(await page.locator('input').and(page.getByLabel('Nova senha',{exact:true})).inputValue(),'');
      await page.getByText('Excluir minha conta (LGPD)',{exact:true}).click(); await page.getByLabel('Senha para confirmar a exclusão',{exact:true}).fill('Nova1234');
      page.once('dialog', d=>d.dismiss()); await page.getByRole('button',{name:'Excluir minha conta',exact:true}).click();
      assert(!calls.some(c=>c.url==='/api/conta/excluir'));
      page.once('dialog', d=>d.accept()); await page.getByRole('button',{name:'Excluir minha conta',exact:true}).click(); await heading('Conta excluída');
      await page.getByRole('button',{name:'Voltar aos sorteios',exact:true}).click();
      phoneFilled=false; logged=true; await page.reload(); await heading('Concluir cadastro'); await shot('celular');
      await page.getByLabel('Celular com DDD').fill('11999999999'); await page.getByLabel('Celular com DDD').press('Enter'); await page.locator('#modal').waitFor({state:'hidden'});
      assert(!calls.some(c=>/celular\/(enviar|confirmar|corrigir)|\/mfa\//.test(c.url)));
      logged=false; const token='f'.repeat(64); await page.goto('about:blank'); await page.goto(base+'/#redefinir='+token); await heading('Nova senha'); await shot('redefinir');
      assert.equal(new URL(page.url()).hash,''); await page.locator('input').and(page.getByLabel('Nova senha',{exact:true})).fill('Nova1234');
      await page.locator('input').and(page.getByLabel('Nova senha',{exact:true})).press('Enter'); await heading('Senha alterada');
      assert.deepEqual(calls.find(c=>c.url==='/api/redefinir-senha').body,{token,senha:'Nova1234'});
      await page.evaluate(p => sessionStorage.setItem('goatskins-confirmacao', JSON.stringify(p)), {...pending(),email:user.email,modo:'criar',expira_em:Date.now()-1000,reenviar_em:Date.now()-1000});
      await page.reload(); await heading('Confirme seu e-mail');
      assert(await page.getByRole('button',{name:'Confirmar e-mail',exact:true}).isDisabled());
      assert(await page.getByRole('button',{name:'Reenviar código',exact:true}).isEnabled()); await shot('codigo-expirado');
      await page.evaluate(p => sessionStorage.setItem('goatskins-confirmacao', JSON.stringify(p)), {...pending(),email:user.email,modo:'criar',cadastro_expira_em:Date.now()-1000});
      await page.reload(); await heading('Criar conta'); assert.equal(await page.evaluate(()=>sessionStorage.getItem('goatskins-confirmacao')),null);
      for (const call of calls.filter(c=>c.method!=='GET')) assert.equal(call.headers['x-requested-with'],'goatskins');
      assert.deepEqual(external,[]); assert.deepEqual(errors,[]);
      console.log(`PASS ${width}px: login, cadastro, validação, Enter, foco, erros, reenvio, expiração, confirmação, Turnstile simulado (conclusão/cancelamento), conta, exclusão, celular, redefinição e contratos HTTP.`);
      await ctx.close();
    }
  } finally { await browser.close(); await new Promise(r=>server.close(r)); }
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
