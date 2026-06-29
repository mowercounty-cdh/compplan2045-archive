#!/usr/bin/env node
/*
 * compplan2045.com offline archiver
 * ---------------------------------
 * 1. Crawls every page on www.compplan2045.com (same-host links only).
 * 2. Downloads page assets (CSS / JS / images / fonts) best-effort.
 * 3. Detects "cloud document" links (Google Drive, Google Docs/Sheets/Slides,
 *    Dropbox, OneDrive, Box, etc.), downloads the underlying files locally.
 * 4. Rewrites ALL links in the saved HTML so the archive is self-contained:
 *      - internal page links  -> local .html files
 *      - asset links          -> local copies under _assets/
 *      - cloud document links -> local copies under _files/
 *
 * Output layout (inside ./site):
 *      index.html, draftplans.html, news/...           (mirrored pages)
 *      _assets/<host>/<path>                            (css/js/img/fonts)
 *      _files/<service>/<id>__<filename>                (cloud documents)
 *      _archive-report.json                             (manifest of everything)
 *
 * Usage:  node scrape.mjs
 * Re-running is incremental: already-downloaded files are skipped.
 */

import { mkdir, writeFile, readFile, access, stat, readdir } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { dirname, join, relative, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

// ----------------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------------
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "docs");
const ASSET_DIR = join(ROOT, "_assets");
const FILE_DIR = join(ROOT, "_files");

const START_URL = "https://www.compplan2045.com/";
const PRIMARY_HOSTS = new Set(["www.compplan2045.com", "compplan2045.com"]);

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const MAX_CONCURRENT = 5;
const REQUEST_TIMEOUT_MS = 60000;

// Hosts whose links are "cloud documents" we want to download + re-link.
const CLOUD_HOST_PATTERNS = [
  /(^|\.)drive\.google\.com$/i,
  /(^|\.)docs\.google\.com$/i,
  /(^|\.)dropbox\.com$/i,
  /(^|\.)dropboxusercontent\.com$/i,
  /(^|\.)1drv\.ms$/i,
  /(^|\.)onedrive\.live\.com$/i,
  /(^|\.)sharepoint\.com$/i,
  /(^|\.)box\.com$/i,
  /(^|\.)app\.box\.com$/i,
  /(^|\.)wetransfer\.com$/i,
];

// Asset file extensions we treat as downloadable static assets.
const ASSET_EXT =
  /\.(css|js|mjs|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|eot|otf|mp4|webm|mp3|wav|pdf|json|xml|map|docx?|xlsx?|pptx?|csv|rtf|txt|zip|kml|kmz)(\?|#|$)/i;

// ----------------------------------------------------------------------------
// State
// ----------------------------------------------------------------------------
const pages = new Map();        // normalizedUrl -> { url, localPath, html }
const pageQueue = [];           // urls to crawl
const assets = new Map();       // assetUrl -> { localPath, downloaded }
const cloudDocs = new Map();    // originalUrl -> { service, localPath, downloaded, note }
const visited = new Set();
const report = {
  startedAt: new Date().toISOString(),
  pages: [],
  assets: [],
  cloudDocs: [],
  errors: [],
};

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
const log = (...a) => console.log(...a);
const warn = (...a) => console.warn("  ! ", ...a);

async function ensureDir(p) {
  await mkdir(dirname(p), { recursive: true });
}

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

function isPrimaryHost(host) {
  return PRIMARY_HOSTS.has(host.toLowerCase());
}

function isCloudHost(host) {
  return CLOUD_HOST_PATTERNS.some((re) => re.test(host));
}

/** Fetch with timeout + UA, returns Response or throws. */
async function httpGet(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeout || REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "User-Agent": UA, ...(opts.headers || {}) },
    });
    return res;
  } finally {
    clearTimeout(t);
  }
}

/** Normalize an internal page URL: drop hash, drop trailing slash, lowercase host. */
function normalizePageUrl(u) {
  const url = new URL(u);
  url.hash = "";
  // Squarespace pages are case-sensitive paths; keep path case.
  let p = url.pathname;
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  url.pathname = p;
  // Drop common tracking/format query params for page identity
  url.search = url.search; // keep search for now (some pages use ?category=)
  return url.toString();
}

