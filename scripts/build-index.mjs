import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as cheerio from "cheerio";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "data");
const pageDir = path.join(dataDir, "pages");
const imageDir = path.join(dataDir, "images");
const mainImageDir = path.join(imageDir, "main");
const voteyImageDir = path.join(imageDir, "votey");
const ocrInputDir = path.join(dataDir, "ocr-input");
const recordDir = path.join(dataDir, "records");
const publicDataDir = path.join(rootDir, "public", "data");
const publicThumbDir = path.join(rootDir, "public", "thumbs");

const archiveUrl = "https://www.smbc-comics.com/comic/archive";
const siteOrigin = "https://www.smbc-comics.com";
const userAgent = "Mozilla/5.0 smbc-search-local-indexer";

const monthNumbers = new Map(
  [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december"
  ].map((month, index) => [month, String(index + 1).padStart(2, "0")])
);

const dateOnlyPatterns = [
  /^\d{4}-\d{2}-\d{2}$/,
  /^\d{1,2}\/\d{1,2}\/\d{2,4}$/,
  /^(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},\s+\d{4}$/i
];

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await ensureDirs();

  const archive = await loadArchive(options);
  const selected = archive.entries.slice(options.offset, options.limit ? options.offset + options.limit : undefined);

  console.log(`Archive has ${archive.entries.length} comics. Processing ${selected.length}.`);

  if (!options.rebuildIndexOnly) {
    await runPool(selected, options.concurrency, async (entry, index) => {
      const processed = await processComic(entry, options);
      const done = options.offset + index + 1;
      const total = options.limit ? Math.min(options.offset + options.limit, archive.entries.length) : archive.entries.length;
      console.log(
        `${String(done).padStart(5, " ")}/${total} ${processed.id} ` +
          `comic:${processed.comicText ? processed.comicText.length : 0} ` +
          `hover:${processed.hoverText ? processed.hoverText.length : 0} ` +
          `votey:${processed.voteyText ? processed.voteyText.length : 0}`
      );
    });
  }

  const records = await loadRecords(archive.entries);
  await writeSearchIndex(archive, records);
  console.log(`Wrote ${records.length} indexed comics to public/data/search-index.json.`);
}

