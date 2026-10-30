/* HTTP + PostgreSQL real, em schema exclusivo de um banco local descartável. */
const { test } = require('node:test'), assert = require('node:assert/strict');
const crypto = require('node:crypto'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const testUrl = require('../scripts/banco-teste').bancoTeste(process.env.TEST_DATABASE_URL);
const {normalize} = require('../public/cs2inspect');
const viewer = normalize({item:'ak-47/redline',wear:0.18,seed:661,stattrak:true,stickers:[{slot:0,index:5032,x:0.02,y:-0.01,rotation:12,wear:0.1}],charm:{index:4123,seed:661},view:'hands',manual:true});
const configuration = { premio: 'AK-47 | Redline', desgaste: 'Field-Tested', descricao: 'Skin de teste', valor: 250,
  cor: '#b3263a', max: 5, max_por_usuario: 2, preco_numero: 0, foto: 'data:image/jpeg;base64,/9j/AAAA', viewer_3d:viewer, reconfigurar_3d:false };

test('predefinições: CRUD, segurança, persistência e campanhas independentes', {skip: !testUrl, timeout: 90000}, async t => {
  const { Pool } = require('pg');
  const schema = 'presets_' + crypto.randomBytes(8).toString('hex');
  const pool = new Pool({connectionString: testUrl, options: '-c search_path=' + schema, connectionTimeoutMillis: 5000});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goat-presets-'));
  const port = await require('./helpers/free-port').freePort(), base = 'http://127.0.0.1:' + port;
  const env = {...process.env, NODE_ENV: 'test', RENDER: '', TESTE: '1', DATABASE_URL: testUrl, DATABASE_SSL: '0',
    PGOPTIONS: '-c search_path=' + schema, DATA_DIR: dir, PORT: String(port), APP_URL: base,
    EMAIL_DRIVER: 'console', EMAIL_CODE_SECRET: 'a'.repeat(64), MFA_ENCRYPTION_KEY: 'b'.repeat(64),
    MP_ACCESS_TOKEN: '', MP_WEBHOOK_SECRET: '', TURNSTILE_SITE_KEY: '', TURNSTILE_SECRET_KEY: '', TURNSTILE_HOSTNAMES: '', ORIGIN_VERIFY_SECRET: '', CS2INSPECT_EMBED_KEY:'pk_fixture_testonly'};
  let srv, cookie = '', preset, duplicate, campaignIds = [];
  const execute = args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
    let error = ''; child.stderr.on('data', data => error += data);
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(Error(error)));
  });
  const start = async () => {
    srv = spawn(process.execPath, ['server.js'], {cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true});
    let error = ''; srv.stderr.on('data', data => error += data);
    for (let attempt = 0; attempt < 120; attempt++) {
      if (srv.exitCode !== null) throw Error('Servidor de teste encerrou: ' + error);
      try { if ((await fetch(base + '/healthz', {signal: AbortSignal.timeout(1000)})).ok) return; } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw Error('Servidor de teste não iniciou.');
  };
  const stop = async () => {
    if (srv && srv.exitCode === null && srv.signalCode === null) await new Promise(resolve => {srv.once('exit', resolve); srv.kill();});
  };
  const request = async (method, route, body, auth = cookie, csrf = true) => {
    const response = await fetch(base + route, {method, signal: AbortSignal.timeout(10000),
      headers: {'Content-Type': 'application/json', ...(csrf ? {'X-Requested-With': 'goatskins'} : {}), ...(auth ? {Cookie: auth} : {})},
      body: body === undefined ? undefined : JSON.stringify(body)});
    const nextCookie = response.headers.get('set-cookie'); if (nextCookie && auth === cookie) cookie = nextCookie.split(';')[0];
    const contentType = response.headers.get('content-type') || '';
    return {status: response.status, headers: response.headers, data: contentType.includes('json') ? await response.json() : await response.arrayBuffer()};
  };
  const otp = secret => {
    let bits = 0, value = 0; const bytes = [];
    for (const char of secret) {value = (value << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(char); bits += 5; if (bits >= 8) {bytes.push((value >>> (bits - 8)) & 255); bits -= 8;}}
    const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
    const hmac = crypto.createHmac('sha1', Buffer.from(bytes)).update(counter).digest(), offset = hmac[19] & 15;
    return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
  };
  try {
    await pool.query('CREATE SCHEMA ' + schema);
    await execute(['server.js', 'criar-admin', 'presets-admin@goatskins.test', 'Admin1234', 'Administrador']);
    await start();
    const login = await request('POST', '/api/login', {email: 'presets-admin@goatskins.test', senha: 'Admin1234'});
    assert.equal(login.status, 200, JSON.stringify(login.data));
    await t.test('exige login, papel administrativo, MFA e CSRF em todas as operações', async () => {
      const result = await pool.query("INSERT INTO users(nome,contato,email,hash,email_verificado) VALUES('Pessoa','preset-user@goatskins.test','preset-user@goatskins.test','fixture',1) RETURNING id");
      const sid = 'preset-user-' + crypto.randomBytes(16).toString('hex');
      await pool.query('INSERT INTO sessions(token,user_id,expira) VALUES($1,$2,$3)', [crypto.createHash('sha256').update(sid).digest('hex'), result.rows[0].id, Date.now() + 900000]);
      for (const [method, route, body] of [['GET', '/api/admin/predefinicoes'], ['GET', '/api/admin/predefinicoes/1'],
        ['GET', '/api/admin/predefinicoes/1/foto'], ['POST', '/api/admin/predefinicoes', {}], ['PUT', '/api/admin/predefinicoes/1', {}],
        ['DELETE', '/api/admin/predefinicoes/1', {}], ['POST', '/api/admin/predefinicoes/1/duplicar', {}], ['GET', '/api/admin/campanhas/1']]) {
        assert.equal((await request(method, route, body, '')).status, 401, method + ' ' + route);
        assert.equal((await request(method, route, body, 'sid=' + sid)).status, 403, method + ' ' + route);
        const elevated = await request(method, route, body);
        assert.equal(elevated.status, 403); assert.equal(elevated.data.tipo, 'MFA_REQUIRED');
      }
    });
    const setup = await request('POST', '/api/mfa/preparar', {senha: 'Admin1234'});
    assert.equal(setup.status, 200);
    const activated = await request('POST', '/api/mfa/verificar', {senha: 'Admin1234', codigo: otp(setup.data.secret)});
    assert.equal(activated.status, 200, JSON.stringify(activated.data));

    await t.test('cria, lista sem imagem embutida, pesquisa literal e consulta detalhes', async () => {
      assert.equal((await request('POST', '/api/admin/predefinicoes', {nome: 'AK padrão', dados: configuration}, cookie, false)).status, 403);
      const result = await request('POST', '/api/admin/predefinicoes', {nome: 'AK padrão', dados: configuration});
      assert.equal(result.status, 200, JSON.stringify(result.data)); preset = result.data;
      assert.equal(preset.versao, 1); assert.equal(preset.dados.foto, configuration.foto);
      assert.deepEqual(preset.dados.viewer_3d,viewer); assert.equal(preset.reconfigurar_3d,false);
      const list = await request('GET', '/api/admin/predefinicoes?q=redline');
      assert.equal(list.status, 200); assert.equal(list.data.length, 1); assert.equal(list.data[0].dados.foto, undefined); assert.match(list.data[0].foto, /\/foto\?v=1$/);
      assert.equal((await request('GET', '/api/admin/predefinicoes?q=padr%C3%A3o')).data.length, 1);
      assert.equal((await request('GET', '/api/admin/predefinicoes?q=%25')).data.length, 0);
      assert.equal((await request('GET', '/api/admin/predefinicoes?q=%27%20OR%201%3D1--')).data.length, 0);
      assert.deepEqual((await request('GET', '/api/admin/predefinicoes/' + preset.id)).data, preset);
      const photo = await request('GET', '/api/admin/predefinicoes/' + preset.id + '/foto');
      assert.equal(photo.status, 200); assert.match(photo.headers.get('cache-control'), /no-store/);
      assert.equal((await pool.query('SELECT COUNT(*) n FROM campaigns')).rows[0].n, '0');
    });
    await t.test('rejeita estado operacional, dados inválidos e URLs incompatíveis', async () => {
      for (const key of ['id', 'seed', 'commit_hash', 'status', 'fim', 'criado_por', 'participantes', 'tickets', 'reservados', 'pedidos', 'ganhador', 'preco_centavos'])
        assert.equal((await request('POST', '/api/admin/predefinicoes', {nome: 'Inválida', dados: {...configuration, [key]: 'proibido'}})).status, 400, key);
      for (const change of [{foto: 'javascript:alert(1)'}, {valor: 'NaN'}, {valor: {}}, {preco_numero: 'Infinity'}, {max_por_usuario: 0}, {max: 101},
        {cor: 'red'}, {viewer_3d:{item:'https://evil.test/model'}}, {viewer_3d:{item:'ak-47/redline',wear:1.01}},
        {viewer_3d:{item:'ak-47/redline',seed:1001}},{viewer_3d:{item:'ak-47/redline',stattrak:'true'}},
        {viewer_3d:{item:'ak-47/redline',stickers:[{slot:0,index:5032},{slot:0,index:4501}]}},
        {viewer_3d:{item:'ak-47/redline',charm:{index:-1}}},{reconfigurar_3d:'true'},
        {inspect_link:'steam://rungame/730/1/+csgo_econ_action_preview%20S123A456D789'}])
        assert.equal((await request('POST', '/api/admin/predefinicoes', {nome: 'Inválida', dados: {...configuration, ...change}})).status, 400, JSON.stringify(change));
    });
    await t.test('preenche campanhas independentes com sementes e participações próprias', async () => {
      for (let i = 0; i < 3; i++) {
        const result = await request('POST', '/api/admin/campanhas', preset.dados);
        assert.equal(result.status, 200, JSON.stringify(result.data));
      }
      const rows = (await pool.query('SELECT id,seed,commit_hash,status,fim FROM campaigns ORDER BY id')).rows;
      campaignIds = rows.map(row => row.id); assert.equal(new Set(campaignIds).size, 3); assert.equal(new Set(rows.map(row => row.seed)).size, 3);
      for (const row of rows) {assert.equal(row.status, 'OPEN'); assert.equal(row.fim, ''); assert.equal(crypto.createHash('sha256').update(row.seed).digest('hex'), row.commit_hash);}
      const participant = (await pool.query("SELECT id FROM users WHERE contato='preset-user@goatskins.test'")).rows[0].id;
      await pool.query("INSERT INTO tickets(campaign_id,user_id,n,criado_em) VALUES($1,$2,1,'')", [campaignIds[0], participant]);
      await pool.query("INSERT INTO pedidos(public_id,user_id,campaign_id,numeros,total_centavos,expira_em,criado_em,atualizado_em) VALUES('preset-order-fixture',$1,$2,'[2]',100,$3,'','')", [participant, campaignIds[0], Date.now() + 60000]);
      const order = (await pool.query("SELECT id FROM pedidos WHERE public_id='preset-order-fixture'")).rows[0].id;
      await pool.query('INSERT INTO reservas(campaign_id,n,pedido_id) VALUES($1,2,$2)', [campaignIds[0], order]);
      await pool.query("UPDATE campaigns SET status='CLOSED' WHERE id=$1", [campaignIds[0]]);
      await pool.query("INSERT INTO winners(campaign_id,user_id,n,total,data) VALUES($1,$2,1,1,'2026-10-30')", [campaignIds[0], participant]);
      const state = (await request('GET', '/api/estado')).data.c;
      assert.equal((await request('GET','/api/estado')).data.viewer3d.key,'pk_fixture_testonly');
      assert.equal(state.some(c=>Object.hasOwn(c,'inspect_link')||Object.hasOwn(c,'viewer_3d_pendente')),false);
      assert.equal(state.find(row => row.id === Number(campaignIds[0])).total, 1);
      for (const id of campaignIds.slice(1)) {const row = state.find(row => row.id === Number(id)); assert.equal(row.total, 0); assert.deepEqual(row.reservados, []); assert.equal(row.ganhador, null); assert.equal(row.status, 'OPEN');}
      const editable = await request('GET', '/api/admin/campanhas/' + campaignIds[1]);
      assert.equal(editable.data.foto, configuration.foto); assert.equal(editable.data.preco_numero, 0); assert.equal(editable.data.seed, undefined);
      const safeEdit = {...preset.dados}; delete safeEdit.viewer_3d; delete safeEdit.reconfigurar_3d; delete safeEdit.foto;
      assert.equal((await request('PUT', '/api/admin/campanhas/' + campaignIds[1], safeEdit)).status, 200);
      const unchanged = (await request('GET', '/api/admin/campanhas/' + campaignIds[1])).data;
      assert.deepEqual(unchanged.viewer_3d,preset.dados.viewer_3d); assert.equal(unchanged.foto, configuration.foto);
      const cleared = await request('PUT', '/api/admin/campanhas/' + campaignIds[1], {...preset.dados, viewer_3d:null});
      assert.equal(cleared.status, 200); assert.equal((await request('GET', '/api/admin/campanhas/' + campaignIds[1])).data.viewer_3d, null);
    });
    await t.test('edita com versão, duplica e exclui sem modificar campanhas existentes', async () => {
      const before = (await pool.query('SELECT * FROM campaigns ORDER BY id')).rows;
      const edit = await request('PUT', '/api/admin/predefinicoes/' + preset.id, {nome: 'AK revisada', dados: {...preset.dados, premio: 'Outro modelo'}, versao: preset.versao});
      assert.equal(edit.status, 200, JSON.stringify(edit.data)); assert.equal(edit.data.versao, 2);
      assert.equal((await request('PUT', '/api/admin/predefinicoes/' + preset.id, {nome: 'Antiga', dados: preset.dados, versao: preset.versao})).status, 409);
      assert.equal((await request('DELETE', '/api/admin/predefinicoes/' + preset.id, {versao: preset.versao})).status, 409);
      preset = edit.data;
      const copied = await request('POST', '/api/admin/predefinicoes/' + preset.id + '/duplicar', {});
      assert.equal(copied.status, 200); duplicate = copied.data;
      assert.notEqual(duplicate.id, preset.id); assert.equal(duplicate.versao, 1); assert.deepEqual(duplicate.dados, preset.dados);
      assert.equal((await request('DELETE', '/api/admin/predefinicoes/' + preset.id, {versao: preset.versao})).status, 200);
      assert.equal((await request('GET', '/api/admin/predefinicoes/' + preset.id)).status, 404);
      assert.deepEqual((await pool.query('SELECT * FROM campaigns ORDER BY id')).rows, before);
      assert.equal((await pool.query('SELECT COUNT(*) n FROM tickets')).rows[0].n, '1');
      assert.equal((await pool.query('SELECT COUNT(*) n FROM reservas')).rows[0].n, '1');
      assert.equal((await pool.query('SELECT COUNT(*) n FROM pedidos')).rows[0].n, '1');
      assert.equal((await pool.query('SELECT COUNT(*) n FROM winners')).rows[0].n, '1');
      assert.equal((await pool.query("SELECT COUNT(*) n FROM audit_logs WHERE acao LIKE 'PREDEFINICAO_%'")).rows[0].n, '4');
    });
    await t.test('reiniciar mantém predefinições, imagens e configurações 3D no PostgreSQL', async () => {
      await stop(); await start();
      const persisted = await request('GET', '/api/admin/predefinicoes/' + duplicate.id);
      assert.equal(persisted.status, 200); assert.deepEqual(persisted.data, duplicate);
      const campaign = await request('GET', '/api/admin/campanhas/' + campaignIds[2]);
      assert.equal(campaign.status, 200); assert.deepEqual(campaign.data.viewer_3d, duplicate.dados.viewer_3d);
      assert.equal((await pool.query('SELECT MAX(versao) v FROM schema_migrations')).rows[0].v, 12);
    });
    await t.test('modelos de armas, facas e luvas mantêm configurações próprias nas predefinições', async () => {
      for (const spec of [{item:'ak-47/redline',wear:0.18,seed:661,stattrak:true},
        {name:'★ Karambit | Doppler (Factory New)',wear:0.01,seed:512,view:'hands'},
        {item:'sport-gloves/vice',wear:0.15,seed:1000}]) {
        const saved = await request('POST','/api/admin/predefinicoes',{nome:'Modelo '+(spec.item||spec.name),dados:{...configuration,viewer_3d:spec}});
        assert.equal(saved.status,200,JSON.stringify(saved.data));
        assert.deepEqual(saved.data.dados.viewer_3d,normalize(spec));
        assert.equal(saved.data.dados.reconfigurar_3d,false);
      }
    });
    await t.test('predefinições e campanhas antigas preservam dados e sinalizam configuração pendente sem conversão aproximada', async () => {
      const legacyLink = 'steam://rungame/730/76561202255233023/+csgo_econ_action_preview%20OLD_CONFIG';
      const legacy = {...configuration,premio:'Skin antiga preservada',inspect_link:legacyLink,modelo_3d_manual:1};
      delete legacy.viewer_3d; delete legacy.reconfigurar_3d;
      const oldPresetId = (await pool.query("INSERT INTO campaign_presets(nome,dados,criado_em,atualizado_em) VALUES('Predefinição antiga',$1::jsonb,'antes','antes') RETURNING id",[JSON.stringify(legacy)])).rows[0].id;
      const oldCampaignId = (await pool.query("INSERT INTO campaigns(premio,desgaste,descricao,valor,cor,fim,max,max_por_usuario,foto,inspect_link,modelo_3d_manual) VALUES($1,$2,$3,$4,$5,'',5,2,$6,$7,1) RETURNING id",[legacy.premio,legacy.desgaste,legacy.descricao,legacy.valor,legacy.cor,legacy.foto,legacyLink])).rows[0].id;
      const oldPreset = (await request('GET','/api/admin/predefinicoes/'+oldPresetId)).data;
      assert.equal(oldPreset.dados.viewer_3d,null); assert.equal(oldPreset.dados.reconfigurar_3d,true); assert.equal(oldPreset.reconfigurar_3d,true);
      assert.equal(oldPreset.dados.foto,legacy.foto); assert.equal(oldPreset.dados.descricao,legacy.descricao);
      assert.equal(Object.hasOwn(oldPreset.dados,'inspect_link'),false); assert.equal(Object.hasOwn(oldPreset.dados,'modelo_3d_manual'),false);
      assert.deepEqual((await pool.query('SELECT dados FROM campaign_presets WHERE id=$1',[oldPresetId])).rows[0].dados,legacy,'A leitura não regrava o snapshot legado.');
      const copied = await request('POST','/api/admin/predefinicoes/'+oldPresetId+'/duplicar',{});
      assert.equal(copied.status,200,JSON.stringify(copied.data)); assert.equal(copied.data.dados.reconfigurar_3d,true); assert.equal(copied.data.dados.foto,legacy.foto);
      assert.equal((await request('POST','/api/admin/campanhas',copied.data.dados)).status,200);
      const newId = (await pool.query('SELECT max(id) id FROM campaigns')).rows[0].id;
      const fromPreset = (await request('GET','/api/admin/campanhas/'+newId)).data;
      assert.equal(fromPreset.viewer_3d,null); assert.equal(fromPreset.reconfigurar_3d,true);
      const oldCampaign = (await request('GET','/api/admin/campanhas/'+oldCampaignId)).data;
      assert.equal(oldCampaign.reconfigurar_3d,true); assert.equal(oldCampaign.viewer_3d,null);
      const publicOld = (await request('GET','/api/estado')).data.c.find(c=>c.id===Number(oldCampaignId));
      assert.equal(publicOld.reconfigurar_3d,true); assert.equal(Object.hasOwn(publicOld,'inspect_link'),false);
      const configured = await request('PUT','/api/admin/campanhas/'+oldCampaignId,{...oldPreset.dados,viewer_3d:{item:'awp/asiimov',wear:0.4,seed:100}});
      assert.equal(configured.status,200,JSON.stringify(configured.data));
      const reviewed = (await request('GET','/api/admin/campanhas/'+oldCampaignId)).data;
      assert.equal(reviewed.reconfigurar_3d,false); assert.equal(reviewed.viewer_3d.item,'awp/asiimov');
      assert.equal((await pool.query('SELECT inspect_link FROM campaigns WHERE id=$1',[oldCampaignId])).rows[0].inspect_link,legacyLink,'O histórico de configuração permanece arquivado.');
      assert.equal((await request('PUT','/api/admin/campanhas/'+oldCampaignId,{...oldPreset.dados,viewer_3d:null,reconfigurar_3d:false})).status,200);
      assert.equal((await request('GET','/api/admin/campanhas/'+oldCampaignId)).data.reconfigurar_3d,false,'Remoção explícita não reativa o aviso antigo.');
      await pool.query('UPDATE campaigns SET viewer_3d=$1::jsonb WHERE id=$2',[JSON.stringify({item:'javascript:invalid'}),oldCampaignId]);
      const corrupted = (await request('GET','/api/admin/campanhas/'+oldCampaignId)).data;
      assert.equal(corrupted.viewer_3d,null); assert.equal(corrupted.reconfigurar_3d,true,'Configuração inválida armazenada falha de forma segura.');
    });
  } finally {
    await stop();
    await pool.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'); await pool.end();
    if (path.dirname(path.resolve(dir)) !== path.resolve(os.tmpdir()) || !path.basename(dir).startsWith('goat-presets-')) throw Error('Diretório temporário inesperado.');
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
