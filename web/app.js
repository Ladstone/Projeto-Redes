/* ==========================================================================
   BVF · Bolsa de Valores Fictícia — lógica da interface web

   Como os dados chegam aqui:
     navegador --(HTTP/JSON)--> ponte_web.py --(TCP, protocolo BVF)--> servidor.py

   A página manda COMANDOS DO PROTOCOLO (LIST, BUY CAFE3 10...) para a ponte,
   que os repassa ao servidor e devolve as respostas (código + linhas).
   Este arquivo interpreta essas linhas de texto e desenha a tela.
   ========================================================================== */
"use strict";

const SALDO_INICIAL = 10000;
const INTERVALO_MS = 2000;
const $ = (seletor) => document.querySelector(seletor);

// ------------------------------------------------------------------ formatação
const formatoMoeda = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const brl = (v) => formatoMoeda.format(v);
const pct = (v) => (v > 0 ? "+" : "") + v.toFixed(2).replace(".", ",") + "%";
const lerBRL = (texto) => parseFloat(texto.replace(/\./g, "").replace(",", "."));
const esc = (t) => String(t).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const direcao = (v) => (v > 0.004 ? "sobe" : v < -0.004 ? "cai" : "");
const seta = (v) => (v > 0.004 ? "▲" : v < -0.004 ? "▼" : "•");
const chipVar = (v) => `<span class="variacao ${direcao(v)}">${seta(v)} ${pct(v)}</span>`;
const agora = () => new Date().toLocaleTimeString("pt-BR");

function guardar(chave, valor, armazenamento = sessionStorage) {
  try { valor === null ? armazenamento.removeItem(chave) : armazenamento.setItem(chave, valor); } catch (_) { /* sem storage */ }
}
function ler(chave, armazenamento = sessionStorage) {
  try { return armazenamento.getItem(chave); } catch (_) { return null; }
}

// ------------------------------------------------------------------ estado
const estado = {
  token: null,
  apelido: null,
  acoes: [],             // [{ticker, preco, variacao, empresa, abertura}] na ordem do servidor
  porTicker: {},
  historicos: {},        // ticker -> [{hora, preco}]
  carteira: { saldo: 0, posicoes: [], patrimonio: 0, variacao: 0 },
  ranking: [],
  noticiasVistas: new Set(),
  primeiraCarga: true,
  selecionada: null,
  lado: "BUY",
  timer: null,
  ocupado: false,
  parado: false,
  log: [],
  hoverIndice: null,
  geo: null,
};

/** Cor fixa de cada ação: segue a empresa (ordem do LIST), nunca o ranking. */
const corDe = (ticker) => `var(--s${(estado.acoes.findIndex((a) => a.ticker === ticker) % 6) + 1})`;
const textoSobreCor = (ticker) =>
  estado.acoes.findIndex((a) => a.ticker === ticker) % 6 === 3 ? "#0b0b0b" : "#fff";   // amarelo pede texto escuro

// ==================================================================
//  COMUNICAÇÃO COM A PONTE
// ==================================================================

async function api(rota, corpo) {
  const resposta = await fetch(rota, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corpo),
  });
  const dados = await resposta.json().catch(() => ({}));
  return { status: resposta.status, dados };
}

/** Envia uma lista de comandos do protocolo. Devolve {comando: {codigo, linhas}}. */
async function enviarComandos(lista, automatico = false) {
  const inicio = performance.now();
  let r;
  try {
    r = await api("/api/comandos", { token: estado.token, comandos: lista });
  } catch (_) {
    conexaoPerdida();
    return null;
  }
  if (r.status === 401 || r.status === 410) {
    conexaoPerdida();
    return null;
  }
  $("#latencia").textContent = `${Math.round(performance.now() - inicio)} ms`;
  const porComando = {};
  for (const item of r.dados.resultados || []) {
    registrar(item, automatico);
    porComando[item.comando] = item;
  }
  return porComando;
}

// ==================================================================
//  LEITURA DAS RESPOSTAS (texto do protocolo -> objetos)
// ==================================================================

const RE_ACAO      = /^(\S+)\s+R\$ ([\d.,]+)\s+([+-]\d+\.\d+)%\s+(.*)$/;
const RE_SALDO     = /^SALDO EM CAIXA: R\$ ([\d.,]+)/;
const RE_POSICAO   = /^(\S+)\s+(\d+) x R\$ ([\d.,]+)\s+= R\$ ([\d.,]+)/;
const RE_PATRIM    = /^PATRIMÔNIO TOTAL: R\$ ([\d.,]+) \(([+-][\d.]+)%\)/;
const RE_RANKING   = /^\s*(\d+)\.\s+(\S+)\s+R\$ ([\d.,]+)\s+\(([+-][\d.]+)%\)/;
const RE_NOTICIA   = /^\[(\d\d:\d\d:\d\d)\] (.*) \((\S+) ([+-]?[\d.]+)%\)$/;
const RE_HISTORICO = /^(\d\d:\d\d:\d\d) R\$ ([\d.,]+)$/;

