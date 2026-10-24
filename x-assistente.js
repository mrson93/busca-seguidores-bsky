// Lógica do assistente manual do X: lê o texto copiado da aba "Pessoas" de uma busca
// no X e aplica as regras do canaltabarato que dá para checar sem a API.
// Script clássico (não módulo) para funcionar também abrindo o HTML direto do disco.
(function (raiz) {
  // Mesmas regras de texto de profile-policy.mjs (o teste compara as duas versões).
  const ADULT_TEXT = [
    /(?:^|\W)nsfw(?:\W|$)/iu,
    /🔞/u,
    /(?:^|\W)18\+(?:\W|$)/u,
    /(?:^|\W)(?:adult\s+content|conte[uú]do\s+adulto)(?:\W|$)/iu,
    /(?:^|\W)(?:nudes?|nudez)(?:\W|$)/iu,
    /(?:^|\W)porn(?:o|ô|ografia|ographic)?(?:\W|$)/iu,
    /(?:onlyfans\.com|fansly\.com|privacy\.com\.br)/iu,
  ];
  const BRAZIL_TEXT = [
    /🇧🇷/u,
    /(?:^|\W)(?:brasil|brazil|brasileir[ao]s?|brazilian)(?:\W|$)/iu,
    /(?:https?:\/\/)?(?:www\.)?[^\s/]+\.br(?:[\s/]|$)/iu,
  ];
  const NON_BRAZIL_TEXT = [
    /(?:🇵🇹|🇦🇴|🇲🇿|🇨🇻|🇬🇼|🇸🇹|🇹🇱)/u,
    /(?:^|\W)(?:portugal|portugu[eê]s(?:a|es|as)?\s+de\s+portugal|lisboa|lisbon)(?:\W|$)/iu,
    /(?:^|\W)(?:angola|angolan[ao]s?|mo[çc]ambique|mo[çc]ambican[ao]s?|cabo\s+verde|cabo-verdian[ao]s?)(?:\W|$)/iu,
    /(?:^|\W)(?:guin[eé]-?bissau|s[aã]o\s+tom[eé](?:\s+e\s+pr[ií]ncipe)?|timor-?leste)(?:\W|$)/iu,
  ];

  const HANDLE = /^\s*@([A-Za-z0-9_]{1,15})\s*$/u;
  // Botões e rótulos que o X coloca no meio de cada perfil ao copiar a página.
  const JA_SEGUE = /^(?:seguindo|following|deixar de seguir|unfollow)$/iu;
  const RUIDO = /^(?:seguir|follow|seguir de volta|follow back|segue você|follows you|verificado|verified|clique para seguir.*|click to follow.*)$/iu;
  // Rodapé da página: daqui em diante nada é perfil.
  const FIM = /^(?:termos de servi[çc]o|terms of service|pol[ií]tica de privacidade|privacy policy|©.*)$/iu;

  const contem = (padroes, valores) => valores
    .filter(valor => typeof valor === 'string')
    .some(valor => padroes.some(padrao => padrao.test(valor)));

  const normalizar = valor => String(valor ?? '').trim().replace(/^@/, '').toLowerCase();

  // Cada perfil copiado aparece como: nome, "@handle", botões, bio.
  function lerPerfis(texto) {
    const linhas = String(texto ?? '').split(/\r?\n/).map(linha => linha.trim());
    const perfis = [];
    let atual = null;
    let anterior = '';
    for (const linha of linhas) {
      if (FIM.test(linha)) break;
      const handle = linha.match(HANDLE);
      if (handle) {
        // A linha antes do @ era o nome do próximo perfil, não bio do anterior.
        if (atual && atual.bio.at(-1) === anterior) atual.bio.pop();
        atual = { handle: handle[1].toLowerCase(), nome: anterior, bio: [], jaSegue: false };
        perfis.push(atual);
      } else if (atual && JA_SEGUE.test(linha)) {
        atual.jaSegue = true;
      } else if (atual && linha && !RUIDO.test(linha)) {
        atual.bio.push(linha);
      }
      if (linha && !RUIDO.test(linha) && !JA_SEGUE.test(linha)) anterior = linha;
    }
    const unicos = new Map();
    for (const perfil of perfis) {
      if (unicos.has(perfil.handle)) continue;
      unicos.set(perfil.handle, { ...perfil, bio: perfil.bio.join(' ') });
    }
    return [...unicos.values()];
  }

  // Regras do canaltabarato que o texto permite checar. A regra dos 20% entre
  // seguidores e seguindo precisa dos números, que o X não mostra na lista.
  function avaliar(perfil, { eu = '' } = {}) {
    const valores = [perfil.handle, perfil.nome, perfil.bio];
    if (eu && perfil.handle === normalizar(eu)) return { ok: false, motivo: 'sua conta' };
    if (perfil.jaSegue) return { ok: false, motivo: 'você já segue' };
    if (contem(ADULT_TEXT, valores)) return { ok: false, motivo: 'conteúdo adulto' };
    if (contem(BRAZIL_TEXT, valores)) return { ok: true, brasileiro: true };
    if (contem(NON_BRAZIL_TEXT, valores) || /\.pt$/iu.test(perfil.handle))
      return { ok: false, motivo: 'não parece brasileiro' };
    return { ok: true, brasileiro: false };
  }

  function filtrar(texto, { eu = '', vistos = new Set() } = {}) {
    const aprovados = [];
    const descartados = [];
    let jaVistos = 0;
    for (const perfil of lerPerfis(texto)) {
      if (vistos.has(perfil.handle)) { jaVistos++; continue; }
      const resultado = avaliar(perfil, { eu });
      if (resultado.ok) aprovados.push({ ...perfil, brasileiro: resultado.brasileiro });
      else descartados.push({ ...perfil, motivo: resultado.motivo });
    }
    // Quem tem sinal claro de ser brasileiro aparece primeiro.
    aprovados.sort((a, b) => Number(b.brasileiro) - Number(a.brasileiro));
    return { aprovados, descartados, jaVistos };
  }

  const urlBuscaPessoas = termo =>
    `https://x.com/search?q=${encodeURIComponent(String(termo ?? '').trim())}&src=typed_query&f=user`;

  const urlPerfil = handle => `https://x.com/${encodeURIComponent(handle)}`;

  raiz.XAssistente = { lerPerfis, avaliar, filtrar, urlBuscaPessoas, urlPerfil, normalizar };
})(globalThis);
