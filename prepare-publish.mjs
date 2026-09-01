// Gera uma pasta de publicação que nunca copia o config.js local com credenciais.
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const raiz = import.meta.dirname;
const destino = join(raiz, 'dist');

rmSync(destino, { recursive: true, force: true });
mkdirSync(destino);
cpSync(join(raiz, 'index.html'), join(destino, 'index.html'));
writeFileSync(join(destino, 'config.js'), [
  '// Arquivo público e intencionalmente vazio.',
  '// Nunca substitua pelo config.js local, que pode conter app passwords.',
  'window.BSKY = [];',
  '',
].join('\n'));

console.log(`Publicação segura preparada em ${destino}`);
console.log('Envie somente o conteúdo dessa pasta para o serviço de hospedagem.');
