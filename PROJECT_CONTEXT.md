# Contexto do projeto — `busca-seguidores-bsky`

Este arquivo é um guia rápido para qualquer pessoa ou IA que precise entender,
operar ou alterar o projeto. Ele descreve o estado conhecido em **17/09/2026**.

> **Segurança:** este documento não contém handles secretos, app passwords,
> tokens, cookies ou valores de Secrets do GitHub/Cloudflare. Nunca registre esses
> valores em arquivos versionados.

## 1. Objetivo

O projeto tem duas partes:

1. Uma página estática para pesquisar perfis no Bluesky e seguir/deixar de seguir
   manualmente.
2. Uma rotina periódica no GitHub Actions, disparada por um Cloudflare Worker,
   que faz follow e unfollow automáticos de forma limitada e auditável.

O projeto não tem servidor de produção para a página. O arquivo principal da
interface é `index.html`.

## 2. Contas e escopo

### Conta principal

- É identificada pelos Secrets `BSKY_HANDLE` e `BSKY_APP_PASSWORD`.
- O handle atual informado pelo proprietário é `canaltabarato.com.br`.
- A rotina principal usa diferença máxima de **20%** entre seguidores e seguindo,
  configurada no workflow.
- Há **3 dias de carência** antes de remover alguém que não segue de volta.
- A limpeza de registros antigos está habilitada.
- Perfis sem post ou repost detectável nos últimos **365 dias** entram na fila de
  unfollow, em lotes de até 100 perfis avaliados por execução.

### Segunda conta temática

- É identificada pelos Secrets `SECONDARY_BSKY_HANDLE` e
  `SECONDARY_BSKY_APP_PASSWORD`.
- A rotina só executa se os dois Secrets existirem; caso contrário, é ignorada
  sem interromper a conta principal.
- O filtro de equilíbrio é de **20%**.
- Os termos atuais são: `filme`, `filmes`, `cinema`, `série`, `séries`,
  `seriado`, `seriados`.
- A busca usa publicações em português e até 5 páginas por termo.
- O estado da segunda conta é separado em `.auto-follow-state-secondary.json`.

## 3. Fluxo de execução por hora

1. O Worker `busca-seguidores-bsky-scheduler` roda no minuto 17 de cada hora
   (`17 * * * *`).
2. O Worker chama a API do GitHub para disparar `.github/workflows/auto-follow.yml`
   na branch `main`.
3. O workflow impede execuções sobrepostas com o grupo `auto-follow-bsky`.
4. Para cada conta configurada:
   - restaura o estado persistente do cache do Actions;
   - executa o unfollow;
   - executa o follow;
   - salva novamente o estado, mesmo quando há falhas.
5. O workflow também pode ser iniciado manualmente pelo GitHub Actions.

O Worker usa no Cloudflare o Secret `GITHUB_TOKEN`, restrito ao disparo de Actions.
As credenciais do Bluesky ficam somente nos Secrets do GitHub.

## 4. Follow automático

Arquivo: `auto-follow.mjs`.

Comportamento padrão do código:

- procura posts em português dos últimos 60 minutos;
- pagina a busca até 20 páginas;
- consolida autores repetidos e ordena pelo post mais recente;
- exclui a própria conta, perfis já seguidos, bloqueados e bloqueadores;
- aceita apenas perfis dentro da proporção configurada entre seguidores e seguindo;
- limita cada execução a no máximo 50 follows (o workflow não altera o limite
  padrão de 30);
- espera aleatoriamente de 10 a 30 segundos entre follows;
- verifica conteúdo adulto e sinais fortes de país antes de seguir;
- se a verificação falhar, o perfil é rejeitado (fail closed);
- registra o resultado em `auto-follow-history.jsonl`, ignorado pelo Git.

Variáveis disponíveis:

| Variável | Padrão | Uso |
|---|---:|---|
| `AUTO_FOLLOW_HANDLE` | primeira conta | escolhe uma conta local específica |
| `AUTO_FOLLOW_WINDOW_MINUTES` | `60` | janela de busca |
| `AUTO_FOLLOW_RATIO_PCT` | `20` | diferença máxima seguidores/seguindo |
| `AUTO_FOLLOW_MAX_FOLLOWS` | `30` | limite de follows |
| `AUTO_FOLLOW_MAX_PAGES` | `20` | limite de páginas |
| `AUTO_FOLLOW_SEARCH_TERMS` | vazio | termos separados por vírgula |
| `AUTO_FOLLOW_STATE_FILE` | `.auto-follow-state.json` | arquivo de estado |