function lerLista(linhas) {
  return linhas.slice(1).map((l) => l.match(RE_ACAO)).filter(Boolean).map((m) => {
    const preco = lerBRL(m[2]);
    const variacao = parseFloat(m[3]);
    return { ticker: m[1], preco, variacao, empresa: m[4], abertura: preco / (1 + variacao / 100) };
  });
}

function lerCarteira(linhas) {
  const c = { saldo: 0, posicoes: [], patrimonio: 0, variacao: 0 };
  for (const linha of linhas) {
    let m;
    if ((m = linha.match(RE_SALDO))) c.saldo = lerBRL(m[1]);
    else if ((m = linha.match(RE_POSICAO))) c.posicoes.push({ ticker: m[1], qtd: +m[2], preco: lerBRL(m[3]), valor: lerBRL(m[4]) });
    else if ((m = linha.match(RE_PATRIM))) { c.patrimonio = lerBRL(m[1]); c.variacao = parseFloat(m[2]); }
  }
  return c;
}

const lerRanking = (linhas) => linhas.slice(1).map((l) => l.match(RE_RANKING)).filter(Boolean)
  .map((m) => ({ posicao: +m[1], nome: m[2], patrimonio: lerBRL(m[3]), variacao: parseFloat(m[4]) }));

const lerNoticias = (linhas) => linhas.slice(1).map((l) => l.match(RE_NOTICIA)).filter(Boolean)
  .map((m) => ({ hora: m[1], texto: m[2], ticker: m[3], variacao: parseFloat(m[4]) }));

const lerHistorico = (linhas) => linhas.slice(1).map((l) => l.match(RE_HISTORICO)).filter(Boolean)
  .map((m) => ({ hora: m[1], preco: lerBRL(m[2]) }));

// ==================================================================
//  CICLO DE ATUALIZAÇÃO (o TCP é pedido -> resposta: a gente pergunta)
// ==================================================================

function agendar(ms) {
  clearTimeout(estado.timer);
  if (!estado.parado) estado.timer = setTimeout(ciclo, ms);
}

async function ciclo() {
  if (estado.ocupado || estado.parado) return;
  estado.ocupado = true;
  try {
    if (!estado.acoes.length) {
      const r = await enviarComandos(["LIST"], true);
      if (!r) return;
      aplicarLista(r.LIST);
    }
    const comandos = ["LIST", "PORTFOLIO", "RANKING", "NEWS", ...estado.acoes.map((a) => `HISTORY ${a.ticker}`)];
    const r = await enviarComandos(comandos, true);
    if (!r) return;

    aplicarLista(r.LIST);
    for (const a of estado.acoes) {
      const h = r[`HISTORY ${a.ticker}`];
      if (h && h.codigo === 216) estado.historicos[a.ticker] = lerHistorico(h.linhas);
    }
    estado.carteira = lerCarteira(r.PORTFOLIO.linhas);
    estado.ranking = lerRanking(r.RANKING.linhas);
    const noticias = lerNoticias(r.NEWS.linhas);

    desenharTudo(noticias);
    estado.primeiraCarga = false;
  } finally {
    estado.ocupado = false;
    agendar(INTERVALO_MS);
  }
}

function aplicarLista(resposta) {
  const anteriores = estado.porTicker;
  estado.acoes = lerLista(resposta.linhas);
  estado.porTicker = {};
  for (const a of estado.acoes) {
    a.anterior = anteriores[a.ticker]?.preco;
    estado.porTicker[a.ticker] = a;
  }
  if (!estado.selecionada && estado.acoes.length) estado.selecionada = estado.acoes[0].ticker;
}

function desenharTudo(noticias) {
  desenharFaixa();
  desenharMercado();
  desenharGrafico();
  desenharIndicadores();
  desenharBoleta();
  desenharCarteira();
  desenharRanking();
  desenharNoticias(noticias);
}

// ==================================================================
//  DESENHO DA TELA
// ==================================================================

function desenharFaixa() {
  const itens = estado.acoes.map((a) => `
    <div class="faixa-item">
      <strong>${a.ticker}</strong>
      <span class="faixa-preco">${brl(a.preco)}</span>
      ${chipVar(a.variacao)}
    </div>`).join("");
  $("#faixa").innerHTML = itens + itens;     // duas cópias = rolagem sem emenda
}

function iconeAtivo(ticker) {
  return `<span class="ativo-icone" style="background:${corDe(ticker)};color:${textoSobreCor(ticker)}">${ticker.slice(0, 2)}</span>`;
}

