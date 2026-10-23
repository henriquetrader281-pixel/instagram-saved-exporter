// Roda em qualquer página /p/<shortcode>/ ou /reel/<shortcode>/ que a
// extensão abra em segundo plano durante o "enriquecimento" de mídia.
// Não usa nenhum endpoint interno: clica no botão "avançar" do próprio
// carrossel e lê a imagem/vídeo que o Instagram efetivamente exibe.

(async function () {
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  async function resolveMediaUrl(rawUrl) {
    if (!rawUrl || !rawUrl.startsWith("blob:")) return rawUrl;
    try {
      const res = await fetch(rawUrl);
      const blob = await res.blob();
      return await blobToDataUrl(blob);
    } catch (e) {
      return null;
    }
  }

  function findMainContainer() {
    return document.querySelector("article") || document.body;
  }

  async function captureCurrent(media, seen) {
    const root = findMainContainer();

    const video = root.querySelector("video");
    if (video && video.src && !seen.has(video.src)) {
      seen.add(video.src);
      const resolved = await resolveMediaUrl(video.src);
      if (resolved) media.push({ type: "video", url: resolved });
      return true;
    }

    const imgs = Array.from(root.querySelectorAll("img"));
    for (const img of imgs) {
      if (img.naturalWidth >= 300 && img.src && !seen.has(img.src)) {
        seen.add(img.src);
        const resolved = await resolveMediaUrl(img.src);
        if (resolved) media.push({ type: "image", url: resolved });
        return true;
      }
    }
    return false;
  }

  function findNextButton() {
    const selectors = [
      'button[aria-label="Avançar"]',
      'button[aria-label="Próxima"]',
      'button[aria-label="Next"]',
    ];
    for (const sel of selectors) {
      const btn = document.querySelector(sel);
      if (btn) return btn;
    }
    return null;
  }

  function captureCaption() {
    const root = findMainContainer();
    const candidates = Array.from(
      root.querySelectorAll('span[dir="auto"], div[dir="auto"], h1')
    );
    for (const el of candidates) {
      const text = (el.textContent || "").trim();
      if (text.length > 15) return text.slice(0, 2000);
    }
    return "";
  }

  await sleep(1800);

  const media = [];
  const seen = new Set();

  await captureCurrent(media, seen);

  for (let i = 0; i < 12; i++) {
    const nextBtn = findNextButton();
    if (!nextBtn) break;
    nextBtn.click();
    await sleep(700 + Math.random() * 400);
    await captureCurrent(media, seen);
  }

  const caption = captureCaption();
  const match = location.pathname.match(/^\/(p|reel)\/([A-Za-z0-9_-]+)/);
  const shortcode = match ? match[2] : null;

  if (shortcode) {
    chrome.runtime
      .sendMessage({ type: "isx_post_media", shortcode, media, caption })
      .catch(() => {});
  }
})();
