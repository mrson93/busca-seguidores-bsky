// Testa a lógica do assistente manual do X (x-assistente.js) sem navegador.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import vm from 'node:vm';
import { detectAdultContent, detectBrazilianProfile } from './profile-policy.mjs';

const contexto = {};
vm.runInNewContext(readFileSync(join(import.meta.dirname, 'x-assistente.js'), 'utf8'), contexto);
const X = contexto.XAssistente;
const simples = valor => JSON.parse(JSON.stringify(valor));

// Texto como sai ao copiar a aba "Pessoas" de uma busca no X.
const COLADO = [
  'Página Inicial', 'Explorar', 'Pessoas',
  'Ana Promo', '@ana_promo', 'Seguir', 'Caço ofertas todo dia 🇧🇷',
  'Beto', '@beto', 'Seguindo', 'Cupons e descontos',
  'Carla', '@carla_pt', 'Seguir', 'Lisboa | ofertas',
  'Dani', '@dani', 'Segue você', 'Seguir de volta', 'conteúdo adulto 18+',
  'Edu', '@edu', 'Seguir', 'Promoções de games', 'e cupons',
  'Ana Promo', '@ana_promo', 'Seguir', 'repetida',
  'Termos de Serviço', '@naoperfil',
].join('\n');

// 1) lê nome, bio e quem você já segue, sem misturar o nome do próximo na bio
{
  const perfis = simples(X.lerPerfis(COLADO));
  assert.deepEqual(perfis.map(p => p.handle), ['ana_promo', 'beto', 'carla_pt', 'dani', 'edu']);
  assert.deepEqual(perfis[0], { handle: 'ana_promo', nome: 'Ana Promo', bio: 'Caço ofertas todo dia 🇧🇷', jaSegue: false });
  assert.equal(perfis[1].jaSegue, true);
  assert.equal(perfis[4].bio, 'Promoções de games e cupons');
  console.log('ok 1 - lê perfis da aba Pessoas e para no rodapé');
}

// 2) aplica as regras e põe brasileiros primeiro
{
  const r = simples(X.filtrar(COLADO));
  assert.deepEqual(r.aprovados.map(p => [p.handle, p.brasileiro]), [['ana_promo', true], ['edu', false]]);
  assert.deepEqual(r.descartados.map(p => [p.handle, p.motivo]), [
    ['beto', 'você já segue'], ['carla_pt', 'não parece brasileiro'], ['dani', 'conteúdo adulto'],
  ]);
  console.log('ok 2 - descarta quem você já segue, adulto e não brasileiro');
}

// 3) quem já foi aberto e a própria conta não voltam
{
  const r = simples(X.filtrar(COLADO, { eu: '@EDU', vistos: new Set(['ana_promo']) }));
  assert.equal(r.aprovados.length, 0);
  assert.equal(r.jaVistos, 1);
  assert.ok(r.descartados.some(p => p.handle === 'edu' && p.motivo === 'sua conta'));
  console.log('ok 3 - ignora perfis já abertos e a própria conta');
}

// 4) mesmas decisões das regras do Bluesky (profile-policy.mjs)
{
  const casos = [
    { handle: 'a', displayName: 'Fulano', description: 'NSFW only' },
    { handle: 'b', displayName: 'Loja', description: 'onlyfans.com/loja' },
    { handle: 'c', displayName: 'Maria 🇧🇷', description: 'mora em Lisboa' },
    { handle: 'd', displayName: 'João', description: 'Angola' },
    { handle: 'e.pt', displayName: 'E', description: '' },
    { handle: 'f', displayName: 'F', description: 'site loja.com.br/ofertas' },
    { handle: 'g', displayName: 'G', description: 'sem sinais' },
  ];
  for (const perfil of casos) {
    const adulto = detectAdultContent(perfil).adult;
    const pais = detectBrazilianProfile(perfil).status;
    const esperado = adulto ? { ok: false, motivo: 'conteúdo adulto' }
      : pais === 'brazilian' ? { ok: true, brasileiro: true }
      : pais === 'non_brazilian' ? { ok: false, motivo: 'não parece brasileiro' }
      : { ok: true, brasileiro: false };
    const obtido = X.avaliar({ handle: perfil.handle, nome: perfil.displayName, bio: perfil.description, jaSegue: false });
    assert.deepEqual(simples(obtido), esperado, `perfil ${perfil.handle}`);
  }
  console.log('ok 4 - regras iguais às do profile-policy.mjs');
}

// 5) busca abre a aba Pessoas do X
{
  assert.equal(X.urlBuscaPessoas(' promoção '), 'https://x.com/search?q=promo%C3%A7%C3%A3o&src=typed_query&f=user');
  assert.equal(X.urlPerfil('fulano'), 'https://x.com/fulano');
  console.log('ok 5 - monta URLs de busca e de perfil');
}

console.log('\ntodos passaram');