function desenharMercado() {
  const corpo = $("#mercado");
  const posicoes = Object.fromEntries(estado.carteira.posicoes.map((p) => [p.ticker, p.qtd]));
  for (const a of estado.acoes) {
    let linha = corpo.querySelector(`tr[data-ticker="${a.ticker}"]`);
    if (!linha) {
      linha = document.createElement("tr");
      linha.dataset.ticker = a.ticker;
      linha.innerHTML = `
        <td><div class="ativo">${iconeAtivo(a.ticker)}
          <div><div class="ativo-ticker">${a.ticker}</div><div class="ativo-nome">${esc(a.empresa)}</div></div></div></td>
        <td class="num"><span class="preco-celula"></span></td>
        <td class="num celula-var"></td>
        <td class="col-tendencia"><svg class="faisca" aria-hidden="true"></svg></td>
        <td class="num posicao-qtd"></td>
        <td><div class="acoes-linha">
          <button type="button" class="mini-btn comprar" data-lado="BUY">Comprar</button>
          <button type="button" class="mini-btn vender" data-lado="SELL">Vender</button>
        </div></td>`;
      linha.addEventListener("click", (e) => {
        const botao = e.target.closest(".mini-btn");
        selecionar(a.ticker, botao ? botao.dataset.lado : null);
      });
      corpo.appendChild(linha);
    }
    const celulaPreco = linha.querySelector(".preco-celula");
    celulaPreco.textContent = brl(a.preco);
    if (a.anterior !== undefined && a.anterior !== a.preco) {
      celulaPreco.classList.remove("flash-sobe", "flash-cai");
      void celulaPreco.offsetWidth;                       // reinicia a animação
      celulaPreco.classList.add(a.preco > a.anterior ? "flash-sobe" : "flash-cai");
      setTimeout(() => celulaPreco.classList.remove("flash-sobe", "flash-cai"), 60);
    }
    linha.querySelector(".celula-var").innerHTML = chipVar(a.variacao);
    linha.querySelector(".posicao-qtd").textContent = posicoes[a.ticker] ? `${posicoes[a.ticker]} ações` : "—";
    linha.classList.toggle("selecionada", a.ticker === estado.selecionada);
    desenharFaisca(linha.querySelector(".faisca"), estado.historicos[a.ticker] || [], corDe(a.ticker));
  }
}

