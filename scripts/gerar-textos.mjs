// Escreve, com a ajuda do Claude (IA da Anthropic), os textos de artistas e faixas que ainda não têm texto.
// Roda no GitHub Actions logo depois de atualizar-playlist.mjs. Precisa do segredo ANTHROPIC_API_KEY.
// Regras: nunca sobrescreve texto escrito à mão ("ia": false). Só mexe no que falta (ou em textos de IA, se REFAZER_IA=true).
import { readFile, writeFile } from "node:fs/promises";

const KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY) {
  console.log("ANTHROPIC_API_KEY ausente: pulando a escrita dos textos.");
  process.exit(0);
}
const MODELO = process.env.MODELO_IA || "claude-sonnet-5-5";
const LIMITE = parseInt(process.env.LIMITE_ARTISTAS || "10", 10); // artistas por execução (controla o custo)
const REFAZER = process.env.REFAZER_IA === "true";
const hoje = new Date().toISOString().slice(0, 10);
const nz = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

const faixas = JSON.parse(await readFile("faixas.json", "utf8"));
let tx = { versao: 1, artistas: {}, faixas: {}, semResposta: {} };
try { tx = { ...tx, ...JSON.parse(await readFile("textos.json", "utf8")) }; } catch {}
tx.artistas ||= {}; tx.faixas ||= {}; tx.semResposta ||= {};
const achaArtista = (nome) => Object.keys(tx.artistas).find((k) => nz(k) === nz(nome));

// 1) agrupa as faixas pelo primeiro artista e descobre o que falta
const grupos = new Map();
for (const [titulo, artistas, album, id] of faixas) {
  const nome = artistas.split(", ")[0];
  const g = grupos.get(nz(nome)) ?? { nome, faixas: [] };
  g.faixas.push({ id, titulo, album, artistas });
  grupos.set(nz(nome), g);
}
const pendentes = [];
for (const g of grupos.values()) {
  const chave = achaArtista(g.nome);
  const faltaArtista = !chave || (REFAZER && tx.artistas[chave].ia);
  const faltam = g.faixas.filter((f) => !tx.faixas[f.id] || (REFAZER && tx.faixas[f.id].ia));
  if (!faltaArtista && !faltam.length) continue;
  const tentou = tx.semResposta[nz(g.nome)];
  if (!REFAZER && faltaArtista && tentou && Date.now() - Date.parse(tentou) < 14 * 864e5) continue; // sem informação: tenta de novo depois de 14 dias
  pendentes.push({ g, faltaArtista, faltam });
}
console.log(`${pendentes.length} artista(s) com texto pendente; processando até ${LIMITE}.`);

// 2) instruções (tom do projeto) + exemplos escritos à mão
const exArt = Object.entries(tx.artistas).filter(([, v]) => !v.ia && v.pt && v.en).slice(0, 3);
const exFx = Object.values(tx.faixas).filter((v) => !v.ia && v.pt && v.en).slice(0, 3);
const SISTEMA = `Você escreve os textos curtos da "Galeria Sonora do Nordeste", projeto que associa som e imagem numa experiência sensorial do que é crescer, viver, amadurecer e conviver nos nove estados do Nordeste do Brasil. O projeto trata de pluralidade, sensorialidade e memória e se opõe aos preconceitos históricos contra a região.

Regras:
1. Escreva em português do Brasil (pt) e em inglês (en), com o mesmo conteúdo.
2. Texto do artista: 45 a 75 palavras. Diga quem é, de onde vem e o que faz, apenas com fatos que você confirmou em fontes públicas (use a busca na web). Para grupos e mestres da tradição oral, valorize o saber como algo vivo.
3. Contexto da canção: 30 a 55 palavras. Explique o assunto da música e conecte com a cultura, a história ou os desafios do Nordeste (seca e água, migração, caatinga e meio ambiente, trabalho, desigualdade, preconceito, tradição oral, festas e religiosidade popular), mas só quando a canção realmente trata disso. Se for instrumental ou você não conseguir confirmar o assunto, fale da forma musical, do instrumento ou do gênero. Se nem isso der para confirmar, use null.
4. Nunca reproduza nem cite trechos de letras. Parafraseie o tema com suas palavras.
5. Não invente. Se não confirmar um dado (ano, cidade, parceria, prêmio), deixe de fora. Se não houver informação confiável sobre o artista, devolva null para o artista.
6. Evite caricatura e clichê ("povo sofrido", "exótico", "folclórico" como sinônimo de parado no tempo). Tom sóbrio, caloroso e informativo, sem superlativos que você não possa sustentar.
7. Responda SOMENTE com um objeto JSON, sem texto antes nem depois.

Exemplos do tom e do tamanho (escritos pela equipe do projeto):
${exArt.map(([n, v]) => `- Artista ${n}: pt="${v.pt}" en="${v.en}"`).join("\n")}
${exFx.map((v) => `- Contexto de canção: pt="${v.pt}" en="${v.en}"`).join("\n")}`;

