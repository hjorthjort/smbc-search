# Cloud Deployment

This project should deploy as a static Cloudflare Worker while scheduled scraping runs in GitHub Actions.

The scraper is intentionally not run inside a Cloudflare Worker. It uses native `sharp`, a local filesystem cache, and the `tesseract` binary. GitHub Actions can install and run those dependencies reliably, then commit the deployable `public/data` and `public/thumbs` outputs back to the repository. Cloudflare only needs to serve those public assets.

## Cloudflare Worker Settings

Use the connected repository deployment screen with:

```text
Build command: npm ci && npm run smoke
Deploy command: npm run deploy
```

The Worker deploy command reads `wrangler.jsonc`, serves `public/` as static assets, and uses `src/worker.js` only as a thin asset wrapper.

Make sure the Cloudflare project watches the same branch that contains this workflow and the committed public assets.

## Scheduled Updates

`.github/workflows/update-index.yml` runs:

- daily latest update: refresh the archive, fully reprocess the newest 4 comics plus any archive entries missing from the current index, then import semantic/manual transcripts
- monthly full refresh: refresh every comic page, rebuild the full search index, then import semantic/manual transcripts
- semantic transcript import: map cached Oh Yes Robot SMBC transcript pages back to official SMBC URLs, split visible comic/votey text from visual panel descriptions, replace raw OCR text where available, and keep official hover text from SMBC

The scraper preserves reviewed `manual` and `ohyesrobot` text and descriptions when a later scan sees the same comic image URL again, including during latest-comic OCR refreshes. New comics may temporarily use OCR until a semantic or manual transcript is available, but the audit fails if raw OCR remains outside the newest 4 comics.

Descriptions are stored as `descriptionText` and are opt-in in the UI as **Description (experimental)**. The daily and monthly workflows run the same importer, so future scans keep descriptions out of the default comic text field instead of relying on one-off generated index edits.

If the semantic/manual transcript sources lag behind new SMBC posts, the newest unmatched comics are published with Tesseract text so the index continues updating. The audit still reports those pending OCR records and fails only when raw OCR appears before the latest reviewed transcript frontier.

The workflow commits changes under `public/data` and `public/thumbs`. Those commits trigger a normal Cloudflare redeploy from the repository.

GitHub scheduled workflows run from the repository default branch. If this repo's default branch is not the deployment branch, either change the default branch or merge these files into the default branch.

## Manual Runs

In GitHub Actions, run **Update SMBC index** manually with:

- `latest` to reprocess only the newest 4 comics
- `full` to refresh the whole archive

Locally, use `npm run update:latest` or `npm run update:full` for the same scrape-plus-import path the scheduled workflow uses.