function desenharFaisca(svg, pontos, cor) {
  const L = 120, A = 34, pad = 4;
  const ultimos = pontos.slice(-60);
  if (ultimos.length < 2) { svg.innerHTML = ""; return; }
  const precos = ultimos.map((p) => p.preco);
  const min = Math.min(...precos), max = Math.max(...precos), faixa = max - min || 1;
  const x = (i) => pad + (i * (L - 2 * pad)) / (ultimos.length - 1);
  const y = (v) => A - pad - ((v - min) / faixa) * (A - 2 * pad);
  const d = ultimos.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.preco).toFixed(1)}`).join("");
  const n = ultimos.length - 1;
  svg.setAttribute("viewBox", `0 0 ${L} ${A}`);
  svg.innerHTML = `
    <path d="${d}" style="fill:none;stroke:${cor};stroke-width:1.6;stroke-linejoin:round;stroke-linecap:round"/>
    <circle cx="${x(n)}" cy="${y(ultimos[n].preco)}" r="2.8" style="fill:${cor};stroke:var(--superficie);stroke-width:1.5"/>`;
}

// ------------------------------------------------------------------ gráfico principal

function passoBonito(bruto) {
  const exp = Math.pow(10, Math.floor(Math.log10(bruto)));
  const f = bruto / exp;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * exp;
}

function desenharGrafico() {
  const t = estado.selecionada;
  const a = estado.porTicker[t];
  if (!a) return;
  const pontos = estado.historicos[t] || [];
  const cor = corDe(t);

  $("#graf-ponto").style.background = cor;
  $("#graf-ticker").textContent = t;
  $("#graf-empresa").textContent = a.empresa;
  $("#graf-preco").textContent = brl(a.preco);
  $("#graf-var").outerHTML = `<span class="variacao ${direcao(a.variacao)}" id="graf-var">${seta(a.variacao)} ${pct(a.variacao)} hoje</span>`;
  $("#graf-abertura").textContent = brl(a.abertura);

  const svg = $("#grafico-svg");
  const L = svg.clientWidth, A = svg.clientHeight;
  if (pontos.length < 2 || !L) { svg.innerHTML = ""; return; }

  const precos = pontos.map((p) => p.preco);
  $("#graf-max").textContent = brl(Math.max(...precos));
  $("#graf-min").textContent = brl(Math.min(...precos));

  const m = { esq: 4, dir: 70, topo: 12, base: 28 };
  let min = Math.min(...precos, a.abertura), max = Math.max(...precos, a.abertura);
  const folga = (max - min) * 0.12 || 1;
  min -= folga; max += folga;
  const passo = passoBonito((max - min) / 4);
  const marcas = [];
  for (let v = Math.ceil(min / passo) * passo; v <= max; v += passo) marcas.push(v);

  const n = pontos.length - 1;
  const x = (i) => m.esq + (i * (L - m.esq - m.dir)) / n;
  const y = (v) => m.topo + ((max - v) / (max - min)) * (A - m.topo - m.base);
  const linha = pontos.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.preco).toFixed(1)}`).join("");
  const area = `${linha}L${x(n)},${A - m.base}L${x(0)},${A - m.base}Z`;

  const yUltimo = y(pontos[n].preco);
  const grade = marcas.map((v) => `
    <line x1="${m.esq}" x2="${L - m.dir}" y1="${y(v)}" y2="${y(v)}" style="stroke:var(--grade);stroke-width:1"/>
    ${Math.abs(y(v) - yUltimo) < 16 ? "" /* a etiqueta do preço atual ocupa este lugar */ :
      `<text class="eixo-texto" x="${L - m.dir + 10}" y="${y(v) + 4}">${brl(v)}</text>`}`).join("");

  const qtdRotulos = Math.max(2, Math.min(6, Math.floor((L - m.dir) / 110)));
  const rotulosX = Array.from({ length: qtdRotulos }, (_, k) => Math.round((k * n) / (qtdRotulos - 1)))
    .map((i, k) => {
      const ancora = k === 0 ? "start" : k === qtdRotulos - 1 ? "end" : "middle";
      return `<text class="eixo-texto" x="${x(i)}" y="${A - 8}" text-anchor="${ancora}">${pontos[i].hora.slice(0, 5)}</text>`;
    }).join("");

  const yAb = y(a.abertura);
  const ultimo = pontos[n];
  const corEtiqueta = textoSobreCor(t);

  svg.innerHTML = `
    <defs>
      <linearGradient id="grad-area" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" style="stop-color:${cor};stop-opacity:.20"/>
        <stop offset="100%" style="stop-color:${cor};stop-opacity:0"/>
      </linearGradient>
    </defs>
    ${grade}
    <line x1="${m.esq}" x2="${L - m.dir}" y1="${A - m.base}" y2="${A - m.base}" style="stroke:var(--eixo);stroke-width:1"/>
    <line x1="${m.esq}" x2="${L - m.dir}" y1="${yAb}" y2="${yAb}" style="stroke:var(--tinta-3);stroke-width:1;opacity:.6"/>
    <text class="eixo-texto" x="${m.esq + 4}" y="${yAb - 6}">abertura</text>
    <path d="${area}" style="fill:url(#grad-area)"/>
    <path d="${linha}" style="fill:none;stroke:${cor};stroke-width:2;stroke-linejoin:round;stroke-linecap:round"/>
    <circle cx="${x(n)}" cy="${y(ultimo.preco)}" r="4.5" style="fill:${cor};stroke:var(--superficie);stroke-width:2"/>
    <g transform="translate(${L - m.dir + 4},${y(ultimo.preco) - 11})">
      <rect width="${m.dir - 4}" height="22" rx="5" style="fill:${cor}"/>
      <text x="${(m.dir - 4) / 2}" y="15" text-anchor="middle" style="fill:${corEtiqueta};font-size:11px;font-weight:700;font-variant-numeric:tabular-nums">${brl(ultimo.preco).replace("R$", "").trim()}</text>
    </g>
    ${rotulosX}
    <g id="graf-hover" style="display:none">
      <line id="hv-linha" y1="${m.topo}" y2="${A - m.base}" style="stroke:var(--tinta-3);stroke-width:1"/>
      <circle id="hv-ponto" r="5" style="fill:${cor};stroke:var(--superficie);stroke-width:2"/>
    </g>
    <rect id="graf-captura" x="${m.esq}" y="0" width="${L - m.esq - m.dir}" height="${A}" style="fill:transparent;cursor:crosshair"/>`;

  estado.geo = { x, y, pontos, n, esq: m.esq, largura: L - m.esq - m.dir };
  const captura = $("#graf-captura");
  captura.addEventListener("pointermove", (e) => {
    const caixa = svg.getBoundingClientRect();
    const g = estado.geo;
    const i = Math.max(0, Math.min(g.n, Math.round(((e.clientX - caixa.left - g.esq) / g.largura) * g.n)));
    mostrarHover(i);
  });
  captura.addEventListener("pointerleave", esconderHover);
  if (estado.hoverIndice !== null) mostrarHover(Math.min(estado.hoverIndice, n));
}

function mostrarHover(i) {
  const g = estado.geo;
  if (!g) return;
  estado.hoverIndice = i;
  const p = g.pontos[i];
  const px = g.x(i), py = g.y(p.preco);
  $("#graf-hover").style.display = "";
  $("#hv-linha").setAttribute("x1", px);
  $("#hv-linha").setAttribute("x2", px);
  $("#hv-ponto").setAttribute("cx", px);
  $("#hv-ponto").setAttribute("cy", py);
  const dica = $("#grafico-dica");
  const abertura = estado.porTicker[estado.selecionada].abertura;
  dica.innerHTML = `<strong>${brl(p.preco)}</strong><span>${p.hora} · ${pct((p.preco / abertura - 1) * 100)} vs abertura</span>`;
  dica.style.left = `${px}px`;
  dica.style.top = `${py}px`;
  dica.hidden = false;
}

