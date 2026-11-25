/* Recusa senhas novas que aparecem no topo das listas de vazamentos ou que são previsíveis
   (palavra comum + números, sequência de teclado, o próprio e-mail ou nome). Só vale para senhas
   NOVAS (cadastro, troca e redefinição); o login de contas existentes não muda. Tudo local, sem
   enviar a senha ou parte dela a serviços externos. */
const PALAVRAS = new Set([
  'senha', 'password', 'passw0rd', 'pass', 'goatskins', 'goatskin', 'goat', 'skins', 'skin', 'cs2', 'csgo', 'counterstrike',
  'admin', 'administrador', 'root', 'teste', 'test', 'usuario', 'user', 'login', 'mudar', 'trocar', 'acesso', 'entrar',
  'qwerty', 'qwertyuiop', 'asdf', 'asdfgh', 'asdfghjkl', 'zxcvbn', 'abc', 'abcd', 'abcde', 'abcdef', 'abcdefg', 'abcdefgh',
  'brasil', 'brazil', 'flamengo', 'corinthians', 'palmeiras', 'santos', 'gremio', 'vasco', 'cruzeiro', 'saopaulo',
  'iloveyou', 'teamo', 'amor', 'deus', 'jesus', 'jesuscristo', 'familia', 'futebol', 'princesa', 'dragon', 'monkey',
  'sorteio', 'rifa', 'pix', 'master', 'shadow', 'sunshine', 'welcome', 'football', 'batman', 'superman', 'pokemon'
]);
const SEQUENCIAS = ['0123456789', '9876543210', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm', 'abcdefghijklmnopqrstuvwxyz', '1q2w3e4r5t6y', 'q1w2e3r4t5y6', 'a1b2c3d4e5f6'];

function senhaComum(senha, pessoais = []) {
  if (typeof senha !== 'string') return true;
  const s = senha.toLowerCase();
  const letras = s.replace(/[^a-z]/g, ''), digitos = s.replace(/\D/g, '');
  // palavra comum com números/símbolos antes ou depois: senha123, @goatskins2024, 123mudar
  const nucleo = s.replace(/^[^a-z]+|[^a-z]+$/g, '');
  if (PALAVRAS.has(nucleo) || PALAVRAS.has(letras)) return true;
  // uma ou duas letras "de enfeite" em volta de números: 12345678a, a1234567, 11111111aa
  if (letras.length <= 2 && digitos.length >= 6) return true;
  // o mesmo caractere ou o mesmo trecho curto repetido: aaaa1111, ab12ab12ab12
  if (/^(.{1,4})\1+$/.test(s) || new Set(s).size <= 3) return true;
  // trecho de sequência de teclado ou do alfabeto que cobre quase toda a senha
  if (SEQUENCIAS.some(seq => seq.includes(s) || (s.length >= 8 && seq.includes(s.slice(0, -1))) || (s.length >= 8 && seq.includes(s.slice(1))))) return true;
  // contém o próprio e-mail (parte antes do @) ou o nome
  for (const p of pessoais) {
    const base = String(p || '').toLowerCase().split('@')[0].normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
    if (base.length >= 4 && s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '').includes(base)) return true;
  }
  return false;
}

module.exports = { senhaComum };
