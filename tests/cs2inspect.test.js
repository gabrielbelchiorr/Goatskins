const test=require('node:test'),assert=require('node:assert/strict');
const {normalize,frameUrl,publicKey,ORIGIN}=require('../public/cs2inspect');
const defaults={wear:.06,seed:1,stattrak:false,nametag:'',stickers:[],charm:null,view:'item',manual:true};
const key='pk_live_fixture_public';
test('CS2Inspect: normaliza armas, facas, luvas e os três seletores oficiais sem inventar atributos',()=>{
  for(const selector of [{item:'ak-47/redline'},{item:'karambit/doppler'},{item:'sport-gloves/vice'},{name:'★ StatTrak™ Karambit | Doppler (Factory New)'},{weapon:'ak47',paint:282},{item:'ak-47'}]) {
    assert.deepEqual(normalize(selector),{...selector,...defaults});
    assert.deepEqual(normalize(normalize(selector)),normalize(selector));
  }
});
test('CS2Inspect: serializa URL oficial, transparência, marca gratuita, cor e controles sem SDK',()=>{
  const url=new URL(frameUrl({item:'ak-47/redline',wear:.18,seed:661,stattrak:true,view:'hands',nametag:'Minha skin',stickers:[{slot:2,index:4501},{slot:0,index:5032,x:.02,y:-.01,rotation:12,wear:.1}],charm:{index:4123,seed:661}},key));
  assert.equal(url.origin,ORIGIN);assert.equal(url.pathname,'/embed');assert.equal(url.searchParams.get('key'),key);
  for(const [name,value]of Object.entries({bg:'transparent',logo:'minimal',accent:'d4aa55',interactive:'1',controls:'1',view:'hands',spin:'0',st:'1',wear:'0.18',seed:'661',nametag:'Minha skin',stickers:'0:5032:0.02:-0.01:12:0.1,2:4501',charm:'4123:661'})) assert.equal(url.searchParams.get(name),value,name);
  assert.equal(new URL(frameUrl({weapon:'ak47',paint:282},key)).searchParams.get('paint'),'282');
});
test('CS2Inspect: rejeita URL arbitrária, ambiguidade, campos desconhecidos e poluição de protótipo',()=>{
  for(const input of [null,[],1,'ak-47/redline',{}, {item:'ak-47',name:'AK-47'}, {item:''}, {item:'https://evil.test/model'}, {item:'../ak-47/redline'}, {item:'ak-47/redline?key=x'}, {item:'AK-47/Redline'}, {name:'javascript:alert(1)'}, {name:'<img src=x onerror=alert(1)>'}, {weapon:'../ak47'}, {name:'AK-47 | Redline',paint:282}, {item:'ak-47',src:'https://evil.test'}, {item:'ak-47',key}, JSON.parse('{"item":"ak-47","__proto__":{"polluted":true}}')]) assert.throws(()=>normalize(input));
  assert.equal({}.polluted,undefined);
});
test('CS2Inspect: valida tipos e faixas sem coerção silenciosa',()=>{
  for(const patch of [{wear:-.1},{wear:1.1},{wear:'0.2'},{wear:NaN},{wear:Infinity},{wear:null},{seed:1001},{seed:1.5},{seed:'1'},{seed:true},{stattrak:1},{stattrak:'false'},{manual:1},{manual:null},{view:'camera'},{nametag:'a'.repeat(21)},{nametag:'x\nfoo'},{paint:1},{stickers:null},{charm:[]},{charm:{index:0}},{charm:{index:1,seed:-1}}]) assert.throws(()=>normalize({item:'ak-47/redline',...patch}),JSON.stringify(patch));
  assert.equal(normalize({item:'ak-47',wear:0,seed:0}).wear,0);assert.equal(normalize({item:'ak-47',wear:1,seed:1000}).seed,1000);
});
test('CS2Inspect: valida slots, índices, offsets e desgaste de stickers/charm',()=>{
  for(const stickers of [Array.from({length:6},(_,slot)=>({slot,index:1})),[{slot:0,index:1},{slot:0,index:2}],[{slot:5,index:1}],[{slot:-1,index:1}],[{slot:0,index:0}],[{slot:0,index:'5032'}],[{slot:0,index:1,x:Infinity}],[{slot:0,index:1,wear:1.1}],[{slot:0,index:1,unknown:true}]]) assert.throws(()=>normalize({item:'ak-47',stickers}));
  assert.deepEqual(normalize({item:'ak-47',stickers:[{slot:1,index:5032,wear:.2}]}).stickers,[{slot:1,index:5032,x:0,y:0,rotation:0,wear:.2}]);
  assert.equal(new URL(frameUrl({item:'ak-47',charm:{index:4123}},key)).searchParams.get('charm'),'4123');
});
test('CS2Inspect: chave configurável somente pública e nenhum segredo/URL na configuração persistida',()=>{
  for(const invalid of ['',null,undefined,'secret','https://evil.test',key+'\n',key+'?redirect=x','pk_'+'x'.repeat(201)]) assert.throws(()=>publicKey(invalid));
  assert.equal(publicKey(key),key);assert.throws(()=>frameUrl({item:'ak-47'},''),/chave pública/);
  assert.equal(Object.hasOwn(normalize({item:'ak-47'}),'key'),false);
});