function esconderHover() {
  estado.hoverIndice = null;
  const g = $("#graf-hover");
  if (g) g.style.display = "none";
  $("#grafico-dica").hidden = true;
}

// ------------------------------------------------------------------ indicadores

function desenharIndicadores() {
  const c = estado.carteira;
  const investido = c.posicoes.reduce((s, p) => s + p.valor, 0);
  const lucro = c.patrimonio - SALDO_INICIAL;
  $("#ind-patrimonio").textContent = brl(c.patrimonio);
  $("#ind-patrimonio-delta").innerHTML =
    `${chipVar(c.variacao)} <span class="${direcao(c.variacao) === "sobe" ? "texto-sobe" : direcao(c.variacao) === "cai" ? "texto-cai" : ""}">${lucro >= 0 ? "+" : "−"}${brl(Math.abs(lucro))}</span>
     <span style="color:var(--tinta-3);font-weight:500">desde o início</span>`;
  $("#ind-saldo").textContent = brl(c.saldo);
  $("#ind-investido").textContent = brl(investido);
  $("#ind-investido-extra").textContent = c.posicoes.length
    ? `${c.posicoes.length} ${c.posicoes.length === 1 ? "ação diferente" : "ações diferentes"} · ${((investido / c.patrimonio) * 100 || 0).toFixed(0)}% do patrimônio`
    : "nenhuma posição ainda";
  const eu = estado.ranking.find((r) => r.nome === estado.apelido);
  $("#ind-ranking").textContent = eu ? `${eu.posicao}º lugar` : "fora do top 10";
  $("#ind-ranking-extra").textContent = `${estado.ranking.length} ${estado.ranking.length === 1 ? "investidor" : "investidores"} no ranking`;
}

// ------------------------------------------------------------------ boleta

function selecionar(ticker, lado) {
  estado.selecionada = ticker;
  $("#ord-ticker").value = ticker;
  if (lado) mudarLado(lado);
  esconderHover();
  desenharMercado();
  desenharGrafico();
  desenharBoleta();
  if (lado) {
    if (window.innerWidth < 1180) $("#boleta").scrollIntoView({ behavior: "smooth", block: "center" });
    $("#ord-qtd").focus();
    $("#ord-qtd").select();
  }
}

function mudarLado(lado) {
  estado.lado = lado;
  document.querySelectorAll(".aba-ordem").forEach((b) => {
    const ativa = b.dataset.lado === lado;
    b.classList.toggle("ativa", ativa);
    b.setAttribute("aria-selected", ativa);
  });
  desenharBoleta();
}

function quantidadeMaxima() {
  const a = estado.porTicker[$("#ord-ticker").value];
  if (!a) return 0;
  if (estado.lado === "BUY") return Math.floor(estado.carteira.saldo / a.preco);
  return estado.carteira.posicoes.find((p) => p.ticker === a.ticker)?.qtd || 0;
}

function desenharBoleta() {
  const seletor = $("#ord-ticker");
  if (seletor.options.length !== estado.acoes.length) {
    seletor.innerHTML = estado.acoes.map((a) => `<option value="${a.ticker}">${a.ticker} · ${esc(a.empresa)}</option>`).join("");
  }
  if (estado.selecionada) seletor.value = estado.selecionada;
  const a = estado.porTicker[seletor.value];
  if (!a) return;

  const qtdTexto = $("#ord-qtd").value.trim();
  const qtd = parseInt(qtdTexto, 10) || 0;
  const total = qtd * a.preco;
  const comprando = estado.lado === "BUY";
  const temAcoes = estado.carteira.posicoes.find((p) => p.ticker === a.ticker)?.qtd || 0;

  $("#ord-preco").textContent = brl(a.preco);
  $("#ord-disp-rotulo").textContent = comprando ? "Saldo disponível" : "Você tem";
  $("#ord-disp").textContent = comprando ? brl(estado.carteira.saldo) : `${temAcoes} ações`;
  $("#ord-total").textContent = brl(total);

  const comando = `${estado.lado} ${a.ticker} ${qtdTexto || "?"}`;
  $("#ord-comando").textContent = comando;
  const botao = $("#ord-enviar");
  botao.className = `btn btn-largo ${comprando ? "btn-comprar" : "btn-vender"}`;
  botao.textContent = `${comprando ? "Comprar" : "Vender"} ${qtd || ""} ${a.ticker}`.replace(/\s+/g, " ");

  let aviso = "";
  if (comprando && total > estado.carteira.saldo) aviso = "Saldo insuficiente: se enviar, o servidor vai recusar com o código 402.";
  if (!comprando && qtd > temAcoes) aviso = `Você só tem ${temAcoes} ações de ${a.ticker}: o servidor vai recusar com o código 403.`;
  $("#ord-aviso").textContent = aviso;
  $("#ord-aviso").hidden = !aviso;
}