O workflow principal e o workflow da segunda conta sobrescrevem
`AUTO_FOLLOW_RATIO_PCT=20`.

Comandos locais:

```bash
npm run auto-follow:dry-run   # simula, não segue ninguém
npm run auto-follow            # executa follows
```

## 5. Unfollow automático

Arquivo: `auto-unfollow.mjs`.

Os follows são lidos dos registros do repositório da conta e ordenados do mais
antigo para o mais recente. A execução remove até 50 perfis por rodada, eliminando
todos os registros duplicados encontrados para a mesma pessoa.

Um perfil pode entrar na fila por um ou mais motivos:

- não segue a conta de volta, respeitada a carência configurada;
- conteúdo adulto detectado;
- sinal forte de que não é brasileiro;
- registro antigo que não aparece mais como relação ativa (`stale_follow_record`);
- nenhuma atividade (post ou repost) nos últimos 365 dias (`inactive_1y`).

Depois de apagar, o código confirma pela API que o perfil realmente deixou de ser
seguido. Falhas ficam registradas e não são tratadas como sucesso.

Parâmetros usados no workflow principal:

| Variável | Valor |
|---|---:|
| `AUTO_UNFOLLOW_GRACE_DAYS` | `3` |
| `AUTO_UNFOLLOW_CLEAN_STALE_RECORDS` | `true` |
| `AUTO_UNFOLLOW_INACTIVITY_DAYS` | `365` |
| `AUTO_UNFOLLOW_ACTIVITY_SCAN_LIMIT` | `100` |

Parâmetros padrão do código:

| Variável | Padrão |
|---|---:|
| `AUTO_UNFOLLOW_MAX_UNFOLLOWS` | `50` |
| `AUTO_UNFOLLOW_MAX_PAGES` | `300` |
| `AUTO_UNFOLLOW_POLICY_SCAN_LIMIT` | `100` |
| `AUTO_UNFOLLOW_POLICY_REVIEW_DAYS` | `30` |
| `AUTO_UNFOLLOW_CLEAN_STALE_RECORDS` | `false` |
| `AUTO_UNFOLLOW_INACTIVITY_DAYS` | `0` (desligado fora do workflow) |
| `AUTO_UNFOLLOW_ACTIVITY_SCAN_LIMIT` | `100` |

Comandos locais:

```bash
npm run auto-unfollow:dry-run   # simula, não remove follows
npm run auto-unfollow            # executa unfollows
```

## 6. Políticas de conteúdo e país

Arquivo: `profile-policy.mjs`.

### Conteúdo adulto

São considerados os rótulos `porn`, `sexual` e `nudity`, além de sinais textuais
em bio, nome, handle, posts e links externos (por exemplo, `NSFW`, `🔞`, nudez e
plataformas adultas). A detecção é conservadora e não garante identificar tudo.

### País/idioma

O Bluesky não fornece nacionalidade. A classificação usa sinais públicos:

- Brasil: `🇧🇷`, Brasil/Brazil, domínios `.br` e idioma `pt-BR`;
- outros países lusófonos: bandeiras, nomes de países, domínio `.pt` e idioma
  `pt-PT`.

Um sinal brasileiro tem prioridade. Sem evidência suficiente, o perfil fica como
`unknown` e é mantido.

## 7. Estado, histórico e privacidade

- `.auto-follow-state.json`: estado persistente de perfis removidos e revisões.
- `.auto-follow-state-secondary.json`: estado equivalente da segunda conta.
- `auto-follow-history.jsonl`: histórico local de follows.
- `auto-unfollow-history.jsonl`: histórico local de unfollows.
- Arquivos de estado e histórico são ignorados pelo Git e não devem ser publicados.
- O estado contém DIDs, handles, datas e classificações; não contém credenciais.
- Os logs públicos do Actions mostram contagens agregadas, não a lista de handles
  processados.
- O cache inicial deve existir para evitar que o follow automático refaça um follow
  removido recentemente. Se a migração estiver ausente, o workflow interrompe essa
  etapa por segurança.

## 8. Interface web

`index.html` permite os modos:

