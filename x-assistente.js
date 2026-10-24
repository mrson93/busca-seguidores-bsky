// Lógica do assistente manual do X: extrai perfis de texto colado e controla a fila.
// Script clássico (não módulo) para funcionar também abrindo o HTML direto do disco.
(function (raiz) {
  // Caminhos de x.com que não são perfis.
  const RESERVADOS = new Set([
    'home', 'search', 'explore', 'i', 'intent', 'settings', 'messages', 'notifications',
    'hashtag', 'share', 'compose', 'login', 'logout', 'signup', 'tos', 'privacy', 'about',
    'jobs', 'download', 'premium', 'communities', 'lists', 'bookmarks', 'topics', 'account',
  ]);
  const HANDLE = '[A-Za-z0-9_]{1,15}';
  const LINHA_SOZINHA = new RegExp(`^\\s*@(${HANDLE})\\s*$`, 'u');
  const URL_PERFIL = new RegExp(`(?:https?://)?(?:www\\.|mobile\\.)?(?:x|twitter)\\.com/(${HANDLE})(?![A-Za-z0-9_])`, 'giu');
  const MENCAO = new RegExp(`(?:^|[^A-Za-z0-9_@/.])@(${HANDLE})(?![A-Za-z0-9_])`, 'gu');

  const normalizar = valor => String(valor ?? '').trim().replace(/^@/, '').toLowerCase();

  const valido = handle => new RegExp(`^${HANDLE}$`).test(handle) && !RESERVADOS.has(handle);

  // Ao copiar uma busca do X (Cmd/Ctrl+A, Cmd/Ctrl+C), o autor de cada post aparece
  // como "@handle" numa linha própria. Menções dentro do texto só entram se pedidas,
  // porque costumam ser outras pessoas, não quem postou.
  function extrairPerfis(texto, { incluirMencoes = false } = {}) {
    const vistos = new Set();
    const saida = [];
    const adicionar = bruto => {
      const handle = normalizar(bruto);
      if (!valido(handle) || vistos.has(handle)) return;
      vistos.add(handle);
      saida.push(handle);
    };
    for (const linha of String(texto ?? '').split(/\r?\n/)) {
      const sozinha = linha.match(LINHA_SOZINHA);
      if (sozinha) { adicionar(sozinha[1]); continue; }
      for (const m of linha.matchAll(URL_PERFIL)) adicionar(m[1]);
      if (incluirMencoes) for (const m of linha.matchAll(MENCAO)) adicionar(m[1]);
    }
    return saida;
  }

  const estadoVazio = () => ({ versao: 1, eu: '', limiteDiario: 40, fila: [], perfis: {} });

  function carregarEstado(bruto) {
    try {
      const dado = typeof bruto === 'string' ? JSON.parse(bruto) : bruto;
      if (!dado || typeof dado !== 'object') return estadoVazio();
      const limite = Number(dado.limiteDiario);
      return {
        versao: 1,
        eu: normalizar(dado.eu),
        limiteDiario: Number.isFinite(limite) && limite > 0 ? Math.floor(limite) : 40,
        fila: Array.isArray(dado.fila) ? dado.fila.map(normalizar).filter(valido) : [],
        perfis: dado.perfis && typeof dado.perfis === 'object' ? dado.perfis : {},
      };
    } catch {
      return estadoVazio();
    }
  }

  // Coloca na fila só quem ainda não foi visto, não é a própria conta e não está na fila.
  function adicionarNaFila(estado, handles) {
    const naFila = new Set(estado.fila);
    const resumo = { novos: 0, jaVistos: 0, jaNaFila: 0, propria: 0 };
    for (const handle of handles) {
      if (estado.eu && handle === estado.eu) resumo.propria++;
      else if (estado.perfis[handle]) resumo.jaVistos++;
      else if (naFila.has(handle)) resumo.jaNaFila++;
      else { estado.fila.push(handle); naFila.add(handle); resumo.novos++; }
    }
    return resumo;
  }

  function marcar(estado, handle, status, agora = new Date()) {
    estado.perfis[handle] = { status, em: agora.toISOString() };
    estado.fila = estado.fila.filter(item => item !== handle);
  }

  function desfazer(estado, handle) {
    if (!estado.perfis[handle]) return;
    delete estado.perfis[handle];
    if (!estado.fila.includes(handle)) estado.fila.unshift(handle);
  }

  const diaLocal = data => {
    const d = new Date(data);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  const seguidosHoje = (estado, agora = new Date()) => Object.values(estado.perfis)
    .filter(item => item.status === 'seguido' && diaLocal(item.em) === diaLocal(agora))
    .length;

  // Busca de posts recentes no próprio site do X; nada é consultado por esta página.
  function urlBusca(termo, { soPortugues = true } = {}) {
    const consulta = [String(termo ?? '').trim(), soPortugues ? 'lang:pt' : ''].filter(Boolean).join(' ');
    return `https://x.com/search?q=${encodeURIComponent(consulta)}&src=typed_query&f=live`;
  }

  const urlPerfil = handle => `https://x.com/${encodeURIComponent(handle)}`;

  raiz.XAssistente = {
    extrairPerfis, estadoVazio, carregarEstado, adicionarNaFila, marcar, desfazer,
    seguidosHoje, urlBusca, urlPerfil, normalizar,
  };
})(globalThis);