async function enviarOrdem() {
  const comando = $("#ord-comando").textContent;
  const botao = $("#ord-enviar");
  botao.disabled = true;
  const r = await enviarComandos([comando]);
  botao.disabled = false;
  if (!r) return;
  const { codigo, linhas } = r[comando];
  const ok = codigo >= 200 && codigo < 300;
  notificar(ok ? "ok" : "erro",
    ok ? (estado.lado === "BUY" ? "Compra executada" : "Venda executada") : `Ordem recusada · ${codigo}`,
    linhas[0], comando);
  agendar(0);
}

// ------------------------------------------------------------------ carteira

function desenharCarteira() {
  const c = estado.carteira;
  const total = c.patrimonio || 1;
  const larguraBarra = $("#alocacao").clientWidth || 300;
  const partes = estado.acoes
    .map((a) => c.posicoes.find((p) => p.ticker === a.ticker))
    .filter(Boolean)
    .map((p) => ({ nome: p.ticker, valor: p.valor, cor: corDe(p.ticker), texto: textoSobreCor(p.ticker) }));
  partes.push({ nome: "Caixa", valor: c.saldo, cor: "var(--caixa)", texto: "var(--tinta)" });

  $("#alocacao").innerHTML = partes.filter((p) => p.valor > 0).map((p) => {
    const fatia = p.valor / total;
    const rotulo = fatia * larguraBarra > 44 ? `${Math.round(fatia * 100)}%` : "";
    return `<div class="alocacao-parte" style="flex-grow:${p.valor};background:${p.cor};color:${p.texto}"
      title="${p.nome}: ${brl(p.valor)} (${(fatia * 100).toFixed(1)}%)">${rotulo}</div>`;
  }).join("");
  $("#alocacao").setAttribute("aria-label",
    "Distribuição do patrimônio: " + partes.map((p) => `${p.nome} ${((p.valor / total) * 100).toFixed(1)}%`).join(", "));
  $("#alocacao-legenda").innerHTML = partes.filter((p) => p.valor > 0)
    .map((p) => `<li><i style="background:${p.cor}"></i>${p.nome}</li>`).join("");
  $("#cart-total").textContent = brl(c.patrimonio);

  $("#posicoes").innerHTML = c.posicoes.length
    ? c.posicoes.map((p) => `
      <li>
        ${iconeAtivo(p.ticker)}
        <span class="pos-ticker">${p.ticker}</span>
        <span class="pos-valor">${brl(p.valor)}</span>
        <span class="pos-qtd">${p.qtd} ações · ${brl(p.preco)}</span>
        <span class="pos-peso">${((p.valor / total) * 100).toFixed(1)}% do total</span>
      </li>`).join("")
    : `<li class="vazio" style="display:block">Você ainda não tem ações.<br>Use a boleta acima para fazer sua primeira compra.</li>`;
}

// ------------------------------------------------------------------ ranking

function desenharRanking() {
  const medalhas = ["ouro", "prata", "bronze"];
  $("#rank-total").textContent = `${estado.ranking.length} no top 10`;
  $("#ranking").innerHTML = estado.ranking.map((r) => `
    <li class="${r.nome === estado.apelido ? "eu" : ""}">
      <span class="rank-pos ${medalhas[r.posicao - 1] || ""}">${r.posicao}</span>
      <span class="rank-nome">${esc(r.nome)}${r.nome === estado.apelido ? "<small>você</small>" : ""}</span>
      <span class="rank-valor">${brl(r.patrimonio)}<small class="${direcao(r.variacao) === "sobe" ? "texto-sobe" : direcao(r.variacao) === "cai" ? "texto-cai" : ""}">${seta(r.variacao)} ${pct(r.variacao)}</small></span>
    </li>`).join("");
}

// ------------------------------------------------------------------ notícias

function desenharNoticias(noticias) {
  const lista = $("#noticias");
  if (!noticias.length) {
    lista.innerHTML = `<li class="vazio" style="display:block">Nenhuma notícia ainda.<br>Elas aparecem a qualquer momento e mexem nos preços.</li>`;
    return;
  }
  const novas = [];
  lista.innerHTML = noticias.map((n) => {
    const chave = n.hora + n.texto;
    const nova = !estado.noticiasVistas.has(chave);
    if (nova) { estado.noticiasVistas.add(chave); novas.push(n); }
    return `
      <li class="${nova && !estado.primeiraCarga ? "nova" : ""}">
        <span class="noticia-texto">${esc(n.texto)}</span>
        <span class="noticia-meta">${n.hora} · <span class="noticia-tag">${n.ticker}</span> ${chipVar(n.variacao)}</span>
      </li>`;
  }).join("");
  if (!estado.primeiraCarga) {
    for (const n of novas) notificar("info", `Notícia · ${n.ticker} ${seta(n.variacao)} ${pct(n.variacao)}`, n.texto);
  }
}