function parseArgs(args) {
  const options = {
    concurrency: 2,
    delayMs: 250,
    limit: 0,
    offset: 0,
    refreshPages: false,
    refreshImages: false,
    refreshOcr: false,
    rebuildIndexOnly: false
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const readNumber = (name) => {
      const value = args[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${name} expects a number`);
      }
      i += 1;
      return Number(value);
    };

    if (arg === "--concurrency") options.concurrency = readNumber(arg);
    else if (arg === "--delay-ms") options.delayMs = readNumber(arg);
    else if (arg === "--limit") options.limit = readNumber(arg);
    else if (arg === "--offset") options.offset = readNumber(arg);
    else if (arg === "--refresh-pages") options.refreshPages = true;
    else if (arg === "--refresh-images") options.refreshImages = true;
    else if (arg === "--refresh-ocr") options.refreshOcr = true;
    else if (arg === "--rebuild-index-only") options.rebuildIndexOnly = true;
    else throw new Error(`Unknown option: ${arg}`);
  }

  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error("--concurrency must be a positive integer");
  }
  if (!Number.isInteger(options.delayMs) || options.delayMs < 0) {
    throw new Error("--delay-ms must be a non-negative integer");
  }
  if (!Number.isInteger(options.limit) || options.limit < 0) {
    throw new Error("--limit must be a non-negative integer");
  }
  if (!Number.isInteger(options.offset) || options.offset < 0) {
    throw new Error("--offset must be a non-negative integer");
  }

  return options;
}

async function ensureDirs() {
  await Promise.all(
    [
      dataDir,
      pageDir,
      mainImageDir,
      voteyImageDir,
      ocrInputDir,
      recordDir,
      publicDataDir,
      publicThumbDir
    ].map((dir) => mkdir(dir, { recursive: true }))
  );
}

async function loadArchive(options) {
  const archivePath = path.join(dataDir, "archive.json");
  if (!options.refreshPages) {
    const cached = await readJsonIfExists(archivePath);
    if (cached?.entries?.length) return cached;
  }

  const html = await fetchText(archiveUrl, options);
  const $ = cheerio.load(html);
  const seen = new Set();
  const entries = [];

  $("select[name='comic'] option[value^='comic/']").each((_, element) => {
    const value = $(element).attr("value");
    const label = squashWhitespace($(element).text());
    if (!value || seen.has(value)) return;
    seen.add(value);

    const slug = value.replace(/^comic\//, "");
    const [dateLabel, ...titleParts] = label.split(" - ");
    const title = titleParts.join(" - ").trim() || slug;
    const date = parseArchiveDate(dateLabel.trim()) ?? slugDate(slug);

    entries.push({
      id: stableId(slug),
      slug,
      path: value,
      url: new URL(value, siteOrigin).toString(),
      title,
      archiveLabel: label,
      date,
      dateLabel: dateLabel.trim()
    });
  });

  const archive = {
    source: archiveUrl,
    fetchedAt: new Date().toISOString(),
    count: entries.length,
    entries
  };

  await writeJsonAtomic(archivePath, archive);
  return archive;
}

async function processComic(entry, options) {
  const recordPath = path.join(recordDir, `${entry.id}.json`);
  const cachedRecord = await readJsonIfExists(recordPath);
  if (cachedRecord && !options.refreshPages && !options.refreshImages && !options.refreshOcr) {
    const thumbnailPath = cachedRecord.thumbnail ? path.join(rootDir, "public", cachedRecord.thumbnail) : "";
    if (!thumbnailPath || (await exists(thumbnailPath))) return cachedRecord;
  }

  await sleep(options.delayMs);

  const pageHtml = await loadComicPage(entry, options);
  const page = parseComicPage(entry, pageHtml);
  const mainImage = await downloadComicImage(page.imageUrl, mainImageDir, page.id, options);
  const voteyImage = page.voteyUrl
    ? await downloadComicImage(page.voteyUrl, voteyImageDir, `${page.id}-votey`, options, { optional: true })
    : null;

  const comicText = mainImage ? await ocrCached(page.id, "comic", mainImage.path, options) : "";
  const voteyText = voteyImage ? await ocrCached(page.id, "votey", voteyImage.path, options) : "";
  const hoverText = cleanHoverText(page.hoverText, page);
  const thumbnail = mainImage ? await writeBlurredThumbnail(page.id, mainImage.path) : "";

  const record = {
    id: page.id,
    slug: page.slug,
    url: page.url,
    title: page.title,
    date: page.date,
    dateLabel: page.dateLabel,
    imageUrl: page.imageUrl,
    voteyUrl: voteyImage ? page.voteyUrl : "",
    localImage: mainImage ? path.relative(rootDir, mainImage.path) : "",
    localVoteyImage: voteyImage ? path.relative(rootDir, voteyImage.path) : "",
    thumbnail,
    comicText,
    hoverText,
    voteyText,
    updatedAt: new Date().toISOString()
  };

  await writeJsonAtomic(recordPath, record);
  return record;
}

async function loadComicPage(entry, options) {
  const pagePath = path.join(pageDir, `${entry.id}.html`);
  if (!options.refreshPages && (await exists(pagePath))) {
    return readFile(pagePath, "utf8");
  }

  const html = await fetchText(entry.url, options);
  await writeFileAtomic(pagePath, html);
  return html;
}

function parseComicPage(entry, html) {
  const $ = cheerio.load(html);
  const comicImage = $("#cc-comic").first();
  const jsonLd = readJsonLd($);
  const title = cleanTitle(jsonLd?.name) || $(".cc-newsheader").first().text().trim() || entry.title;
  const date = parseJsonLdDate(jsonLd?.datePublished) || entry.date;
  const imageUrl =
    absoluteUrl(comicImage.attr("src")) ||
    absoluteUrl(jsonLd?.image) ||
    absoluteUrl($("meta[property='og:image']").attr("content"));

  if (!imageUrl) {
    throw new Error(`No main image found for ${entry.url}`);
  }

  return {
    ...entry,
    title,
    date,
    url: absoluteUrl(jsonLd?.url) || entry.url,
    imageUrl,
    thumbnailUrl: absoluteUrl(jsonLd?.thumbnailUrl),
    hoverText: squashWhitespace(comicImage.attr("title") || ""),
    voteyUrl: absoluteUrl($("#aftercomic img").first().attr("src") || $("#mobaftercomic img").first().attr("src") || "")
  };
}

function readJsonLd($) {
  for (const element of $("script[type='application/ld+json']").toArray()) {
    const raw = $(element).contents().text();
    if (!raw.trim()) continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.["@type"] === "ComicStory") return parsed;
    } catch {
      // Ignore malformed structured data and fall back to page markup.
    }
  }
  return null;
}

async function downloadComicImage(url, targetDir, basename, options, { optional = false } = {}) {
  const extension = extensionFromUrl(url);
  const targetPath = path.join(targetDir, `${basename}${extension}`);

  if (!options.refreshImages && (await exists(targetPath))) {
    return { path: targetPath, url };
  }

  const response = await fetch(url, {
    headers: { "user-agent": userAgent, accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8" }
  });

  if (optional && [404, 410].includes(response.status)) {
    console.warn(`Optional image missing for ${basename}: ${url}`);
    return null;
  }
  if (!response.ok) {
    if (optional) {
      console.warn(`Optional image unavailable for ${basename}: ${response.status} ${response.statusText} ${url}`);
      return null;
    }
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") || "";
  const hasImageExtension = isImageUrl(url);
  if (contentType && !contentType.startsWith("image/")) {
    if (optional) {
      console.warn(`Optional image is not an image for ${basename}: ${contentType || "unknown content type"} ${url}`);
      return null;
    }
    throw new Error(`Expected image for ${url}, got ${contentType || "unknown content type"}`);
  }
  if (!contentType && !hasImageExtension) {
    if (optional) {
      console.warn(`Optional image has no content type for ${basename}: ${url}`);
      return null;
    }
    throw new Error(`Expected image for ${url}, got unknown content type`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFileAtomic(targetPath, buffer);
  return { path: targetPath, url };
}

async function ocrCached(id, kind, imagePath, options) {
  const ocrPath = path.join(dataDir, "ocr", `${id}-${kind}.txt`);
  await mkdir(path.dirname(ocrPath), { recursive: true });

  if (!options.refreshOcr && (await exists(ocrPath))) {
    return cleanOcr(await readFile(ocrPath, "utf8"));
  }

  const preparedPath = path.join(ocrInputDir, `${id}-${kind}.png`);
  let text = "";
  let inputForOcr = preparedPath;
  try {
    try {
      await prepareForOcr(imagePath, preparedPath);
    } catch (error) {
      console.warn(`OCR preprocessing failed for ${id} ${kind}; trying original image. ${firstErrorLine(error)}`);
      inputForOcr = imagePath;
    }
    text = cleanOcr(await runTesseract(inputForOcr));
  } catch (error) {
    console.warn(`OCR failed for ${id} ${kind}; leaving that field empty. ${firstErrorLine(error)}`);
  } finally {
    await rm(preparedPath, { force: true });
  }
  await writeFileAtomic(ocrPath, text);
  return text;
}

async function prepareForOcr(inputPath, outputPath) {
  const image = sharp(inputPath, { animated: false, limitInputPixels: false });
  const metadata = await image.metadata();
  const sourceWidth = metadata.width || 900;
  const targetWidth = sourceWidth < 1500 ? 1500 : sourceWidth;

  await image
    .flatten({ background: "#ffffff" })
    .resize({ width: targetWidth, withoutEnlargement: sourceWidth >= 1500 })
    .grayscale()
    .normalize()
    .sharpen()
    .png({ compressionLevel: 6 })
    .toFile(outputPath);
}

async function runTesseract(imagePath) {
  const args = [
    imagePath,
    "stdout",
    "-l",
    "eng",
    "--oem",
    "1",
    "--psm",
    "11",
    "-c",
    "preserve_interword_spaces=1"
  ];

  return new Promise((resolve, reject) => {
    const child = spawn("tesseract", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`tesseract exited ${code} for ${imagePath}\n${stderr}`));
    });
  });
}

async function writeBlurredThumbnail(id, imagePath) {
  const relativePath = `thumbs/${id}.webp`;
  const targetPath = path.join(rootDir, "public", relativePath);
  if (await exists(targetPath)) return relativePath;

  try {
    await sharp(imagePath, { animated: false, limitInputPixels: false })
      .flatten({ background: "#ffffff" })
      .resize({ width: 168, withoutEnlargement: true })
      .blur(4)
      .webp({ quality: 42, effort: 4 })
      .toFile(targetPath);
  } catch (error) {
    console.warn(`Thumbnail generation failed for ${id}; using placeholder. ${firstErrorLine(error)}`);
    await sharp({
      create: {
        width: 168,
        height: 126,
        channels: 3,
        background: "#d6d0c5"
      }
    })
      .webp({ quality: 42, effort: 4 })
      .toFile(targetPath);
  }

  return relativePath;
}

async function loadRecords(entries) {
  const records = [];
  for (const entry of entries) {
    const record = await readJsonIfExists(path.join(recordDir, `${entry.id}.json`));
    if (record) records.push(record);
  }
  return records;
}

async function writeSearchIndex(archive, records) {
  const index = {
    generatedAt: new Date().toISOString(),
    source: archive.source,
    totalArchiveComics: archive.entries.length,
    totalIndexedComics: records.length,
    fields: ["comicText", "hoverText", "voteyText"],
    comics: records.map((record) => ({
      id: record.id,
      slug: record.slug,
      url: record.url,
      title: record.title,
      date: record.date,
      dateLabel: record.dateLabel,
      thumbnail: record.thumbnail,
      comicText: record.comicText || "",
      hoverText: record.hoverText || "",
      voteyText: record.voteyText || ""
    }))
  };

  await writeJsonAtomic(path.join(publicDataDir, "search-index.json"), index);
  await writeJsonAtomic(path.join(dataDir, "search-index.json"), index);
}

async function runPool(items, concurrency, worker) {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(workers);
}

async function fetchText(url, options) {
  await sleep(options.delayMs);
  const response = await fetch(url, {
    headers: {
      "user-agent": userAgent,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    }
  });
  const text = await response.text();
  const archiveStatusQuirk = url === archiveUrl && response.status === 500 && text.includes("select name=\"comic\"");
  if (!response.ok && !archiveStatusQuirk) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return text;
}

function cleanHoverText(text, page) {
  const cleaned = squashWhitespace(text);
  if (!cleaned) return "";

  const lower = cleaned.toLowerCase();
  if (page.date && lower === page.date.toLowerCase()) return "";
  if (page.dateLabel && lower === page.dateLabel.toLowerCase()) return "";
  if (dateOnlyPatterns.some((pattern) => pattern.test(cleaned))) return "";
  return cleaned;
}

function cleanTitle(title) {
  return squashWhitespace(String(title || "").replace(/^Saturday Morning Breakfast Cereal\s*-\s*/i, ""));
}

function cleanOcr(text) {
  return String(text || "")
    .replace(/\f/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function squashWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function parseArchiveDate(dateLabel) {
  const match = /^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})$/.exec(dateLabel);
  if (!match) return null;
  const month = monthNumbers.get(match[1].toLowerCase());
  if (!month) return null;
  return `${match[3]}-${month}-${match[2].padStart(2, "0")}`;
}

function parseJsonLdDate(value) {
  if (!value) return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return match ? match[1] : null;
}

function slugDate(slug) {
  return /^\d{4}-\d{2}-\d{2}$/.test(slug) ? slug : "";
}

function absoluteUrl(value) {
  if (!value) return "";
  try {
    return new URL(value, siteOrigin).toString();
  } catch {
    return "";
  }
}

function extensionFromUrl(url) {
  const pathname = new URL(url).pathname;
  const extension = path.extname(pathname).toLowerCase();
  return extension && extension.length <= 6 ? extension : ".img";
}

function isImageUrl(url) {
  return /\.(avif|gif|jpe?g|png|webp)$/i.test(new URL(url).pathname);
}

function firstErrorLine(error) {
  return String(error?.message || error || "").split("\n")[0];
}

function stableId(slug) {
  const safe = slug.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (safe) return safe;
  return createHash("sha1").update(slug).digest("hex").slice(0, 12);
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJsonAtomic(filePath, data) {
  await writeFileAtomic(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

async function writeFileAtomic(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(tempPath, data);
  await rename(tempPath, filePath);
}

async function sleep(ms) {
  if (!ms) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}
