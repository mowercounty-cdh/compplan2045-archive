# compplan2045.com — Offline Archive

A self-contained offline mirror of **https://www.compplan2045.com** (the Austin /
Mower County 2045 Comprehensive Plan site, built on Squarespace), with all embedded
cloud documents (Google Drive, Dropbox, etc.) downloaded locally and re-linked so the
archive works without internet access.

## Run it

```bash
node scrape.mjs
```

Requirements: **Node.js 18+** (uses built-in `fetch`). No npm dependencies.
Re-running is **incremental** — already-downloaded pages, assets, and cloud files are
skipped/cached, so you can re-run anytime to refresh.

## What the script does

1. **Crawls** every page on `www.compplan2045.com` (same-host links only).
2. **Downloads page assets** (CSS, JS, images, fonts, and Squarespace-hosted PDFs /
   Office docs under `/s/...`).
3. **Downloads cloud documents** — detects Google Drive, Google Docs/Sheets/Slides,
   Dropbox, OneDrive, Box, etc., and fetches the underlying file. Handles Google
   Drive's large-file "virus scan" confirmation page automatically.
4. **Rewrites every link** in the saved HTML to point at the local copies:
   - internal page links → local `.html` files
   - asset links → `_assets/…`
   - cloud document links → `_files/…`

## Output layout (`./site/`)

| Path | Contents |
|------|----------|
| `index.html`, `draftplans.html`, `news.html`, … | The 11 mirrored site pages |
| `_assets/<host>/<path>` | CSS / JS / images / fonts / hosted PDFs & docs |
| `_files/google-drive/<id>__<name>` | Documents pulled out of Google Drive |
| `_archive-report.json` | Full manifest of pages, assets, cloud docs, and any errors |

Open **`site/index.html`** in a browser to browse the archive offline.

## Cloud documents recovered (Google Drive → local PDFs)

| File | Size |
|------|------|
| DRAFT 2045 Comprehensive Plan PLAYBOOK (July 8 2025) | 87 MB |
| March DRAFT – 2045 City of Austin Comprehensive Plan | 63 MB |
| March DRAFT – 2045 Mower County Comprehensive Plan | 61 MB |
| Urban3 Austin / Mower County MN report | 37 MB |
| Final Open House Boards | 23 MB |

Plus ~25 Squarespace-hosted PDFs/DOCX (PAC meeting minutes, survey summaries, fact
sheets, press release) under `_assets/www.compplan2045.com/s/`.

## Notes & limitations

- **Google Drive *folder* links** can't be bulk-downloaded without the Drive API or
  authentication; if any are found they're listed in the run summary and left as
  original links. (None were present at archive time — all Drive links were single
  files.)
- The script downloads only what's reachable in the **server-rendered HTML**.
  Squarespace serves its page content statically, so this captures the full site, but
  any content injected purely by client-side JS after load would not be followed.
- Documents requiring login (private Drive files, internal SharePoint, etc.) cannot be
  downloaded and will be flagged in the summary with the reason.

## Configuration

Edit the constants at the top of `scrape.mjs`:
- `START_URL` / `PRIMARY_HOSTS` — the site to mirror
- `CLOUD_HOST_PATTERNS` — which hosts count as "cloud documents"
- `ASSET_EXT` — which file extensions are treated as downloadable assets
- `MAX_CONCURRENT` — parallel download workers
