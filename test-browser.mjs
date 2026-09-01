// Smoke test opcional em Chromium real. A aplicação continua sem dependências em produção.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';

const raiz = import.meta.dirname;
const tipos = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const server = createServer(async (req, res) => {
  const nome = req.url === '/' ? 'index.html' : req.url.slice(1);
  if (!['index.html', 'config.js'].includes(nome)) {
    res.writeHead(404).end('not found');
    return;
  }
  try {
    const conteudo = await readFile(join(raiz, nome));
    res.writeHead(200, { 'content-type': tipos[extname(nome)] });
    res.end(conteudo);
  } catch {
    res.writeHead(404).end('not found');
  }
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endereco = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage();
  await page.route('https://bsky.social/xrpc/**', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname.split('/').pop();
    const json = body => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === 'app.bsky.actor.getProfile')
      return json({ did: 'did:plc:me', handle: 'eu.bsky.social', followersCount: 42, followsCount: 10 });
    if (path === 'app.bsky.feed.searchPosts')
      return json({ posts: [{
        uri: 'at://did:plc:a/app.bsky.feed.post/1', indexedAt: '2026-08-20T12:00:00Z',
        author: { did: 'did:plc:a', handle: 'a.bsky.social', displayName: 'Perfil A' },
        record: { text: 'post de teste' },
      }] });
    if (path === 'app.bsky.feed.searchPostsV2')
      return json({ posts: [{
        uri: 'at://did:plc:a/app.bsky.feed.post/2', indexedAt: new Date().toISOString(),
        author: { did: 'did:plc:a', handle: 'a.bsky.social', displayName: 'Perfil A' },
        record: { text: 'post recente em português', langs: ['pt'] },
      }] });
    if (path === 'app.bsky.actor.getProfiles')
      return json({ profiles: [{ did: 'did:plc:a', handle: 'a.bsky.social', displayName: 'Perfil A',
        followersCount: 100, followsCount: 50, viewer: {} }] });
    if (path === 'app.bsky.feed.getAuthorFeed')
      return json({ feed: [{ post: { indexedAt: '2026-08-20T12:00:00Z' } }] });
    if (path === 'com.atproto.repo.createRecord')
      return json({ uri: 'at://did:plc:me/app.bsky.graph.follow/novo' });
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });

  await page.goto(endereco);
  assert.equal(await page.locator('#login').isVisible(), true, 'sem sessão mostra o login');

  await page.evaluate(() => sessionStorage.setItem('bsky', JSON.stringify({
    'eu.bsky.social': { did: 'did:plc:me', handle: 'eu.bsky.social', accessJwt: 'a', refreshJwt: 'r' },
  })));
  await page.reload();
  assert.equal(await page.locator('#search').isVisible(), true, 'com sessão mostra a busca');
  assert.match(await page.locator('#ajudaModo').textContent(), /Procura o termo nos posts/);

  await page.locator('#q').fill('teste');
  await page.locator('#btnBuscar').click();
  await page.locator('#t tbody tr').waitFor();
  assert.equal(await page.locator('#t tbody tr').count(), 1, 'renderiza o resultado no DOM real');
  assert.equal(await page.locator('#followTodos').isVisible(), true, 'oferece follow em massa');

  page.once('dialog', dialog => dialog.accept());
  await page.locator('#followTodos').click();
  await page.waitForFunction(() => /1 seguidos/.test(document.querySelector('#status').textContent));
  assert.equal(await page.locator('#followTodos').isVisible(), false, 'confirma o follow concluído');
  console.log('ok browser - login, busca, render e follow em Chromium real');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