- quem postou;
- posts recentes em português;
- seguidores de um perfil;
- bio contém;
- sigo, mas não me seguem.

Todos os modos têm filtros de seguidores, seguindo, diferença percentual, data do
último post e limite de resultados. A interface permite follow/unfollow manual,
individual ou em massa.

Para uso local, copie `config.example.js` para `config.js` e preencha com uma app
password do Bluesky. O arquivo é ignorado pelo Git. A sessão da página fica no
`sessionStorage` e é apagada ao fechar a aba.

Para publicar, execute `node prepare-publish.mjs` e envie somente o conteúdo de
`dist/`. Nunca publique `config.js` com credenciais.

## 9. X — plano de assistente manual (ainda não implementado)

Foi avaliada a possibilidade de uma rotina equivalente para o X usando a API oficial.
O desenho aprovado é **assistência manual**, sem follow/unfollow automático:

- pesquisar posts recentes por termos, hashtags, idioma e outros operadores;
- trazer autor, avatar, bio, seguidores, seguindo e data do post;
- aplicar filtros e ordenação parecidos com os do Bluesky;
- mostrar um botão `Abrir no X / Seguir manualmente` ao lado do perfil;
- o botão abre o perfil em `x.com/usuario`; a confirmação do follow é feita pelo
  usuário no próprio X.

A busca recente do X cobre os últimos 7 dias. Histórico completo depende do nível de
  acesso contratado. Para pesquisa pública será necessário um token de leitura de um
  aplicativo do X; para exibir se a conta já segue alguém, será necessária autenticação
  adicional da conta. Não colocar tokens no chat nem no repositório.

O Buffer continua relacionado a publicação/agendamento e não substitui a API do X
para pesquisa ou relacionamentos.

## 10. Testes e comandos úteis

```bash
npm test                         # teste de boot da interface
npm run test:auto-follow         # testes do follow
npm run test:auto-unfollow       # testes do unfollow
pnpm test:scheduler              # testes do Worker
pnpm typecheck:scheduler         # checagem TypeScript do Worker
npm run test:browser             # smoke test opcional em Chromium
npm run prepare:publish          # gera pacote público limpo
```

O smoke test do navegador requer Chromium instalado pelo Playwright. As dependências
são de desenvolvimento; o pacote publicado continua estático.

## 11. Arquivos principais

| Arquivo | Responsabilidade |
|---|---|
| `index.html` | interface web e chamadas da API do Bluesky |
| `auto-follow.mjs` | descoberta, filtros e follow automático |
| `auto-unfollow.mjs` | análise, fila e remoção de follows |
| `profile-policy.mjs` | filtros de conteúdo adulto e país |
| `prepare-publish.mjs` | criação do pacote público seguro |
| `.github/workflows/auto-follow.yml` | execução horária das duas contas |
| `cloudflare-scheduler/src/index.ts` | disparo do workflow via Cloudflare |
| `wrangler.jsonc` | cron, variáveis e observabilidade do Worker |
| `config.example.js` | modelo de configuração local, sem segredo |
| `test-*.mjs` | testes da interface e das rotinas |

## 12. Histórico recente de mudanças

- `7e79ebb` — adiciona unfollow de perfis sem atividade por um ano.
- `aa441bb` — aplica limites atuais à conta principal.
- `892eda2` — melhora carência e limpeza de follows antigos.
- `a701283` — adiciona rotina temática para a segunda conta.
- `f06694e` — amplia a proporção do follow automático para 20%.
- `2d303dd` — corrige fila de unfollows sem reciprocidade.
- `99a0318` — adiciona filtros de conteúdo adulto e perfis não brasileiros.

## 13. Cuidados para futuras alterações

1. Nunca commitar credenciais ou copiar Secrets para este arquivo.
2. Sempre testar primeiro em dry-run quando mudar critérios de follow/unfollow.
3. Preservar os arquivos de estado e a migração do cache; perder o estado pode
   causar refollows indesejados.
4. Manter a confirmação pós-unfollow e a carência de reciprocidade.
5. Se alterar a conta, atualizar o Secret correspondente, não hardcodar o handle.
6. Ao alterar a rotina horária, verificar simultaneamente o workflow, o cron do
   Worker, o grupo de concorrência e os testes.
7. Qualquer integração com o X deve permanecer manual-assistida e respeitar as
   regras atuais da plataforma.
