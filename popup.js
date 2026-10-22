const STORAGE_KEY = "isx_items";

async function getItems() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return data[STORAGE_KEY] || [];
}

async function refreshCount() {
  const items = await getItems();
  document.getElementById("count").textContent = items.length;

  const posts = items.filter((i) => i.media_type === "post").length;
  const carousels = items.filter((i) => i.media_type === "carousel").length;
  const videos = items.filter((i) => i.media_type === "video" || i.media_type === "reel").length;
  const images = items.reduce(
    (acc, i) => acc + (i.media || []).filter((m) => m.type === "image").length,
    0
  );
  const videoFiles = items.reduce(
    (acc, i) => acc + (i.media || []).filter((m) => m.type === "video").length,
    0
  );
  document.getElementById("breakdown").textContent =
    `Posts: ${posts} · Carrosséis: ${carousels} · Vídeos/Reels: ${videos} · Imagens capturadas: ${images} · Vídeos capturados: ${videoFiles}`;
}

async function getActiveInstagramTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !tab.url.includes("/saved/")) {
    document.getElementById("status").textContent =
      "Abra a coleção de Salvos na aba ativa primeiro.";
    return null;
  }
  return tab;
}

document.getElementById("start").addEventListener("click", async () => {
  const tab = await getActiveInstagramTab();
  if (!tab) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "isx_start_scroll" });
    document.getElementById("status").textContent = "Rolando e capturando a grade...";
  } catch (e) {
    document.getElementById("status").textContent =
      "Sem conexão com a página — recarregue a aba do Instagram (F5) e tente de novo.";
  }
});

document.getElementById("stop").addEventListener("click", async () => {
  const tab = await getActiveInstagramTab();
  if (!tab) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "isx_stop_scroll" });
    document.getElementById("status").textContent = "Parado.";
  } catch (e) {
    document.getElementById("status").textContent =
      "Sem conexão com a página — recarregue a aba do Instagram (F5) e tente de novo.";
  }
});

document.getElementById("enrich").addEventListener("click", async () => {
  const items = await getItems();
  const targets = items
    .filter((i) => (i.media?.length || 0) <= 1)
    .map((i) => ({ shortcode: i.shortcode, url: i.url }));

  if (targets.length === 0) {
    document.getElementById("status").textContent = "Nada para enriquecer — tudo já tem mídia completa.";
    return;
  }

  chrome.runtime.sendMessage({ type: "isx_crawl_media", targets });
  document.getElementById("status").textContent = `Enriquecendo 0/${targets.length}...`;
});

document.getElementById("clear").addEventListener("click", async () => {
  await chrome.storage.local.set({ [STORAGE_KEY]: [], isx_debug_hrefs: [] });
  await refreshCount();
  document.getElementById("status").textContent = "Dados limpos.";
  document.getElementById("scanInfo").textContent = "";
  document.getElementById("debugList").textContent = "";
});

function toCsv(items) {
  const headers = [
    "shortcode", "url", "owner_username", "media_type", "media_count",
    "media_urls", "taken_at", "caption", "captured_at",
  ];
  const escape = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [headers.join(",")];
  for (const item of items) {
    const row = {
      ...item,
      media_count: item.media?.length || 0,
      media_urls: (item.media || []).map((m) => m.url).join(" | "),
    };
    lines.push(headers.map((h) => escape(row[h])).join(","));
  }
  return lines.join("\n");
}

function download(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename, saveAs: true }, () => {
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  });
}

document.getElementById("exportCsv").addEventListener("click", async () => {
  const items = await getItems();
  download(toCsv(items), "instagram_saved.csv", "text/csv");
});

document.getElementById("exportJson").addEventListener("click", async () => {
  const items = await getItems();
  download(JSON.stringify(items, null, 2), "instagram_saved.json", "application/json");
});

document.getElementById("downloadMedia").addEventListener("click", () => {
  document.getElementById("status").textContent = "Baixando...";
  chrome.runtime.sendMessage({ type: "isx_download_now" });
});

