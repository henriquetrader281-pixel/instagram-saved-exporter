// Roda só em páginas /saved/*. Não depende de interceptar rede — lê
// diretamente os links e miniaturas que o Instagram já renderizou na
// tela. Isso garante que só entra no dataset o que está realmente
// visível dentro da coleção de Salvos que você abriu.

const STORAGE_KEY = "isx_items";
const DEBUG_KEY = "isx_debug_hrefs";
const SHORTCODE_RE = /(?:^|\/)(p|reel)\/([A-Za-z0-9_-]{5,})/;

let scrolling = false;
let scrollTimer = null;
let scanTimer = null;
let observer = null;

function extractShortcode(href) {
  const m = (href || "").match(SHORTCODE_RE);
  return m ? { kind: m[1], shortcode: m[2] } : null;
}

async function logDebugHref(href) {
  if (!href) return;
  const data = await chrome.storage.local.get(DEBUG_KEY);
  const list = data[DEBUG_KEY] || [];
  if (list.includes(href)) return;
  list.push(href);
  if (list.length > 40) list.shift();
  await chrome.storage.local.set({ [DEBUG_KEY]: list });
}

async function runFullDiagnostic() {
  const anchors = Array.from(document.querySelectorAll("a[href]"));
  const hrefs = anchors.map((a) => a.getAttribute("href") || "");
  const uniqueHrefs = [...new Set(hrefs)].slice(0, 40);
  const suspects = [...new Set(hrefs)].filter((h) => /\/(p|reel)\//.test(h));
  const roleElements = document.querySelectorAll('[role="link"], [role="button"]').length;

  await chrome.storage.local.set({
    isx_full_diagnostic: {
      totalAnchors: anchors.length,
      uniqueHrefs,
      suspects,
      roleElements,
      pathname: location.pathname,
      checked_at: new Date().toISOString(),
    },
  });

  chrome.runtime
    .sendMessage({
      type: "isx_full_diagnostic_ready",
      totalAnchors: anchors.length,
      suspectsCount: suspects.length,
      roleElements,
    })
    .catch(() => {});
}

function detectTypeFromLabels(root) {
  const labels = Array.from(root.querySelectorAll("svg[aria-label]"))
    .map((s) => (s.getAttribute("aria-label") || "").toLowerCase())
    .join(" ");
  if (/carross|carousel|álbum|album/.test(labels)) return "carousel";
  if (/vídeo|video|clipe|reel/.test(labels)) return "video";
  return null;
}

function bestImageUrl(anchor) {
  const img = anchor.querySelector("img");
  if (!img) return "";
  const srcset = img.getAttribute("srcset");
  if (srcset) {
    const candidates = srcset.split(",").map((s) => s.trim().split(" ")[0]);
    if (candidates.length) return candidates[candidates.length - 1];
  }
  return img.src || "";
}

function extractCollectionName() {
  const m = location.pathname.match(/\/saved\/([^/]+)/);
  return m ? decodeURIComponent(m[1]) : "salvos";
}

function extractOwnerFromHref(href) {
  const m = (href || "").match(/^\/([A-Za-z0-9_.]+)\/(?:p|reel)\//);
  return m ? m[1] : "";
}

function scanGrid() {
  if (!location.pathname.includes("/saved/")) return;

  const collection = extractCollectionName();
  const anchors = document.querySelectorAll("a[href]");
  const found = new Map();
  let matched = 0;

  for (const a of anchors) {
    const rawHref = a.getAttribute("href") || "";
    const absHref = a.href || "";
    let parsed = extractShortcode(rawHref);
    if (!parsed) parsed = extractShortcode(absHref);

    if (!parsed) {
      logDebugHref(rawHref || absHref);
      continue;
    }
    matched++;

    const thumb = bestImageUrl(a);
    const labelType = detectTypeFromLabels(a);
    const mediaType = labelType || (parsed.kind === "reel" ? "reel" : "post");
    const owner = extractOwnerFromHref(rawHref) || extractOwnerFromHref(absHref);

    found.set(parsed.shortcode, {
      shortcode: parsed.shortcode,
      kind: parsed.kind,
      url: `https://www.instagram.com/${parsed.kind}/${parsed.shortcode}/`,
      owner_username: owner,
      collection,
      media_type: mediaType,
      media: thumb ? [{ type: "image", url: thumb }] : [],
      taken_at: null,
      caption: "",
      captured_at: new Date().toISOString(),
    });
  }

  chrome.runtime
    .sendMessage({ type: "isx_scan_debug", totalAnchors: anchors.length, matched })
    .catch(() => {});

  if (found.size > 0) saveItems(found);
}

async function saveItems(newItemsMap) {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const existing = data[STORAGE_KEY] || [];
  const byShortcode = new Map(existing.map((i) => [i.shortcode, i]));

  let added = 0;
  let changed = false;
  for (const [shortcode, item] of newItemsMap) {
    const prev = byShortcode.get(shortcode);
    if (!prev) {
      byShortcode.set(shortcode, item);
      added++;
      changed = true;
    }
  }

  if (changed) {
    await chrome.storage.local.set({ [STORAGE_KEY]: Array.from(byShortcode.values()) });
    chrome.runtime.sendMessage({ type: "isx_progress", added }).catch(() => {});
  }
}

function startScrolling() {
  if (scrolling) return;
  scrolling = true;
  chrome.runtime
    .sendMessage({ type: "isx_page_detected", pathname: location.pathname })
    .catch(() => {});
  scanGrid();
  scanTimer = setInterval(scanGrid, 1500);

  if (!observer) {
    observer = new MutationObserver(() => scanGrid());
    observer.observe(document.body, { childList: true, subtree: true });
  }

  const step = () => {
    if (!scrolling) return;
    window.scrollBy(0, window.innerHeight * 0.8);
    const delay = 1800 + Math.random() * 1400;
    scrollTimer = setTimeout(step, delay);
  };
  step();
}

function stopScrolling() {
  scrolling = false;
  if (scrollTimer) clearTimeout(scrollTimer);
  if (scanTimer) clearInterval(scanTimer);
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  scanGrid();
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "isx_start_scroll") {
    startScrolling();
    sendResponse({ ok: true });
  } else if (msg.type === "isx_stop_scroll") {
    stopScrolling();
    sendResponse({ ok: true });
  } else if (msg.type === "isx_run_diagnostic") {
    runFullDiagnostic();
    sendResponse({ ok: true });
  }
  return true;
});

scanGrid();
