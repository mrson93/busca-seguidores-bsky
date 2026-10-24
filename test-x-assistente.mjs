// Testa a lógica do assistente manual do X (x-assistente.js) sem navegador.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import vm from 'node:vm';

const contexto = {};
vm.runInNewContext(readFileSync(join(import.meta.dirname, 'x-assistente.js'), 'utf8'), contexto);
const X = contexto.XAssistente;
const lista = valor => [...valor];

// 1) texto copiado de uma busca do X: autores em linha própria, menções ignoradas
{
  const colado = [
    'Maria Silva', '@MariaSilva', '·', '2 min',
    'Olha essa promoção @lojaX e @outra', '12', '3',
    'João', '@joao_123', '·', '5 min', 'texto qualquer',
    'Maria Silva', '@mariasilva', '·', '9 min',
  ].join('\n');
  assert.deepEqual(lista(X.extrairPerfis(colado)), ['mariasilva', 'joao_123']);
  assert.deepEqual(lista(X.extrairPerfis(colado, { incluirMencoes: true })),
    ['mariasilva', 'lojax', 'outra', 'joao_123']);
  console.log('ok 1 - extrai autores e só inclui menções quando pedido');
}

// 2) links de perfil, caminhos reservados e e-mails
{
  const colado = [
    'https://x.com/Fulano', 'twitter.com/ciclano/status/123', 'https://x.com/search?q=oi',
    'https://x.com/home', 'https://x.com/i/flow/login', 'contato@empresa.com.br',
    'nomecomprido_demais_para_x', '@abc',
  ].join('\n');
  assert.deepEqual(lista(X.extrairPerfis(colado, { incluirMencoes: true })), ['fulano', 'ciclano', 'abc']);
  console.log('ok 2 - aceita links de perfil e ignora páginas do X e e-mails');
}

// 3) fila não repete vistos, a própria conta nem quem já está nela
{
  const estado = X.estadoVazio();
  estado.eu = 'eu';
  X.marcar(estado, 'antigo', 'pulado');
  const r = X.adicionarNaFila(estado, ['a', 'eu', 'antigo', 'b', 'a']);
  assert.deepEqual({ ...r }, { novos: 2, jaVistos: 1, jaNaFila: 1, propria: 1 });
  assert.deepEqual(lista(estado.fila), ['a', 'b']);
  console.log('ok 3 - fila ignora repetidos, vistos e a própria conta');
}

// 4) marcar tira da fila, conta o dia e desfazer devolve ao início
{
  const estado = X.estadoVazio();
  X.adicionarNaFila(estado, ['a', 'b', 'c']);
  const agora = new Date(2026, 9, 23, 15);
  X.marcar(estado, 'a', 'seguido', agora);
  X.marcar(estado, 'b', 'seguido', new Date(2026, 9, 22, 15));
  X.marcar(estado, 'c', 'pulado', agora);
  assert.equal(estado.fila.length, 0);
  assert.equal(X.seguidosHoje(estado, agora), 1, 'só conta follows do dia');
  X.desfazer(estado, 'c');
  assert.deepEqual(lista(estado.fila), ['c']);
  assert.equal(estado.perfis.c, undefined);
  console.log('ok 4 - marca, conta follows do dia e desfaz');
}

// 5) estado salvo inválido ou parcial não quebra a página
{
  assert.deepEqual(JSON.parse(JSON.stringify(X.carregarEstado('{quebrado'))), JSON.parse(JSON.stringify(X.estadoVazio())));
  const parcial = X.carregarEstado(JSON.stringify({ eu: '@Eu', limiteDiario: -3, fila: ['@Ok', 'home', 'x y'] }));
  assert.equal(parcial.eu, 'eu');
  assert.equal(parcial.limiteDiario, 40);
  assert.deepEqual(lista(parcial.fila), ['ok']);
  console.log('ok 5 - carrega estado inválido ou parcial com segurança');
}

// 6) busca abre o site do X com filtro de idioma
{
  assert.equal(X.urlBusca(' promoção ', { soPortugues: true }),
    'https://x.com/search?q=promo%C3%A7%C3%A3o%20lang%3Apt&src=typed_query&f=live');
  assert.equal(X.urlBusca('#ofertas', { soPortugues: false }),
    'https://x.com/search?q=%23ofertas&src=typed_query&f=live');
  assert.equal(X.urlPerfil('fulano'), 'https://x.com/fulano');
  console.log('ok 6 - monta URLs de busca e de perfil');
}

console.log('\ntodos passaram');