// 3) chamada à API (com busca na web); continua se o servidor pedir mais uma rodada (pause_turn)
async function pergunta(usuario) {
  let msgs = [{ role: "user", content: usuario }];
  for (let k = 0; k < 4; k++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: MODELO, max_tokens: 4000, system: SISTEMA, messages: msgs,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
      }),
    });
    if (!r.ok) { const e = new Error(`API ${r.status}: ${(await r.text()).slice(0, 300)}`); e.status = r.status; throw e; }
    const j = await r.json();
    if (j.stop_reason === "pause_turn") { msgs = [...msgs, { role: "assistant", content: j.content }]; continue; }
    return j.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  }
  throw new Error("Resposta incompleta (pause_turn).");
}
const extraiJson = (t) => { const a = t.indexOf("{"), b = t.lastIndexOf("}"); if (a < 0 || b < a) throw new Error("Sem JSON na resposta."); return JSON.parse(t.slice(a, b + 1)); };
const limpa = (t, max) => {
  if (typeof t !== "string") return "";
  const x = t.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  return x.length >= 20 && x.length <= max ? x : "";
};
const par = (o, max) => (o && limpa(o.pt, max) && limpa(o.en, max) ? { pt: limpa(o.pt, max), en: limpa(o.en, max) } : null);

// 4) processa um artista por vez e salva a cada passo
let feitos = 0;
for (const { g, faltaArtista, faltam } of pendentes.slice(0, LIMITE)) {
  const lista = g.faixas.map((f, k) => `${k + 1}. id=${f.id} | título="${f.titulo}" | álbum="${f.album}" | artistas="${f.artistas}"`).join("\n");
  const pedido = `Artista principal: ${g.nome}
Faixas da playlist (use exatamente estes ids como chaves):
${lista}

Pedido: ${faltaArtista ? "texto do artista; " : "NÃO escreva o texto do artista; "}contexto apenas para os ids: ${faltam.map((f) => f.id).join(", ") || "(nenhum)"}.
Formato: {"artista":{"pt":"...","en":"..."} ou null,"faixas":{"<id>":{"pt":"...","en":"..."} ou null}}
Inclua "artista" somente se foi pedido e inclua em "faixas" somente os ids pedidos.`;
  try {
    const j = extraiJson(await pergunta(pedido));
    if (faltaArtista) {
      const a = par(j.artista, 800);
      const chave = achaArtista(g.nome) ?? g.nome;
      if (a) { tx.artistas[chave] = { ...a, ia: true, data: hoje }; delete tx.semResposta[nz(g.nome)]; }
      else tx.semResposta[nz(g.nome)] = hoje;
    }
    for (const f of faltam) {
      const c = par(j.faixas?.[f.id], 700);
      tx.faixas[f.id] = c ? { ...c, ia: true, data: hoje } : { pt: "", en: "", ia: true, vazio: true, data: hoje };
    }
    feitos++;
    console.log(`ok: ${g.nome}`);
  } catch (e) {
    console.error(`falhou: ${g.nome}: ${e.message}`);
    if (e.status === 401 || e.status === 403) { console.error("Chave da API recusada; parando."); process.exitCode = 1; break; }
  }
  await writeFile("textos.json", JSON.stringify(tx, null, 1) + "\n");
  await new Promise((r) => setTimeout(r, 1500));
}
console.log(`Concluído: ${feitos} artista(s) processado(s).`);
