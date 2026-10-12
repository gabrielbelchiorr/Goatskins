/* Teste unitário de Turnstile sem banco, rede ou chaves reais. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const cfg = {
  TURNSTILE_SITE_KEY: 'site-test',
  TURNSTILE_SECRET_KEY: 'secret-test',
  TURNSTILE_HOSTNAMES: 'goatskins.br',
  APP_URL: 'https://goatskins.onrender.com',
  PRODUCAO: true,
  TESTE: true
};
class Erro extends Error { constructor(message, code = 400) { super(message); this.code=code; } }
const filename = path.join(__dirname, '../src/security.js');
const moduleObj = new Module(filename);
moduleObj.filename = filename;
moduleObj.require = id => {
  if (id === './config') return cfg;
  if (id === './http') return { Erro, ipDe: () => '127.0.0.1' };
  if (id === './db') return { db: { get: async () => ({n:3}) }, sha: s => s };
  if (id === './registration') return { consumirLimite: async () => undefined };
  throw Error('Dependência inesperada: '+id);
};
moduleObj._compile(fs.readFileSync(filename,'utf8'),filename);
const sec = moduleObj.exports;
const originalFetch = global.fetch;
test.after(() => {global.fetch = originalFetch;});

test('recusa token ausente, sem consultar Cloudflare', async () => {
  global.fetch = () => {throw Error('não deveria consultar');};
  await assert.rejects(sec.verificar('', 'registro'), e => e.code===403 && e.tipo==='TURNSTILE_REQUIRED');
  await assert.rejects(sec.verificar('x'.repeat(2049), 'registro'), e => e.code===403);
});

test('aceita apenas hostname e action autorizados', async () => {
  let resposta;
  global.fetch = async (url, op) => {
    assert.equal(url,'https://challenges.cloudflare.com/turnstile/v0/siteverify');
    const corpo=JSON.parse(op.body);
    assert.equal(corpo.secret,'secret-test');
    assert.equal(corpo.response,'token');
    return {ok:true,json:async () => resposta};
  };
  for (const hostname of ['goatskins.br','goatskins.onrender.com']) {
    resposta = {success:true,hostname,action:'registro'};
    await sec.verificar('token','registro');
  }
  for (const data of [
    {success:true,hostname:'dominio-invasor.com',action:'registro'},
    {success:true,hostname:'sub.goatskins.br',action:'registro'},
    {success:true,hostname:'goatskins.br',action:'login'},
    {success:false,hostname:'goatskins.br',action:'registro'},
    {success:true,action:'registro'}
  ]) {
    resposta = data;
    await assert.rejects(sec.verificar('token','registro'),e=>e.code===403);
  }
});

test('bloqueia a operação quando Cloudflare não responde', async () => {
  global.fetch = async () => { throw Error('offline'); };
  await assert.rejects(sec.verificar('token','registro'),e=>e.code===503);
});

test('exige validação no cadastro e recuperação de senha; login após limiar', async () => {
  const vistos=[];
  global.fetch=async (_url,op)=>{
    vistos.push(JSON.parse(op.body));
    return {ok:true,json:async()=>({success:true,hostname:'goatskins.onrender.com',action:vistos.at(-1).response})};
  };
  for (const rota of ['/api/registro','/api/esqueci-senha','/api/login']) {
    const action=rota==='/api/registro'?'registro':rota==='/api/login'?'login':'recuperacao';
    await assert.rejects(sec.proteger({method:'POST',headers:{}},{},rota),e=>e.code===403);
    await sec.proteger({method:'POST',headers:{}},{turnstileToken:action},rota);
  }
  assert.equal(vistos.length,3);
});