/** Map a page URL to a local .html path under ROOT. */
function pageUrlToLocal(u) {
  const url = new URL(u);
  let p = decodeURIComponent(url.pathname);
  if (p === "/" || p === "") return join(ROOT, "index.html");
  if (p.endsWith("/")) p = p.slice(0, -1);
  // query (e.g. ?category=foo) becomes part of filename to disambiguate
  let name = p.replace(/^\//, "");
  if (url.search) {
    const q = url.search.replace(/[^\w]+/g, "_").replace(/^_+|_+$/g, "");
    name += "__" + q;
  }
  if (!name.endsWith(".html")) name += ".html";
  return join(ROOT, name);
}

/** Map an asset URL to a local path under _assets/<host>/<path>. */
function assetUrlToLocal(u) {
  const url = new URL(u);
  let p = decodeURIComponent(url.pathname);
  if (!p || p === "/") p = "/index";
  // Encode query into filename so different sizes don't collide
  let q = "";
  if (url.search) {
    q = "__" + url.search.slice(1).replace(/[^\w.=&-]+/g, "_").slice(0, 80);
  }
  // ensure an extension survives
  let base = p.replace(/^\//, "");
  // split ext
  const m = base.match(/\.([a-z0-9]+)$/i);
  if (m && q) {
    base = base.slice(0, -(m[0].length)) + q + m[0];
  } else if (q) {
    base = base + q;
  }
  return join(ASSET_DIR, url.host, base);
}

/** Compute a relative href from one local file to another local file. */
function relHref(fromLocal, toLocal) {
  let rel = relative(dirname(fromLocal), toLocal);
  rel = rel.split(/[\\/]/).join("/"); // posix separators for hrefs
  if (!rel.startsWith(".")) rel = "./" + rel;
  return rel;
}

// ----------------------------------------------------------------------------
// Google Drive / cloud download resolution
// ----------------------------------------------------------------------------

/** Extract a Google Drive file id from common URL shapes. */
function driveFileId(url) {
  const u = new URL(url);
  let m = u.pathname.match(/\/file\/d\/([^/]+)/);
  if (m) return m[1];
  m = u.pathname.match(/\/d\/([^/]+)/);
  if (m) return m[1];
  if (u.searchParams.get("id")) return u.searchParams.get("id");
  return null;
}

/** Returns { type:'file'|'folder'|'doc'|'unknown', id } for a google url. */
function classifyGoogle(url) {
  const u = new URL(url);
  const host = u.host.toLowerCase();
  if (host.includes("docs.google.com")) {
    const m = u.pathname.match(/\/(document|spreadsheets|presentation)\/d\/([^/]+)/);
    if (m) return { type: "gdoc", kind: m[1], id: m[2] };
  }
  if (u.pathname.includes("/folders/")) {
    const m = u.pathname.match(/\/folders\/([^/]+)/);
    return { type: "folder", id: m ? m[1] : null };
  }
  const id = driveFileId(url);
  if (id) return { type: "file", id };
  return { type: "unknown", id: null };
}

/** Try to derive a filename from Content-Disposition header. */
function filenameFromCD(res, fallback) {
  const cd = res.headers.get("content-disposition") || "";
  let m = cd.match(/filename\*=UTF-8''([^;]+)/i);
  if (m) return decodeURIComponent(m[1]);
  m = cd.match(/filename="?([^";]+)"?/i);
  if (m) return m[1];
  return fallback;
}

function extFromContentType(ct) {
  if (!ct) return "";
  ct = ct.split(";")[0].trim().toLowerCase();
  const map = {
    "application/pdf": ".pdf",
    "application/zip": ".zip",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
    "application/msword": ".doc",
    "application/vnd.ms-excel": ".xls",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "text/csv": ".csv",
    "text/plain": ".txt",
  };
  return map[ct] || "";
}

/**
 * Download a Google Drive *file* (handles the large-file virus-scan confirm page).
 * Returns { buffer, filename } or throws.
 */
async function downloadDriveFile(id) {
  const base = "https://drive.google.com/uc?export=download&id=" + id;
  let res = await httpGet(base);
  let ct = res.headers.get("content-type") || "";

  // Large files return an HTML interstitial with a confirm token / form.
  if (ct.includes("text/html")) {
    const html = await res.text();
    // Newer Drive uses a form post to drive.usercontent.google.com
    const formMatch = html.match(/action="(https:\/\/drive\.usercontent\.google\.com\/download[^"]*)"/);
    if (formMatch) {
      const action = formMatch[1].replace(/&amp;/g, "&");
      const params = {};
      const re = /name="([^"]+)"\s+value="([^"]*)"/g;
      let mm;
      while ((mm = re.exec(html))) params[mm[1]] = mm[2];
      const usp = new URLSearchParams(params);
      usp.set("id", id);
      const dlUrl = action + (action.includes("?") ? "&" : "?") + usp.toString();
      res = await httpGet(dlUrl);
      ct = res.headers.get("content-type") || "";
    } else {
      // fallback: confirm=t
      const confirm = (html.match(/confirm=([0-9A-Za-z_-]+)/) || [])[1] || "t";
      const dlUrl =
        "https://drive.usercontent.google.com/download?id=" +
        id + "&export=download&confirm=" + confirm;
      res = await httpGet(dlUrl);
      ct = res.headers.get("content-type") || "";
    }
  }

  if (!res.ok) throw new Error("Drive download HTTP " + res.status);
  if ((res.headers.get("content-type") || "").includes("text/html")) {
    throw new Error("Drive returned HTML (file may need auth / be a folder)");
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const filename = filenameFromCD(res, id + (extFromContentType(ct) || ".bin"));
  return { buffer: buf, filename };
}

/** Export a Google Doc/Sheet/Slides to an Office format. */
async function downloadGoogleDoc(kind, id) {
  const cfg = {
    document: { url: `https://docs.google.com/document/d/${id}/export?format=docx`, ext: ".docx" },
    spreadsheets: { url: `https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`, ext: ".xlsx" },
    presentation: { url: `https://docs.google.com/presentation/d/${id}/export/pptx`, ext: ".pptx" },
  }[kind];
  if (!cfg) throw new Error("Unknown gdoc kind " + kind);
  const res = await httpGet(cfg.url);
  if (!res.ok) throw new Error("gdoc export HTTP " + res.status);
  if ((res.headers.get("content-type") || "").includes("text/html")) {
    throw new Error("gdoc export returned HTML (not publicly shared?)");
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const filename = filenameFromCD(res, `${kind}-${id}${cfg.ext}`);
  return { buffer: buf, filename };
}

/** Download a Dropbox shared link as a direct file. */
async function downloadDropbox(url) {
  const u = new URL(url);
  u.searchParams.set("dl", "1");
  const res = await httpGet(u.toString());
  if (!res.ok) throw new Error("Dropbox HTTP " + res.status);
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("text/html")) throw new Error("Dropbox returned HTML page");
  const buf = Buffer.from(await res.arrayBuffer());
  const base = posix.basename(u.pathname) || "dropbox-file";
  const filename = filenameFromCD(res, base);
  return { buffer: buf, filename };
}

function sanitizeName(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_").replace(/\s+/g, "_").slice(0, 150);
}

/**
 * Resolve + download a cloud document. Records into cloudDocs map.
 * Returns the local path (relative-ready) or null if it couldn't be fetched.
 */
async function handleCloudDoc(originalUrl) {
  if (cloudDocs.has(originalUrl)) {
    const e = cloudDocs.get(originalUrl);
    return e.downloaded ? e.localPath : null;
  }
  const entry = { service: "", localPath: null, downloaded: false, note: "", originalUrl };
  cloudDocs.set(originalUrl, entry);

  let host;
  try { host = new URL(originalUrl).host.toLowerCase(); }
  catch { entry.note = "bad url"; return null; }

  // Cheap idempotency: if a file for this Drive/Doc id was already saved, reuse it.
  async function cachedById(service, id) {
    if (!id) return null;
    const dir = join(FILE_DIR, service);
    try {
      const files = await readdir(dir);
      const hit = files.find((f) => f.startsWith(id + "__"));
      return hit ? join(dir, hit) : null;
    } catch { return null; }
  }

  try {
    if (host.includes("google.com")) {
      const c = classifyGoogle(originalUrl);
      if (c.type === "folder") {
        entry.service = "google-drive-folder";
        entry.note = "Folder links can't be bulk-downloaded without the Drive API/auth; left as-is.";
        warn("Drive FOLDER (not downloaded):", originalUrl);
        return null;
      }
      entry.service = c.type === "gdoc" ? "google-docs" : "google-drive";
      const cached = await cachedById(entry.service, c.id);
      if (cached) {
        entry.localPath = cached; entry.downloaded = true;
        log("    = cached", entry.service, "->", relative(ROOT, cached));
        return cached;
      }
      let dl;
      if (c.type === "gdoc") {
        dl = await downloadGoogleDoc(c.kind, c.id);
      } else if (c.type === "file") {
        dl = await downloadDriveFile(c.id);
      } else {
        entry.note = "unrecognized google url";
        return null;
      }
      const local = join(FILE_DIR, entry.service, sanitizeName((c.id || "") + "__" + dl.filename));
      await ensureDir(local);
      await writeFile(local, dl.buffer);
      entry.localPath = local;
      entry.downloaded = true;
      log("    ✓ downloaded", entry.service, "->", relative(ROOT, local), `(${dl.buffer.length} B)`);
      return local;
    }

    if (host.includes("dropbox")) {
      entry.service = "dropbox";
      const dl = await downloadDropbox(originalUrl);
      const local = join(FILE_DIR, "dropbox", sanitizeName(dl.filename));
      await ensureDir(local);
      await writeFile(local, dl.buffer);
      entry.localPath = local;
      entry.downloaded = true;
      log("    ✓ downloaded dropbox ->", relative(ROOT, local), `(${dl.buffer.length} B)`);
      return local;
    }

    // Generic best-effort for other cloud hosts (box, onedrive, etc.)
    entry.service = host;
    const res = await httpGet(originalUrl);
    const ct = res.headers.get("content-type") || "";
    if (!res.ok || ct.includes("text/html")) {
      entry.note = "Could not auto-download (requires auth or returns an HTML page).";
      warn("cloud host not auto-downloadable:", originalUrl);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const fn = filenameFromCD(res, sanitizeName(host + "-file" + (extFromContentType(ct) || "")));
    const local = join(FILE_DIR, sanitizeName(host), sanitizeName(fn));
    await ensureDir(local);
    await writeFile(local, buf);
    entry.localPath = local;
    entry.downloaded = true;
    log("    ✓ downloaded", host, "->", relative(ROOT, local));
    return local;
  } catch (err) {
    entry.note = String(err.message || err);
    warn("cloud download failed:", originalUrl, "—", entry.note);
    report.errors.push({ url: originalUrl, stage: "cloud", error: entry.note });
    return null;
  }
}

// ----------------------------------------------------------------------------
// Asset download
// ----------------------------------------------------------------------------
async function downloadAsset(absUrl) {
  if (assets.has(absUrl)) return assets.get(absUrl);
  const local = assetUrlToLocal(absUrl);
  const entry = { localPath: local, downloaded: false };
  assets.set(absUrl, entry);
  try {
    if (await exists(local)) { entry.downloaded = true; return entry; }
    const res = await httpGet(absUrl);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    await ensureDir(local);
    await writeFile(local, buf);
    entry.downloaded = true;
  } catch (err) {
    warn("asset failed:", absUrl, "—", err.message);
    report.errors.push({ url: absUrl, stage: "asset", error: String(err.message) });
  }
  return entry;
}

// ----------------------------------------------------------------------------
// Link extraction
// ----------------------------------------------------------------------------
/** Pull candidate URLs out of an HTML string with their match metadata. */
function extractLinks(html) {
  const found = [];
  // attribute-based: href, src, data-src, data-image, content, poster
  const attrRe = /(href|src|data-src|data-image|data-href|poster|content)\s*=\s*("([^"]*)"|'([^']*)')/gi;
  let m;
  while ((m = attrRe.exec(html))) {
    const val = m[3] !== undefined ? m[3] : m[4];
    if (val) found.push({ raw: val, attr: m[1].toLowerCase() });
  }
  // srcset / data-srcset (comma separated "url size")
  const srcsetRe = /(srcset|data-srcset)\s*=\s*("([^"]*)"|'([^']*)')/gi;
  while ((m = srcsetRe.exec(html))) {
    const val = m[3] !== undefined ? m[3] : m[4];
    val.split(",").forEach((part) => {
      const u = part.trim().split(/\s+/)[0];
      if (u) found.push({ raw: u, attr: "srcset" });
    });
  }
  // CSS url(...) inside <style> or inline
  const cssRe = /url\(\s*['"]?([^'")]+)['"]?\s*\)/gi;
  while ((m = cssRe.exec(html))) {
    found.push({ raw: m[1], attr: "css-url" });
  }
  return found;
}