document.getElementById("runDiagnostic").addEventListener("click", async () => {
  const tab = await getActiveInstagramTab();
  if (!tab) return;
  document.getElementById("debugList").textContent = "Rodando diagnóstico...";
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "isx_run_diagnostic" });
  } catch (e) {
    document.getElementById("debugList").textContent =
      "Sem conexão com a página — recarregue a aba do Instagram (F5) e tente de novo.";
  }
});

async function renderDiagnostic() {
  const data = await chrome.storage.local.get("isx_full_diagnostic");
  const d = data.isx_full_diagnostic;
  const box = document.getElementById("debugList");
  if (!d) {
    box.textContent = "Ainda não rodou. Clique em \"Rodar diagnóstico completo\".";
    return;
  }
  const lines = [
    `<b>Página:</b> ${d.pathname}`,
    `<b>Total de &lt;a href&gt; na página:</b> ${d.totalAnchors}`,
    `<b>Elementos role=link/button:</b> ${d.roleElements}`,
    `<b>Links parecidos com post/reel:</b> ${d.suspects.length}`,
  ];
  if (d.suspects.length > 0) {
    lines.push("<b>Exemplos suspeitos:</b>");
    lines.push(...d.suspects.slice(0, 10).map((h) => `&nbsp;&nbsp;${h}`));
  }
  lines.push("<b>Amostra de hrefs únicos (até 40):</b>");
  lines.push(...d.uniqueHrefs.map((h) => `&nbsp;&nbsp;${h}`));
  box.innerHTML = lines.join("<br>");
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "isx_progress") {
    refreshCount();
    if (msg.added > 0) {
      document.getElementById("status").textContent = `+${msg.added} novos itens na grade`;
    }
  } else if (msg.type === "isx_page_detected") {
    document.getElementById("pageDetected").textContent = `Página detectada: ${msg.pathname}`;
  } else if (msg.type === "isx_scan_debug") {
    document.getElementById("scanInfo").textContent =
      `Última varredura: ${msg.totalAnchors} links na página, ${msg.matched} reconhecidos como post/reel.`;
  } else if (msg.type === "isx_full_diagnostic_ready") {
    renderDiagnostic();
  } else if (msg.type === "isx_download_progress") {
    document.getElementById("status").textContent = `Baixando ${msg.done}/${msg.total}...`;
  } else if (msg.type === "isx_download_done") {
    document.getElementById("status").textContent = `Concluído: ${msg.total} arquivos em Downloads/instagram_saved/`;
  } else if (msg.type === "isx_crawl_progress") {
    document.getElementById("status").textContent = `Enriquecendo ${msg.done}/${msg.total}...`;
    if (msg.remaining === 0) {
      document.getElementById("status").textContent = `Enriquecimento concluído (${msg.done} posts) — baixando arquivos...`;
      refreshCount();
    }
  }
});

document.getElementById("exportSqlLooks").addEventListener("click", async () => {
  const items = await getItems();
  if (items.length === 0) {
    document.getElementById("status").textContent = "Nenhum item capturado.";
    return;
  }

  let sql = "INSERT INTO pecas (nome, categoria, loja, codigo, possui) VALUES\n";

  const linhas = items.map((item, i) => {
    const nome = (item.caption || ("Peca " + (item.shortcode || i))).slice(0, 60).replace(/'/g, "''");
    const loja = (item.collection || "instagram").replace(/'/g, "''");
    const codigo = (item.shortcode || ("ig_" + i)).replace(/'/g, "''");
    return "('" + nome + "', 'roupa', '" + loja + "', '" + codigo + "', false)";
  });

  sql += linhas.join(",\n") + ";";

  const blob = new Blob([sql], { type: "text/sql" });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({
    url: url,
    filename: "pecas_looks.sql",
    saveAs: true
  });

  document.getElementById("status").textContent = "SQL gerado com " + items.length + " pecas!";
});

refreshCount();
renderDiagnostic();