// ------------------------------------------------------------------ notificações

function notificar(tipo, titulo, texto, comando) {
  const icones = { ok: "✓", erro: "!", info: "i" };
  const el = document.createElement("div");
  el.className = `notificacao ${tipo}`;
  el.innerHTML = `
    <span class="notificacao-icone">${icones[tipo]}</span>
    <span class="notificacao-titulo">${esc(titulo)}</span>
    <span class="notificacao-texto">${esc(texto)}${comando ? `<br><code>${esc(comando)}</code>` : ""}</span>`;
  $("#notificacoes").prepend(el);
  setTimeout(() => { el.classList.add("saindo"); setTimeout(() => el.remove(), 300); }, tipo === "info" ? 6000 : 4500);
  const todas = $("#notificacoes").children;
  while (todas.length > 4) todas[todas.length - 1].remove();
}

// ==================================================================
//  CONSOLE DO PROTOCOLO
// ==================================================================

function registrar(item, automatico) {
  estado.log.push({ ...item, automatico, hora: agora() });
  if (estado.log.length > 400) estado.log.splice(0, estado.log.length - 400);
  if (!automatico) $("#console-contador").textContent = estado.log.filter((l) => !l.automatico).length;
  if (!$("#console").hidden && (!automatico || $("#console-auto").checked)) {
    escreverNoConsole(item, estado.log[estado.log.length - 1].hora);
  }
}

function escreverNoConsole(item, hora) {
  const corpo = $("#console-corpo");
  const perto = corpo.scrollHeight - corpo.scrollTop - corpo.clientHeight < 40;
  const erro = item.codigo >= 400;
  let html = "";
  if (item.comando !== null) {
    html += `<div class="msg msg-c"><span class="msg-hora">${hora}</span><span class="msg-dir">→</span><span class="msg-texto">${esc(item.comando)}</span></div>`;
  }
  item.linhas.forEach((linha, i) => {
    const sep = i === item.linhas.length - 1 ? " " : "-";
    html += `<div class="msg msg-s ${erro ? "msg-erro" : "msg-ok"}"><span class="msg-hora">${i === 0 ? hora : ""}</span><span class="msg-dir">${i === 0 ? "←" : ""}</span><span class="msg-texto"><span class="msg-cod">${item.codigo}${sep}</span>${esc(linha)}</span></div>`;
  });
  corpo.insertAdjacentHTML("beforeend", html + `<div class="msg-separador"></div>`);
  if (perto) corpo.scrollTop = corpo.scrollHeight;
}

function redesenharConsole() {
  const corpo = $("#console-corpo");
  corpo.innerHTML = "";
  const mostrarAuto = $("#console-auto").checked;
  estado.log.filter((l) => mostrarAuto || !l.automatico).slice(-150).forEach((l) => escreverNoConsole(l, l.hora));
  corpo.scrollTop = corpo.scrollHeight;
}

function alternarConsole(abrir) {
  const consoleEl = $("#console");
  consoleEl.hidden = !abrir;
  $("#btn-console").setAttribute("aria-expanded", abrir);
  if (abrir) { redesenharConsole(); $("#console-input").focus(); }
}

// ==================================================================
//  LOGIN, SESSÃO E TEMA
// ==================================================================

function desenharOndaLogin() {
  const svg = $("#login-onda");
  const L = 1200, A = 300;
  let v = 150;
  const pts = Array.from({ length: 90 }, (_, i) => {
    v += (Math.random() - 0.46) * 18;
    v = Math.max(40, Math.min(260, v));
    return [(i / 89) * L, A - v];
  });
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
  svg.setAttribute("viewBox", `0 0 ${L} ${A}`);
  svg.innerHTML = `
    <defs><linearGradient id="g-login" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" style="stop-color:var(--acento);stop-opacity:.35"/>
      <stop offset="100%" style="stop-color:var(--acento);stop-opacity:0"/></linearGradient></defs>
    <path d="${d}L${L},${A}L0,${A}Z" style="fill:url(#g-login)"/>
    <path d="${d}" style="fill:none;stroke:var(--acento);stroke-width:2.5;vector-effect:non-scaling-stroke"/>`;
}