function resolveUrl(raw, base) {
  try {
    if (!raw || raw.startsWith("data:") || raw.startsWith("mailto:") ||
        raw.startsWith("tel:") || raw.startsWith("javascript:") || raw.startsWith("#")) {
      return null;
    }
    if (raw.startsWith("//")) raw = "https:" + raw;
    return new URL(raw, base).toString();
  } catch { return null; }
}

// ----------------------------------------------------------------------------
// Page processing
// ----------------------------------------------------------------------------
async function crawlPage(pageUrl) {
  const norm = normalizePageUrl(pageUrl);
  if (visited.has(norm)) return;
  visited.add(norm);

  let res;
  try {
    res = await httpGet(norm);
  } catch (err) {
    warn("page fetch failed:", norm, err.message);
    report.errors.push({ url: norm, stage: "page", error: String(err.message) });
    return;
  }
  const ct = res.headers.get("content-type") || "";
  if (!res.ok || !ct.includes("text/html")) {
    warn("skip non-html page:", norm, res.status, ct);
    return;
  }
  const finalUrl = res.url || norm;
  const html = await res.text();
  const localPath = pageUrlToLocal(finalUrl);
  pages.set(norm, { url: finalUrl, localPath, html });
  log("PAGE", norm, "->", relative(ROOT, localPath));

  // discover new internal pages
  const links = extractLinks(html);
  for (const { raw, attr } of links) {
    if (attr !== "href") continue;
    const abs = resolveUrl(raw, finalUrl);
    if (!abs) continue;
    let u;
    try { u = new URL(abs); } catch { continue; }
    if (isPrimaryHost(u.host)) {
      // treat as page if it has no asset extension
      if (!ASSET_EXT.test(u.pathname) && u.pathname !== "/cart") {
        const n = normalizePageUrl(abs);
        if (!visited.has(n) && !pageQueue.includes(n)) pageQueue.push(n);
      }
    }
  }
}

