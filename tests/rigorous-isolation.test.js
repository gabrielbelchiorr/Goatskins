/* Exercises audit safety boundaries in independent real Node subprocesses. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const preload = path.join(__dirname, '../scripts/security-isolation.js');
function isolated(source) {
  const result = spawnSync(process.execPath, ['--require', preload, '-e', source], {
    encoding: 'utf8', timeout: 10000, env: { ...process.env, NODE_OPTIONS: '' }
  });
  assert.equal(result.status, 0, result.stderr); return result;
}
test('audit isolation blocks native fetch and TCP egress before connecting', () => {
  isolated(`const assert=require('node:assert/strict');
    assert.throws(()=>require('node:net').connect(443,'example.com'),e=>e.code==='AUDIT_EGRESS_BLOCKED');
    assert.throws(()=>require('node:net').connect({host:'192.0.2.1',port:5432}),e=>e.code==='AUDIT_EGRESS_BLOCKED');
    assert.throws(()=>require('node:dgram').createSocket('udp4').send('x',53,'192.0.2.1'),e=>e.code==='AUDIT_EGRESS_BLOCKED');
    assert.rejects(fetch('https://example.com/'),e=>e.code==='AUDIT_EGRESS_BLOCKED');`);
});
test('audit isolation permits a real loopback HTTP exchange', () => {
  isolated(`const assert=require('node:assert/strict'),http=require('node:http');
    const s=http.createServer((req,res)=>res.end('local-fixture'));
    s.listen(0,'127.0.0.1',async()=>{try{
      const r=await fetch('http://127.0.0.1:'+s.address().port);
      assert.equal(r.status,200);assert.equal(await r.text(),'local-fixture');
    }finally{s.close();s.closeAllConnections();}});`);
});
test('audit isolation does not open runtime environment files in sync/async readers', () => {
  isolated(`const assert=require('node:assert/strict'),fs=require('node:fs');
    assert.throws(()=>fs.readFileSync('.env'),e=>e.code==='ENOENT');
    assert.throws(()=>fs.readFileSync('.env.production'),e=>e.code==='ENOENT');
    assert.ok(fs.readFileSync('.env.example','utf8').length>0);
    Promise.all([
      assert.rejects(fs.promises.readFile('.env'),e=>e.code==='ENOENT'),
      new Promise(resolve=>fs.readFile('.env',(e,data)=>{assert.equal(e.code,'ENOENT');assert.equal(data,undefined);resolve();}))
    ]).catch(e=>{console.error(e);process.exitCode=1;});`);
});