async function entrar(evento) {
  evento.preventDefault();
  const apelido = $("#inp-apelido").value.trim();
  const erro = $("#login-erro");
  const botao = $("#btn-entrar");
  erro.hidden = true;
  botao.disabled = true;
  try {
    const r = await api("/api/entrar", { apelido });
    if (r.status !== 200) throw new Error(r.dados.erro || "Falha ao falar com a ponte.");
    const ultimo = r.dados.trafego[r.dados.trafego.length - 1];
    if (!r.dados.token) {
      erro.innerHTML = `<code>${ultimo.codigo}</code> ${esc(ultimo.linhas[0])}`;
      erro.hidden = false;
      return;
    }
    estado.token = r.dados.token;
    estado.apelido = apelido;
    guardar("bvf-token", estado.token);
    guardar("bvf-apelido", apelido);
    r.dados.trafego.forEach((item) => registrar(item, false));
    iniciarApp();
    notificar("ok", `Bem-vindo, ${apelido}!`, ultimo.linhas[0], `HELLO ${apelido}`);
  } catch (e) {
    erro.textContent = e.message === "Failed to fetch" ? "A ponte web não está respondendo." : e.message;
    erro.hidden = false;
  } finally {
    botao.disabled = false;
  }
}

function iniciarApp() {
  $("#tela-login").hidden = true;
  $("#tela-app").hidden = false;
  $("#usuario-nome").textContent = estado.apelido;
  $("#avatar").textContent = estado.apelido.slice(0, 1);
  estado.parado = false;
  agendar(0);
}

async function retomarSessao() {
  const token = ler("bvf-token");
  const apelido = ler("bvf-apelido");
  if (!token || !apelido) return false;
  try {
    const r = await api("/api/comandos", { token, comandos: [] });
    if (r.status !== 200) throw new Error();
  } catch (_) {
    guardar("bvf-token", null);
    return false;
  }
  estado.token = token;
  estado.apelido = apelido;
  iniciarApp();
  return true;
}

function conexaoPerdida() {
  estado.parado = true;
  clearTimeout(estado.timer);
  guardar("bvf-token", null);
  $("#caiu").hidden = false;
}

async function sair() {
  estado.parado = true;
  try { await api("/api/sair", { token: estado.token }); } catch (_) { /* tanto faz */ }
  guardar("bvf-token", null);
  location.reload();
}

function aplicarTema(tema) {
  document.documentElement.dataset.theme = tema;
  guardar("bvf-tema", tema, localStorage);
}

// ==================================================================
//  EVENTOS
// ==================================================================

function ligarEventos() {
  $("#form-login").addEventListener("submit", entrar);
  $("#btn-sair").addEventListener("click", sair);
  $("#btn-reconectar").addEventListener("click", () => location.reload());
  $("#btn-tema").addEventListener("click", () =>
    aplicarTema(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));

  document.querySelectorAll(".aba-ordem").forEach((b) => b.addEventListener("click", () => mudarLado(b.dataset.lado)));
  $("#ord-ticker").addEventListener("change", (e) => selecionar(e.target.value));
  $("#ord-qtd").addEventListener("input", desenharBoleta);
  $("#ord-qtd").addEventListener("keydown", (e) => { if (e.key === "Enter") enviarOrdem(); });
  document.querySelectorAll(".passo-btn").forEach((b) => b.addEventListener("click", () => {
    const campo = $("#ord-qtd");
    campo.value = Math.max(1, (parseInt(campo.value, 10) || 0) + parseInt(b.dataset.delta, 10));
    desenharBoleta();
  }));
  document.querySelectorAll(".atalho").forEach((b) => b.addEventListener("click", () => {
    $("#ord-qtd").value = b.dataset.qtd === "max" ? Math.max(1, quantidadeMaxima()) : b.dataset.qtd;
    desenharBoleta();
  }));
  $("#ord-enviar").addEventListener("click", enviarOrdem);

  $("#btn-console").addEventListener("click", () => alternarConsole($("#console").hidden));
  $("#console-fechar").addEventListener("click", () => alternarConsole(false));
  $("#console-limpar").addEventListener("click", () => { estado.log = []; redesenharConsole(); $("#console-contador").textContent = "0"; });
  $("#console-auto").addEventListener("change", redesenharConsole);
  $("#console-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const campo = $("#console-input");
    const comando = campo.value.trim();
    if (!comando) return;
    campo.value = "";
    await enviarComandos([comando]);
    agendar(0);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#console").hidden) alternarConsole(false);
  });

  let espera;
  window.addEventListener("resize", () => {
    clearTimeout(espera);
    espera = setTimeout(() => { desenharGrafico(); desenharCarteira(); }, 120);
  });

  setInterval(() => { $("#relogio").textContent = agora(); }, 1000);
}

// ==================================================================
//  INÍCIO
// ==================================================================

(async function iniciar() {
  aplicarTema(ler("bvf-tema", localStorage) || "dark");
  ligarEventos();
  desenharOndaLogin();
  $("#relogio").textContent = agora();
  fetch("/api/info").then((r) => r.json()).then((d) => { $("#login-servidor").textContent = d.servidor; }).catch(() => {});
  if (!(await retomarSessao())) $("#inp-apelido").focus();
})();