// ----------------------------------------------------------------------------
// Rewrite phase — runs after all pages are crawled & assets/docs known
// ----------------------------------------------------------------------------
async function rewriteAndSave() {
  // We need: for each page, replace every URL occurrence with a local rel path.
  for (const [, page] of pages) {
    let html = page.html;
    const base = page.url;
    const fromLocal = page.localPath;

    // Build a replacement map of raw->replacement for this page.
    const replacements = new Map();

    const links = extractLinks(html);
    for (const { raw } of links) {
      if (replacements.has(raw)) continue;
      const abs = resolveUrl(raw, base);
      if (!abs) continue;
      let u;
      try { u = new URL(abs); } catch { continue; }

      // 1) internal page link
      if (isPrimaryHost(u.host) && !ASSET_EXT.test(u.pathname)) {
        const n = normalizePageUrl(abs);
        if (pages.has(n)) {
          replacements.set(raw, relHref(fromLocal, pages.get(n).localPath));
          continue;
        }
        // unknown internal page (not crawled, e.g. /cart) -> leave absolute
        continue;
      }

      // 2) cloud document link
      if (isCloudHost(u.host)) {
        const e = cloudDocs.get(abs);
        if (e && e.downloaded && e.localPath) {
          replacements.set(raw, relHref(fromLocal, e.localPath));
        }
        continue;
      }

      // 3) downloadable asset (any host)
      if (ASSET_EXT.test(u.pathname) || ASSET_EXT.test(u.search)) {
        const e = assets.get(abs);
        if (e && e.downloaded) {
          replacements.set(raw, relHref(fromLocal, e.localPath));
        }
        continue;
      }
    }

    // Apply replacements (longest raw first to avoid partial collisions).
    const keys = [...replacements.keys()].sort((a, b) => b.length - a.length);
    for (const k of keys) {
      const v = replacements.get(k);
      // Replace inside quotes to be safe
      html = html.split(`"${k}"`).join(`"${v}"`);
      html = html.split(`'${k}'`).join(`'${v}'`);
      // srcset / css may have it unquoted-ish; replace bare occurrences too
      html = html.split(`(${k})`).join(`(${v})`);
    }

    // Add a small banner noting this is an archived copy
    const banner =
      `<!-- Archived copy of ${base} — generated ${new Date().toISOString()} ` +
      `by compplan2045 archiver. Cloud documents downloaded locally under _files/. -->\n`;
    html = banner + html;

    await ensureDir(fromLocal);
    await writeFile(fromLocal, html, "utf8");
    report.pages.push({ url: base, local: relative(ROOT, fromLocal) });
  }
}

