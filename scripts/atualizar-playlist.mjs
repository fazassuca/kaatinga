// Atualiza o arquivo faixas.json a partir da playlist do Spotify.
// Roda sozinho no GitHub Actions (veja LEIA-ME-atualizar-playlist.md). Precisa do Node 18 ou mais novo.
import { readFile, writeFile } from "node:fs/promises";

const PLAYLIST = process.env.SPOTIFY_PLAYLIST_ID || "0L4r6YgAUrz9LRHA4amnDM";
const { SPOTIFY_CLIENT_ID: id, SPOTIFY_CLIENT_SECRET: secret, SPOTIFY_REFRESH_TOKEN: refresh } = process.env;

if (!id || !secret || !refresh) {
  console.error("Faltam os segredos SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET e/ou SPOTIFY_REFRESH_TOKEN.");
  process.exit(1);
}

// 1) troca o refresh token por um token de acesso (em nome do dono da playlist)
const tk = await fetch("https://accounts.spotify.com/api/token", {
  method: "POST",
  headers: {
    Authorization: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"),
    "Content-Type": "application/x-www-form-urlencoded",
  },
  body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh }),
});
if (!tk.ok) {
  console.error("Spotify recusou o token:", tk.status, await tk.text());
  process.exit(1);
}
const { access_token } = await tk.json();

// 2) lê todas as faixas da playlist (50 por vez). Desde fev/2026 o endpoint é /items e só funciona para o dono da playlist.
const limpa = (n) => n.replace(/ - (Ao Vivo|Live)$/i, " ($1)");
const faixas = [];
let url = `https://api.spotify.com/v1/playlists/${PLAYLIST}/items?limit=50&additional_types=track`;
while (url) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${access_token}` } });
  if (!r.ok) {
    console.error("Erro ao ler a playlist:", r.status, await r.text());
    process.exit(1);
  }
  const j = await r.json();
  for (const it of j.items ?? []) {
    const t = it.item ?? it.track; // o nome do campo mudou em 2026; aceita os dois
    if (!t || !t.id || (t.type && t.type !== "track")) continue; // ignora episódios e arquivos locais
    const artistas = t.artists ?? [];
    faixas.push([
      limpa(t.name),
      artistas.map((a) => a.name).join(", "),
      t.album?.name ?? "",
      t.id,
      artistas[0]?.id ?? "",
      Math.round((t.duration_ms ?? 0) / 1000),
    ]);
  }
  url = j.next;
}

// 3) segurança: nunca apaga o site se vier uma lista quase vazia
if (faixas.length < 5) {
  console.error(`Só ${faixas.length} faixas encontradas; mantendo o faixas.json atual.`);
  process.exit(1);
}

const novo = JSON.stringify(faixas);
let atual = "";
try { atual = (await readFile("faixas.json", "utf8")).trim(); } catch {}
if (novo === atual) {
  console.log(`Sem mudanças (${faixas.length} faixas).`);
} else {
  await writeFile("faixas.json", novo + "\n");
  console.log(`faixas.json atualizado: ${faixas.length} faixas.`);
}
