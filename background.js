const STORAGE_KEY = "isx_items";
const QUEUE_KEY = "isx_crawl_queue";
const DOWNLOADED_KEY = "isx_downloaded_map";
const KEEPALIVE_ALARM = "isx_keepalive";

let queue = [];
let processing = false;

let pendingShortcode = null;
let pendingResolve = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureKeepAlive() {
  chrome.alarms.get(KEEPALIVE_ALARM, (existing) => {
    if (!existing) {
      chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 });
    }
  });
}

function stopKeepAlive() {
  chrome.alarms.clear(KEEPALIVE_ALARM);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM && !processing && queue.length === 0) {
    stopKeepAlive();
  }
});

async function persistQueue() {
  await chrome.storage.local.set({ [QUEUE_KEY]: queue });
}

async function resumeFromStorage() {
  const data = await chrome.storage.local.get(QUEUE_KEY);
  const saved = data[QUEUE_KEY] || [];
  if (saved.length > 0 && !processing) {
    queue = saved;
    processQueue();
  }
}
resumeFromStorage();

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "isx_crawl_media") {
    enqueueCrawl(msg.targets || []);
  } else if (msg.type === "isx_post_media") {
    if (pendingResolve && msg.shortcode === pendingShortcode) {
      pendingResolve({ media: msg.media || [], caption: msg.caption || "" });
    }
  } else if (msg.type === "isx_download_now") {
    downloadAllMedia();
  }
  return false;
});

function enqueueCrawl(targets) {
  const queuedCodes = new Set(queue.map((t) => t.shortcode));
  for (const t of targets) {
    if (!queuedCodes.has(t.shortcode)) queue.push(t);
  }
  persistQueue();
  ensureKeepAlive();
  if (!processing) processQueue();
}

async function processQueue() {
  processing = true;
  const total = queue.length;
  let done = 0;

  while (queue.length) {
    const target = queue[0];
    const result = await crawlOne(target);
    if (result && result.media && result.media.length) {
      await mergeMedia(target.shortcode, result.media, result.caption);
    }
    queue.shift();
    await persistQueue();
    done++;
    chrome.runtime
      .sendMessage({ type: "isx_crawl_progress", done, total, remaining: queue.length })
      .catch(() => {});
    await sleep(2200 + Math.random() * 1600);
  }

  processing = false;
  stopKeepAlive();
  downloadAllMedia();
}

function crawlOne(target) {
  return new Promise(async (resolve) => {
    let settled = false;
    let createdTabId = null;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pendingShortcode = null;
      pendingResolve = null;
      if (createdTabId != null) {
        chrome.tabs.remove(createdTabId).catch(() => {});
      }
    };

    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, 16000);

    pendingShortcode = target.shortcode;
    pendingResolve = (media) => {
      cleanup();
      resolve(media);
    };

    try {
      const tab = await chrome.tabs.create({ url: target.url, active: false });
      createdTabId = tab.id;
    } catch (e) {
      cleanup();
      resolve(null);
    }
  });
}

async function mergeMedia(shortcode, media, caption) {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const items = data[STORAGE_KEY] || [];
  const idx = items.findIndex((i) => i.shortcode === shortcode);
  if (idx === -1) return;

  if (media.length > (items[idx].media?.length || 0)) {
    items[idx].media = media;
    items[idx].media_type = media.length > 1 ? "carousel" : items[idx].media_type;
  }
  if (caption && !items[idx].caption) {
    items[idx].caption = caption;
  }
  await chrome.storage.local.set({ [STORAGE_KEY]: items });
}

function sanitize(s) {
  return String(s || "unknown").replace(/[^a-zA-Z0-9_\-.]/g, "_");
}

function utf8ToBase64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function textDataUrl(text) {
  return `data:text/plain;charset=utf-8;base64,${utf8ToBase64(text)}`;
}

function baseFileName(item, index) {
  const prefix = item.kind === "reel" ? "reel" : "post";
  return `${prefix}_${item.shortcode}_${String(index).padStart(2, "0")}`;
}

async function downloadAllMedia() {
  const [itemsData, downloadedData] = await Promise.all([
    chrome.storage.local.get(STORAGE_KEY),
    chrome.storage.local.get(DOWNLOADED_KEY),
  ]);
  const items = itemsData[STORAGE_KEY] || [];
  const downloadedMap = downloadedData[DOWNLOADED_KEY] || {};

  const jobs = [];
  for (const item of items) {
    const media = item.media || [];
    const already = downloadedMap[item.shortcode] || 0;
    for (let i = already; i < media.length; i++) {
      jobs.push({ item, m: media[i], index: i + 1 });
    }
  }

  if (jobs.length === 0) return;

  let done = 0;
  for (const { item, m, index } of jobs) {
    const ext = m.type === "video" ? "mp4" : "jpg";
    const collection = sanitize(item.collection || "salvos");
    const base = baseFileName(item, index);
    const filename = `instagram_saved/${collection}/${base}.${ext}`;

    await new Promise((resolve) => {
      chrome.downloads.download(
        { url: m.url, filename, saveAs: false, conflictAction: "uniquify" },
        () => resolve()
      );
    });

    if (item.caption) {
      const txtFilename = `instagram_saved/${collection}/${base}.txt`;
      await new Promise((resolve) => {
        chrome.downloads.download(
          {
            url: textDataUrl(item.caption),
            filename: txtFilename,
            saveAs: false,
            conflictAction: "overwrite",
          },
          () => resolve()
        );
      });
    }

    downloadedMap[item.shortcode] = index;
    done++;
    chrome.runtime
      .sendMessage({ type: "isx_download_progress", done, total: jobs.length })
      .catch(() => {});
    await sleep(200 + Math.random() * 200);
  }

  await chrome.storage.local.set({ [DOWNLOADED_KEY]: downloadedMap });
  await writeManifests(items);
  chrome.runtime
    .sendMessage({ type: "isx_download_done", total: jobs.length })
    .catch(() => {});
}

async function writeManifests(items) {
  const byCollection = new Map();
  for (const item of items) {
    const collection = sanitize(item.collection || "salvos");
    if (!byCollection.has(collection)) byCollection.set(collection, []);
    byCollection.get(collection).push({
      shortcode: item.shortcode,
      url: item.url,
      media_type: item.media_type,
      owner_username: item.owner_username,
      caption: item.caption || "",
      files: (item.media || []).map((m, i) => {
        const base = baseFileName(item, i + 1);
        return `${base}.${m.type === "video" ? "mp4" : "jpg"}`;
      }),
    });
  }
  for (const [collection, posts] of byCollection) {
    const manifest = {
      collection,
      generated_at: new Date().toISOString(),
      total_posts: posts.length,
      posts,
    };
    const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" });
    const buf = await blob.arrayBuffer();
    const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
    const dataUrl = `data:application/json;base64,${base64}`;
    await new Promise((resolve) => {
      chrome.downloads.download(
        {
          url: dataUrl,
          filename: `instagram_saved/${collection}/manifest.json`,
          saveAs: false,
          conflictAction: "overwrite",
        },
        () => resolve()
      );
    });
  }
}