// ----------------------------------------------------------------------------
// Concurrency helper
// ----------------------------------------------------------------------------
async function runPool(items, worker, concurrency = MAX_CONCURRENT) {
  const queue = [...items];
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(workers);
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------
async function main() {
  await mkdir(ROOT, { recursive: true });
  await mkdir(ASSET_DIR, { recursive: true });
  await mkdir(FILE_DIR, { recursive: true });

  // ---- Phase 1: crawl all pages (breadth-first) ----
  log("\n=== Phase 1: crawling pages ===");
  pageQueue.push(normalizePageUrl(START_URL));
  while (pageQueue.length) {
    const batch = pageQueue.splice(0, MAX_CONCURRENT);
    await Promise.all(batch.map(crawlPage));
  }
  log(`Crawled ${pages.size} pages.`);

  // ---- Phase 2: collect all asset + cloud links from every page ----
  log("\n=== Phase 2: collecting assets & cloud links ===");
  const assetUrls = new Set();
  const cloudUrls = new Set();
  for (const [, page] of pages) {
    for (const { raw } of extractLinks(page.html)) {
      const abs = resolveUrl(raw, page.url);
      if (!abs) continue;
      let u;
      try { u = new URL(abs); } catch { continue; }
      if (isCloudHost(u.host)) { cloudUrls.add(abs); continue; }
      if (ASSET_EXT.test(u.pathname) || ASSET_EXT.test(u.search)) assetUrls.add(abs);
    }
  }
  log(`Found ${assetUrls.size} asset URLs, ${cloudUrls.size} cloud-document URLs.`);

  // ---- Phase 3: download cloud documents ----
  log("\n=== Phase 3: downloading cloud documents (Google Drive / Dropbox / etc.) ===");
  for (const url of cloudUrls) log("  •", url);
  await runPool([...cloudUrls], handleCloudDoc, 3);

  // ---- Phase 4: download assets ----
  log("\n=== Phase 4: downloading page assets ===");
  await runPool([...assetUrls], downloadAsset, MAX_CONCURRENT);
  const okAssets = [...assets.values()].filter((a) => a.downloaded).length;
  log(`Downloaded ${okAssets}/${assets.size} assets.`);

  // ---- Phase 5: rewrite links & save pages ----
  log("\n=== Phase 5: rewriting links & saving pages ===");
  await rewriteAndSave();

  // ---- report ----
  report.assets = [...assets.entries()].map(([url, e]) => ({
    url, local: relative(ROOT, e.localPath), downloaded: e.downloaded,
  }));
  report.cloudDocs = [...cloudDocs.entries()].map(([url, e]) => ({
    url, service: e.service, downloaded: e.downloaded,
    local: e.localPath ? relative(ROOT, e.localPath) : null, note: e.note,
  }));
  report.finishedAt = new Date().toISOString();
  await writeFile(join(ROOT, "_archive-report.json"), JSON.stringify(report, null, 2));

  // ---- summary ----
  log("\n=== DONE ===");
  log(`Pages saved:        ${report.pages.length}`);
  log(`Assets downloaded:  ${okAssets}/${assets.size}`);
  const dlDocs = report.cloudDocs.filter((d) => d.downloaded).length;
  log(`Cloud docs saved:   ${dlDocs}/${report.cloudDocs.length}`);
  if (report.cloudDocs.some((d) => !d.downloaded)) {
    log("\nCloud documents NOT auto-downloaded (need manual attention):");
    for (const d of report.cloudDocs.filter((x) => !x.downloaded)) {
      log("  -", d.url, "\n      ", d.note);
    }
  }
  log(`\nReport: ${relative(__dirname, join(ROOT, "_archive-report.json"))}`);
  log(`Open:   ${relative(__dirname, join(ROOT, "index.html"))}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
