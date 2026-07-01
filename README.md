# SMBC Search

A local, reproducible indexer and search page for [SMBC](https://www.smbc-comics.com/).

The scraper reads the official archive, downloads each comic and votey image, extracts:

- main comic text
- hover text from the main comic image title
- votey text
- visual descriptions from semantic transcripts, when available

Hover text is ignored when it is empty or only the comic date. Search defaults to main comic text, with toggles for comic, hover text, votey, and experimental description fields. Result thumbnails are generated locally from the comic images at a small blurred size so they identify a result without replacing the official page.

## Requirements

- Node.js 20+
- npm
- Tesseract OCR available as `tesseract`

## Install

```sh
npm install
```

## Build the index

For a quick sanity check:

```sh
npm run scrape:sample
```

For the full archive:

```sh
npm run scrape
```

The full run is resumable. It caches fetched pages, images, OCR records, generated thumbnails, and the final search index under `data/`, `public/data/`, and `public/thumbs/`.

Useful options:

```sh
node scripts/build-index.mjs --limit 100
node scripts/build-index.mjs --offset 500 --limit 100
node scripts/build-index.mjs --concurrency 2 --delay-ms 300
node scripts/build-index.mjs --refresh-pages
node scripts/build-index.mjs --refresh-ocr
node scripts/build-index.mjs --rebuild-index-only
```

## Run the search page

```sh
npm run serve
```

Open the printed local URL.

## Verify

```sh
npm run smoke
```

## Cloud deployment

For the set-and-forget Cloudflare/GitHub Actions setup, see [docs/cloud-deployment.md](docs/cloud-deployment.md).
