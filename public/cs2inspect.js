/* Contrato compartilhado do iframe oficial: https://cs2inspect.skin/docs/api.
   Não recebe URLs de frames e não consulta o catálogo ou qualquer API privada. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GoatCS2Inspect = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const ORIGIN = 'https://cs2inspect.skin';
  const fields = ['item','name','weapon','paint','wear','seed','stattrak','nametag','stickers','charm','view','manual'];
  function record(value, keys, message) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error(message);
  }
  function text(value, max, message, min = 1) {
    if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value) || value.trim().length < min || value.trim().length > max) throw new Error(message);
    return value.trim();
  }
  function number(value, min, max, message, integer = false) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) throw new Error(message);
    return Object.is(value, -0) ? 0 : value;
  }
  function bool(value, message) {
    if (typeof value !== 'boolean') throw new Error(message);
    return value;
  }
  function normalize(config) {
    record(config, fields, 'A configuração 3D deve conter somente os campos permitidos do CS2Inspect.');
    const selectors = ['item','name','weapon'].filter(key => Object.hasOwn(config,key));
    if (selectors.length !== 1) throw new Error('Escolha somente um identificador: nome da skin, item oficial ou modelo e paint index.');
    const selector = selectors[0], result = {};
    if (selector === 'item') {
      result.item = text(config.item, 160, 'Informe o identificador oficial, por exemplo ak-47/redline.');
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)?$/.test(result.item)) throw new Error('Use o identificador oficial da skin, por exemplo ak-47/redline, sem domínio ou parâmetros.');
    } else if (selector === 'weapon') {
      result.weapon = text(config.weapon, 80, 'Informe um identificador de modelo válido.');
      if (!/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/.test(result.weapon)) throw new Error('Informe um identificador de modelo válido.');
    } else {
      result.name = text(config.name, 200, 'Informe o nome oficial da skin no mercado Steam.');
      if (/[<>]|(?:https?|steam|javascript|data):|\/\//i.test(result.name)) throw new Error('Informe o nome da skin, sem links ou marcação HTML.');
    }
    if (Object.hasOwn(config,'paint')) {
      if (selector !== 'weapon') throw new Error('Paint index só pode ser usado junto ao identificador do modelo.');
      result.paint = number(config.paint,0,2147483647,'Paint index inválido.',true);
    }
    result.wear = config.wear === undefined ? 0.06 : number(config.wear,0,1,'Float deve ser um número de 0 a 1.');
    result.seed = config.seed === undefined ? 1 : number(config.seed,0,1000,'Pattern seed deve ser um inteiro de 0 a 1000.',true);
    result.stattrak = config.stattrak === undefined ? false : bool(config.stattrak,'StatTrak deve ser verdadeiro ou falso.');
    result.nametag = config.nametag === undefined ? '' : text(config.nametag,20,'Name tag deve ter até 20 caracteres.',0);
    if (/[<>]/.test(result.nametag)) throw new Error('Name tag não pode conter marcação HTML.');
    const stickers = config.stickers === undefined ? [] : config.stickers;
    if (!Array.isArray(stickers) || stickers.length > 5) throw new Error('Use no máximo cinco stickers, com slots diferentes.');
    const slots = new Set();
    result.stickers = stickers.map(sticker => {
      record(sticker,['slot','index','x','y','rotation','wear'],'Sticker inválido.');
      const item = {slot:number(sticker.slot,0,4,'Slot do sticker deve ser um inteiro de 0 a 4.',true),index:number(sticker.index,1,2147483647,'Índice do sticker inválido.',true)};
      if (slots.has(item.slot)) throw new Error('Os stickers não podem repetir o mesmo slot.');
      slots.add(item.slot);
      if (['x','y','rotation','wear'].some(key=>Object.hasOwn(sticker,key))) {
        item.x = number(sticker.x === undefined ? 0 : sticker.x,-1e6,1e6,'Posição horizontal do sticker inválida.');
        item.y = number(sticker.y === undefined ? 0 : sticker.y,-1e6,1e6,'Posição vertical do sticker inválida.');
        item.rotation = number(sticker.rotation === undefined ? 0 : sticker.rotation,-1e6,1e6,'Rotação do sticker inválida.');
        item.wear = number(sticker.wear === undefined ? 0 : sticker.wear,0,1,'Desgaste do sticker deve ser de 0 a 1.');
      }
      return item;
    }).sort((a,b)=>a.slot-b.slot);
    result.charm = null;
    if (config.charm !== undefined && config.charm !== null) {
      record(config.charm,['index','seed'],'Charm inválido.');
      result.charm = {index:number(config.charm.index,1,2147483647,'Índice do charm inválido.',true)};
      if (Object.hasOwn(config.charm,'seed')) result.charm.seed = number(config.charm.seed,0,2147483647,'Pattern seed do charm inválido.',true);
    }
    result.view = config.view === undefined ? 'item' : config.view;
    if (!['item','hands'].includes(result.view)) throw new Error('Visualização inicial inválida.');
    result.manual = config.manual === undefined ? true : bool(config.manual,'Indique se o modelo é uma representação ilustrativa.');
    return result;
  }
  function publicKey(value) {
    if (typeof value !== 'string' || value.length > 200 || !/^pk_[A-Za-z0-9_-]+$/.test(value)) throw new Error('A chave pública de embed do CS2Inspect não está configurada ou é inválida.');
    return value;
  }
  function frameUrl(config, key) {
    const data = normalize(config), url = new URL('/embed',ORIGIN);
    const params = {key:publicKey(key),bg:'transparent',logo:'minimal',logopos:'br',accent:'d4aa55',interactive:'1',controls:'1',view:data.view,spin:'0',loader:'spinner',wear:String(data.wear),seed:String(data.seed),st:data.stattrak?'1':'0'};
    for (const key of ['item','name','weapon','paint']) if (data[key] !== undefined) params[key] = String(data[key]);
    if (data.nametag) params.nametag = data.nametag;
    if (data.stickers.length) params.stickers = data.stickers.map(sticker => [sticker.slot,sticker.index,...(sticker.x === undefined ? [] : [sticker.x,sticker.y,sticker.rotation,sticker.wear])].join(':')).join(',');
    if (data.charm) params.charm = data.charm.index + (data.charm.seed === undefined ? '' : ':'+data.charm.seed);
    Object.entries(params).forEach(([key,value])=>url.searchParams.set(key,value));
    return url.href;
  }
  return Object.freeze({ORIGIN,normalize,publicKey,frameUrl});
});
