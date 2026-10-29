/* QA local de MFA. API simulada, sem credenciais, banco ou provedores reais.
   Requer Playwright disponível em NODE_PATH e Chrome instalado. */
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const qrcode = require('qrcode-generator');
const root = path.resolve(__dirname, '../public');
const output = path.resolve(__dirname, '../validation/mfa-ui');
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = path.resolve(root, pathname === '/' ? 'index.html' : '.' + pathname);
  if (!file.startsWith(root + path.sep)) { res.writeHead(404); return res.end(); }
  fs.readFile(file, (err, data) => {
    res.writeHead(err ? 404 : 200, {'Content-Type': ({'.html':'text/html; charset=utf-8', '.js':'application/javascript', '.css':'text/css', '.webp':'image/webp'})[path.extname(file)] || 'application/octet-stream'});
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
      const ctx = await browser.newContext({viewport:{width, height:width===320?667:width===390?844:900}, reducedMotion:'reduce', acceptDownloads:true});
      const page = await ctx.newPage(), errors = [], calls = [], external = [];
      page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
      let logged = false, enabled = false, verified = false, rejectPassword = true, rejectCode = true, expireRequest = false, unavailable = false;
      const secret = 'JBSWY3DPEHPK3PXP';
      const codes = Array.from({length:8}, (_,i) => (i+1).toString(16).repeat(32).match(/.{8}/g).join('-'));
      const uri = 'otpauth://totp/GOATSKINS:admin%40example.test?secret='+secret+'&issuer=GOATSKINS&algorithm=SHA1&digits=6&period=30';
      // Mesmo gerador/formato do backend, com uma conta e uma chave exclusivamente fictícias.
      const qr = qrcode(0,'M'); qr.addData(uri,'Byte'); qr.make(); const qrCode=qr.createDataURL(4,16);
      const admin = {id:1, nome:'Administrador local', email:'admin@example.test', role:'ADMIN', email_verificado:1, celular_preenchido:true};
      await ctx.route('**/*', async route => {
        const req = route.request(), url = new URL(req.url());
        if (url.origin !== base) { external.push(url.origin); return route.abort(); }
        if (!url.pathname.startsWith('/api/')) return route.continue();
        const body = req.postDataJSON(); calls.push({url:url.pathname, method:req.method(), body, headers:req.headers()});
        let json = {ok:true}, status = 200;
        if (url.pathname === '/api/estado') json = {eu:logged?admin:null, naoLidas:0, s:{titulo:'GOATSKINS SORTEIOS', sub:'Ambiente local de teste.', cores:{gold:'#e4b45b',copper:'#ae702e',slate:'#102440',navy:'#0c192e'}}, c:[]};
        else if (url.pathname === '/api/login') { logged=true; json={ok:true,mfaRequired:true}; }
        else if (url.pathname === '/api/logout') { logged=false; verified=false; }
        else if (url.pathname === '/api/pedidos/pendente') json = null;
        else if (url.pathname === '/api/mfa/status') {
          if (unavailable) { status=503; json={erro:'MFA não configurado no servidor.'}; }
          else json={enabled,verified,required:true,remainingRecoveryCodes:8};
        } else if (url.pathname === '/api/mfa/preparar') {
          if (rejectPassword) { status=401; json={erro:'Senha incorreta.'}; }
          else json={secret,uri,qrCode};
        } else if (url.pathname === '/api/mfa/verificar') {
          if (rejectCode) { status=401; json={erro:'Código inválido ou já utilizado.'}; }
          else { json=enabled?{ok:true}:{ok:true,recoveryCodes:codes}; enabled=true; verified=true; }
        } else if (url.pathname.startsWith('/api/admin/')) {
          if (expireRequest) { expireRequest=false; verified=false; }
          if (!verified) { status=403; json={tipo:'MFA_REQUIRED',erro:'Confirme MFA.'}; }
          else json={usuarios:1,verificados:1,participacoes:0,hoje:0,semana:0,porSorteio:[],ultimas:[]};
        }
        await route.fulfill({status,json});
      });
      const heading = name => page.getByRole('heading',{name,exact:true}).waitFor();
      const shot = name => page.screenshot({path:path.join(output,`${width}-${name}.png`)});
      const layout = async () => {
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        assert(await page.locator('.dialog').evaluate(el => el.scrollWidth <= el.clientWidth+1), `overflow MFA ${width}`);
        assert.equal(await page.locator('.dialog').getAttribute('aria-labelledby'),'modalTitle');
      };
      const openAdmin = async () => {
        if (await page.locator('#menuBtn').getAttribute('aria-expanded') === 'false') await page.locator('#menuBtn').click();
        await page.locator('#adminBtn').click();
      };
      await page.goto(base); await page.waitForFunction(() => !document.documentElement.classList.contains('page-loading'));
      await page.locator('.cookie-actions button').nth(1).click();
      if (await page.locator('#menuBtn').getAttribute('aria-expanded') === 'false') await page.locator('#menuBtn').click();
      await page.locator('#loginBtn').click(); await heading('Entrar');
      await page.getByLabel('E-mail',{exact:true}).fill(admin.email); await page.getByLabel('Senha',{exact:true}).fill('Teste1234');
      await page.getByRole('button',{name:'Entrar',exact:true}).click(); await heading('Proteja sua administração'); await layout(); await shot('obrigatorio');
      assert.equal(calls.filter(c=>c.url.startsWith('/api/admin/')).length,0);
      await page.keyboard.press('Escape'); assert(await page.locator('#modal').isHidden());
      await openAdmin(); await heading('Proteja sua administração');
      await page.getByLabel('Senha da conta',{exact:true}).fill('Errada1234'); await page.getByLabel('Senha da conta',{exact:true}).press('Enter');
      await page.getByRole('alert').filter({hasText:'Senha incorreta.'}).waitFor();
      assert.equal(await page.getByLabel('Senha da conta',{exact:true}).inputValue(),''); rejectPassword=false;
      await page.getByLabel('Senha da conta',{exact:true}).fill('Teste1234'); await page.getByLabel('Senha da conta',{exact:true}).press('Enter');
      await heading('Conecte seu autenticador'); await layout(); await shot('qr');
      assert.equal(await page.getByLabel('Chave para configuração manual').inputValue(),secret);
      assert.equal(await page.locator('.mfa-qr').getAttribute('src'),qrCode);
      assert.equal(await page.locator('.mfa-qr').evaluate(img=>img.complete&&img.naturalWidth>100),true);
      assert(!page.url().includes(secret));
      await page.getByLabel('Senha da conta',{exact:true}).fill('Teste1234'); await page.getByLabel('Código do aplicativo',{exact:true}).fill('12x3456');
      assert.equal(await page.getByLabel('Código do aplicativo',{exact:true}).inputValue(),'12345');
      await page.getByLabel('Código do aplicativo',{exact:true}).fill('123456');
      await page.getByLabel('Código do aplicativo',{exact:true}).press('Enter'); await page.getByRole('alert').filter({hasText:'Código inválido ou já utilizado.'}).waitFor();
      assert.equal(await page.getByLabel('Senha da conta',{exact:true}).inputValue(),''); rejectCode=false;
      await page.getByLabel('Senha da conta',{exact:true}).fill('Teste1234'); await page.getByLabel('Código do aplicativo',{exact:true}).fill('654321');
      await page.getByLabel('Código do aplicativo',{exact:true}).press('Enter'); await heading('Guarde seus códigos'); await layout(); await shot('recuperacao');
      assert.equal(await page.locator('.mfa-recovery-list li').count(),8); assert.equal(await page.locator('.mfa-qr').count(),0);
      assert(await page.getByRole('button',{name:'Continuar para a administração',exact:true}).isDisabled());
      assert.equal(calls.filter(c=>c.url.startsWith('/api/admin/')).length,0);
      const downloadPromise=page.waitForEvent('download'); await page.getByRole('button',{name:'Baixar códigos',exact:true}).click();
      const download=await downloadPromise; const stream=await download.createReadStream(); let downloadText=''; for await (const chunk of stream) downloadText+=chunk;
      for (const code of codes) assert(downloadText.includes(code));
      const storage=await page.evaluate(()=>JSON.stringify([Object.entries(localStorage),Object.entries(sessionStorage)]));
      assert(!storage.includes(secret)); for (const code of codes) assert(!storage.includes(code));
      await page.getByLabel('Guardei meus códigos de recuperação em um local seguro.').check();
      await page.getByRole('button',{name:'Continuar para a administração',exact:true}).click(); await heading('Painel GOATSKINS');
      assert.equal(await page.locator('.mfa-recovery-list').count(),0); assert(calls.some(c=>c.url==='/api/admin/dashboard'));
      await page.locator('#closeBtn').click(); verified=false;
      await openAdmin(); await heading('Confirme seu acesso'); await layout(); await shot('desafio');
      await page.getByRole('button',{name:'Usar código de recuperação',exact:true}).click();
      assert.deepEqual(errors,[]);
      assert.equal(await page.getByLabel('Código de recuperação',{exact:true}).getAttribute('maxlength'),'35');
      await page.getByLabel('Senha da conta',{exact:true}).fill('Teste1234'); await page.getByLabel('Código de recuperação',{exact:true}).fill(codes[0]); await shot('codigo-recuperacao');
      assert.equal(await page.getByLabel('Código de recuperação',{exact:true}).inputValue(), codes[0]);
      await page.getByLabel('Código de recuperação',{exact:true}).press('Enter'); await heading('Painel GOATSKINS');
      assert(calls.some(c=>c.url==='/api/mfa/verificar'&&c.body.codigo===codes[0]),JSON.stringify(calls.filter(c=>c.url==='/api/mfa/verificar')));
      // Uma elevação expirada entre o status e o GET não abre caminho alternativo.
      await page.locator('#closeBtn').click(); expireRequest=true; await openAdmin(); await heading('Confirme seu acesso');
      await page.getByLabel('Senha da conta',{exact:true}).fill('Teste1234'); await page.getByLabel('Código do aplicativo',{exact:true}).fill('654322');
      await page.getByLabel('Código do aplicativo',{exact:true}).press('Enter');
      await heading('Painel GOATSKINS'); // GET é repetido após a verificação e retoma a aba.
      // Ações de escrita bloqueadas nunca são repetidas depois da verificação.
      verified=false;
      await page.evaluate(() => { window.mfaWriteOutcome=api('/api/admin/campanhas/99/encerrar','POST').then(()=> 'unexpected',e=>e.message); });
      await heading('Confirme seu acesso');
      await page.getByLabel('Senha da conta',{exact:true}).fill('Teste1234'); await page.getByLabel('Código do aplicativo',{exact:true}).fill('654323');
      await page.getByLabel('Código do aplicativo',{exact:true}).press('Enter'); await heading('Painel GOATSKINS');
      assert.match(await page.evaluate(()=>window.mfaWriteOutcome),/não foi executada/);
      assert.equal(calls.filter(c=>c.url==='/api/admin/campanhas/99/encerrar').length,1);
      await page.locator('#closeBtn').click(); verified=false; unavailable=true; await openAdmin(); await heading('Verificação indisponível'); await shot('indisponivel');
      assert.equal(await page.getByRole('heading',{name:'Painel GOATSKINS',exact:true}).count(),0);
      unavailable=false; await page.getByRole('button',{name:'Tentar novamente',exact:true}).click(); await heading('Confirme seu acesso');
      await page.locator('#closeBtn').click(); assert.equal(await page.locator('#modalBody').textContent(),'');
      for (const call of calls.filter(c=>c.method!=='GET')) assert.equal(call.headers['x-requested-with'],'goatskins');
      assert.deepEqual(external,[]); assert.deepEqual(errors,[]);
      console.log(`PASS ${width}px: ativação obrigatória, senha/OTP, QR local/chave, recuperação uma vez, download/aceite, expiração, bloqueio/repetição segura e cancelamento.`);
      await ctx.close();
    }
  } finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
