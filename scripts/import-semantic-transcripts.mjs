import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as cheerio from "cheerio";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "data");
const semanticDir = path.join(dataDir, "semantic", "ohyesrobot");
const listDir = path.join(semanticDir, "lists");
const pageDir = path.join(semanticDir, "pages");
const recordDir = path.join(dataDir, "records");
const publicIndexPath = path.join(rootDir, "public", "data", "search-index.json");
const dataIndexPath = path.join(dataDir, "search-index.json");
const manualTranscriptPath = path.join(__dirname, "manual-transcripts.json");

const sourceOrigin = "https://ohyesrobot.ordoliberal.com";
const seriesPath = "/series/smbc/";
const sourceName = "ohyesrobot";
const userAgent = "Mozilla/5.0 smbc-search semantic transcript importer";

const semanticCorrections = [
  {
    id: "2014-12-17",
    field: "comicText",
    search: /\bSend via merman\b/gi,
    replacement: "Send via Meatmail"
  },
  {
    id: "2014-12-17",
    field: "comicText",
    search: /\bdaughter-cells\b/gi,
    replacement: "douchebag cells"
  },
  {
    id: "2006-09-14",
    field: "comicText",
    search: /\bSECTION 2: MATH\b/gi,
    replacement: "SECTION 1: MATH"
  }
];

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await ensureDirs();

  const index = await readJson(publicIndexPath);
  const manualTranscripts = await readJsonIfExists(manualTranscriptPath);
  const sourceEntries = await loadSourceEntries(options);
  const transcripts = await loadTranscripts(sourceEntries, options);
  const transcriptsById = mapTranscriptsBySmbcId(transcripts);
  const stats = {
    indexedComics: index.comics.length,
    sourceEntries: sourceEntries.length,
    parsedTranscripts: transcripts.length,
    matchedComics: 0,
    unmatchedComics: 0,
    unmatchedSourceTranscripts: 0,
    manualComicText: 0,
    manualVoteyText: 0,
    comicTextFromSemantic: 0,
    voteyTextFromSemantic: 0,
    descriptionTextFromSemantic: 0,
    manualDescriptionText: 0
  };

  const updatedComics = [];
  const seenMatchedIds = new Set();

  for (const comic of index.comics) {
    const manualTranscript = manualTranscripts?.[comic.id];
    const hasManualComicText = Object.hasOwn(manualTranscript || {}, "comicText");
    const hasManualVoteyText = Object.hasOwn(manualTranscript || {}, "voteyText");
    const hasManualDescriptionText = Object.hasOwn(manualTranscript || {}, "descriptionText");
    const transcript = transcriptsById.get(comic.id);
    if (!transcript) {
      stats.unmatchedComics += 1;
      const manualDescriptionText = hasManualDescriptionText ? cleanTranscriptText(manualTranscript.descriptionText) : "";
      const nextComic = {
        ...comic,
        comicText: hasManualComicText ? cleanTranscriptText(manualTranscript.comicText) : comic.comicText || "",
        voteyText: hasManualVoteyText ? cleanTranscriptText(manualTranscript.voteyText) : comic.voteyText || "",
        descriptionText: hasManualDescriptionText ? manualDescriptionText : comic.descriptionText || "",
        comicTextSource: hasManualComicText ? "manual" : comic.comicTextSource || "tesseract",
        voteyTextSource: hasManualVoteyText ? "manual" : comic.voteyTextSource || (comic.voteyText ? "tesseract" : ""),
        descriptionTextSource: hasManualDescriptionText ? "manual" : comic.descriptionTextSource || (comic.descriptionText ? "tesseract" : "")
      };
      if (hasManualComicText) stats.manualComicText += 1;
      if (hasManualVoteyText) stats.manualVoteyText += 1;
      if (hasManualDescriptionText) stats.manualDescriptionText += 1;
      updatedComics.push(nextComic);
      await updateCachedRecord(nextComic);
      continue;
    }

    seenMatchedIds.add(comic.id);
    stats.matchedComics += 1;

    const semanticComicText = applySemanticCorrections(comic.id, "comicText", transcript.comicText);
    const semanticVoteyText = applySemanticCorrections(comic.id, "voteyText", transcript.voteyText);
    const semanticDescriptionText = applySemanticCorrections(comic.id, "descriptionText", transcript.descriptionText);
    const nextComic = {
      ...comic,
      comicText: hasManualComicText ? cleanTranscriptText(manualTranscript.comicText) : semanticComicText,
      voteyText: hasManualVoteyText ? cleanTranscriptText(manualTranscript.voteyText) : semanticVoteyText,
      descriptionText: hasManualDescriptionText ? cleanTranscriptText(manualTranscript.descriptionText) : semanticDescriptionText,
      comicTextSource: hasManualComicText ? "manual" : sourceName,
      voteyTextSource: hasManualVoteyText
        ? "manual"
        : semanticVoteyText
          ? sourceName
          : "",
      descriptionTextSource: hasManualDescriptionText
        ? "manual"
        : semanticDescriptionText
          ? sourceName
          : "",
      semanticTranscriptUrl: transcript.sourceUrl
    };

    if (hasManualComicText) stats.manualComicText += 1;
    else if (semanticComicText) stats.comicTextFromSemantic += 1;
    if (hasManualVoteyText) stats.manualVoteyText += 1;
    else if (semanticVoteyText) stats.voteyTextFromSemantic += 1;
    if (hasManualDescriptionText) stats.manualDescriptionText += 1;
    else if (semanticDescriptionText) stats.descriptionTextFromSemantic += 1;

    updatedComics.push(nextComic);
    await updateCachedRecord(nextComic);
  }

  stats.unmatchedSourceTranscripts = transcripts.filter((transcript) => !seenMatchedIds.has(transcript.smbcId)).length;

  const nextIndex = {
    ...index,
    generatedAt: new Date().toISOString(),
    semanticImportedAt: new Date().toISOString(),
    fields: ["comicText", "hoverText", "voteyText", "descriptionText"],
    semanticSource: {
      name: sourceName,
      url: sourceOrigin,
      note:
        "AI-generated semantic transcripts are split into visible comic/votey text and visual descriptions where they can be mapped to official SMBC URLs. Official SMBC hover text is kept from the original page.",
      stats
    },
    comics: updatedComics
  };

  if (options.dryRun) {
    console.log(JSON.stringify(stats, null, 2));
    return;
  }

  await writeJsonAtomic(publicIndexPath, nextIndex);
  await writeJsonAtomic(dataIndexPath, nextIndex);
  console.log(JSON.stringify(stats, null, 2));
}

function parseArgs(args) {
  const options = {
    concurrency: 4,
    delayMs: 50,
    dryRun: false,
    limit: 0,
    refreshList: false,
    refreshPages: false
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const readNumber = (name) => {
      const value = args[i + 1];
      if (!value || value.startsWith("--")) throw new Error(`${name} expects a number`);
      i += 1;
      return Number(value);
    };

    if (arg === "--concurrency") options.concurrency = readNumber(arg);
    else if (arg === "--delay-ms") options.delayMs = readNumber(arg);
    else if (arg === "--limit") options.limit = readNumber(arg);
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--refresh-list") options.refreshList = true;
    else if (arg === "--refresh-pages") options.refreshPages = true;
    else throw new Error(`Unknown option: ${arg}`);
  }

  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) throw new Error("--concurrency must be a positive integer");
  if (!Number.isInteger(options.delayMs) || options.delayMs < 0) throw new Error("--delay-ms must be a non-negative integer");
  if (!Number.isInteger(options.limit) || options.limit < 0) throw new Error("--limit must be a non-negative integer");
  return options;
}

async function ensureDirs() {
  await Promise.all([semanticDir, listDir, pageDir].map((dir) => mkdir(dir, { recursive: true })));
}

async function loadSourceEntries(options) {
  const firstPage = await loadListPage(1, options);
  const totalPages = pageCount(firstPage);
  const htmlPages = [firstPage];

  for (let page = 2; page <= totalPages; page += 1) {
    htmlPages.push(await loadListPage(page, options));
  }

  const entries = [];
  const seen = new Set();
  for (const html of htmlPages) {
    const $ = cheerio.load(html);
    $("ul.comic-list a[href^='/comic/']").each((_, element) => {
      const href = $(element).attr("href");
      if (!href || seen.has(href)) return;
      seen.add(href);
      entries.push({
        href,
        label: squashWhitespace($(element).text()),
        sourceUrl: new URL(href, sourceOrigin).toString()
      });
    });
  }

  return options.limit ? entries.slice(0, options.limit) : entries;
}

async function loadListPage(page, options) {
  const cachePath = path.join(listDir, `series-${String(page).padStart(2, "0")}.html`);
  if (!options.refreshList && (await exists(cachePath))) return readFile(cachePath, "utf8");

  const url = new URL(page === 1 ? seriesPath : `${seriesPath}${page}/`, sourceOrigin).toString();
  const html = await fetchText(url, options);
  await writeFileAtomic(cachePath, html);
  return html;
}

function pageCount(html) {
  const match = /Page\s+\d+\s+of\s+(\d+)/i.exec(html);
  return match ? Number(match[1]) : 1;
}

async function loadTranscripts(entries, options) {
  const transcripts = [];
  await runPool(entries, options.concurrency, async (entry, index) => {
    const html = await loadTranscriptPage(entry, options);
    const transcript = parseTranscriptPage(entry, html);
    if (transcript?.smbcId) transcripts.push(transcript);
    const done = index + 1;
    if (done % 250 === 0 || done === entries.length) {
      console.log(`${String(done).padStart(5, " ")}/${entries.length} semantic transcripts`);
    }
  });
  return transcripts.sort((left, right) => left.smbcId.localeCompare(right.smbcId));
}

async function loadTranscriptPage(entry, options) {
  const id = entry.href.replace(/^\/comic\//, "").replace(/\/$/, "");
  const cachePath = path.join(pageDir, `${id}.html`);
  if (!options.refreshPages && (await exists(cachePath))) return readFile(cachePath, "utf8");

  const html = await fetchText(entry.sourceUrl, options);
  await writeFileAtomic(cachePath, html);
  return html;
}

function parseTranscriptPage(entry, html) {
  const $ = cheerio.load(html);
  const originalUrl = $("p.src a[href*='smbc-comics.com/comic/']").first().attr("href") || "";
  const originalSlug = smbcSlug(originalUrl);
  if (!originalSlug) return null;

  const transcriptText = htmlToText($, "section.transcript .body");
  const split = splitTranscript(transcriptText);
  const comicParts = extractVisibleTextAndDescription(split.comicText);
  const voteyParts = extractVisibleTextAndDescription(split.voteyText);
  const descriptionText = cleanTranscriptText([comicParts.description, voteyParts.description].filter(Boolean).join("\n\n"));

  return {
    sourceUrl: entry.sourceUrl,
    label: entry.label,
    originalUrl,
    originalSlug,
    smbcId: stableId(originalSlug),
    comicText: cleanTranscriptText(comicParts.text),
    voteyText: cleanTranscriptText(voteyParts.text),
    comicDescription: cleanTranscriptText(comicParts.description),
    voteyDescription: cleanTranscriptText(voteyParts.description),
    descriptionText,
    altText: cleanTranscriptText(htmlToText($, "section.alt .body")),
    model: squashWhitespace($(".model").first().text())
  };
}

function htmlToText($, selector) {
  const html = $(selector).first().html() || "";
  if (!html) return "";
  const withBreaks = html.replace(/<br\s*\/?>/gi, "\n");
  return cheerio
    .load(`<body>${withBreaks}</body>`)("body")
    .text()
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitTranscript(text) {
  const lines = String(text || "").split("\n");
  const voteyIndex = lines.findIndex((line) => /^Votey(?:\s*\([^)]*\))?\s*:/i.test(line.trim()));
  if (voteyIndex === -1) return { comicText: text, voteyText: "" };

  const voteyFirstLine = lines[voteyIndex].replace(/^Votey(?:\s*\([^)]*\))?\s*:\s*/i, "").trim();
  return {
    comicText: lines.slice(0, voteyIndex).join("\n"),
    voteyText: [voteyFirstLine, ...lines.slice(voteyIndex + 1)].filter((line) => line.trim()).join("\n")
  };
}

function cleanTranscriptText(text) {
  return String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractVisibleTextAndDescription(text) {
  const visible = [];
  const description = [];
  const lines = String(text || "").split("\n");
  let captureTextBlock = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (isPanelMarker(line)) {
      captureTextBlock = false;
    }

    const labeled = splitLabel(line);
    if (labeled) {
      const labelText = visibleTextFromLabel(labeled.label);
      if (labelText.length) visible.push(...labelText);

      if (labeled.value) {
        if (isVisibleTextLabel(labeled.label, labeled.value)) {
          visible.push(...visibleValueTexts(labeled.value));
          const labelDescription = descriptionFromLabel(labeled.label);
          if (labelDescription) description.push(labelDescription);
        } else {
          description.push(line);
        }
        captureTextBlock = false;
        continue;
      }

      if (startsTextBlock(labeled.label)) {
        captureTextBlock = true;
        continue;
      }

      if (isPanelMarker(line)) continue;
    }

    if (captureTextBlock) {
      if (isPanelMarker(line)) {
        captureTextBlock = false;
      } else if (isStandaloneVisibleText(line) || looksLikeVisibleText(line)) {
        visible.push(cleanVisibleText(line));
      } else if (isLikelyVisualDescription(line)) {
        captureTextBlock = false;
        description.push(line);
      } else {
        visible.push(cleanVisibleText(line));
      }
      continue;
    }

    const quotedText = quotedVisibleText(line);
    if (quotedText.length && !isLikelyExplanation(line)) {
      visible.push(...quotedText);
      const withoutQuotes = line.replace(/["“”][^"“”]+["“”]/g, "").trim();
      if (withoutQuotes) description.push(withoutQuotes);
      continue;
    }

    if (isStandaloneVisibleText(line)) {
      visible.push(cleanVisibleText(line));
    } else {
      description.push(line);
    }
  }

  const rescuedVisible = [];
  const keptDescription = [];
  for (const line of description) {
    if (!isLikelyVisualDescription(line) && (isStandaloneVisibleText(line) || looksLikeVisibleText(line))) {
      rescuedVisible.push(line);
    } else {
      keptDescription.push(line);
    }
  }

  return {
    text: dedupeLines([...visible, ...rescuedVisible.map(cleanVisibleText)]).join("\n"),
    description: dedupeLines(keptDescription).join("\n")
  };
}

function splitLabel(line) {
  const match = /^([^:]{1,180}):\s*(.*)$/.exec(line);
  if (!match) return null;
  return {
    label: match[1].trim(),
    value: match[2].trim()
  };
}

function isPanelMarker(line) {
  return /^Panel\s+\d+\b/i.test(line) || /^Final panel\b/i.test(line) || /^Votey\b/i.test(line);
}

function startsTextBlock(label) {
  return /\b(reads?|text|caption|label|labels|written|handwritten|screen|paper|newspaper|banner|sign|note|button|title|header|speech bubble|says?)\b/i.test(
    label
  );
}

function visibleTextFromLabel(label) {
  const text = [];
  const lower = label.toLowerCase();
  if (/\b(labeled|labelled|label|caption|header|title|banner)\b/.test(lower)) {
    text.push(...quotedVisibleText(label));
  }
  return text;
}

function isVisibleTextLabel(label, value) {
  const lower = label.toLowerCase();
  if (startsTextBlock(label)) return true;
  if (isPanelMarker(label)) return hasTextCue(lower) || looksLikeVisibleText(value);
  if (/^["“”']/.test(value)) return true;
  if (isVisualOnlyLabel(lower)) return false;
  if (looksLikeSpeakerLabel(label)) return true;
  return looksLikeVisibleText(value);
}

function hasTextCue(value) {
  return /\b(caption|header|title|banner|label|labeled|labelled|text|sign|screen|button|speech|thought|star)\b/.test(value);
}

function looksLikeSpeakerLabel(label) {
  const lower = label.toLowerCase();
  if (hasTextCue(lower)) return true;
  if (isVisualOnlyLabel(lower) || isPanelMarker(label)) return false;
  const words = label.split(/\s+/).filter(Boolean);
  if (words.length > 10) return false;
  return true;
}

function isVisualOnlyLabel(lowerLabel) {
  return /\b(setting|scene|background|illustration|drawing|diagram|view|wide shot|close-up|close up|same scene|silent panel|final wide panel|image|photo|graph|chart)\b/.test(
    lowerLabel
  );
}

function looksLikeVisibleText(value) {
  const cleaned = cleanVisibleText(value);
  if (!cleaned) return false;
  if (/^["“”']/.test(value)) return true;
  const letters = cleaned.match(/[A-Za-z]/g) || [];
  if (!letters.length) return /\d/.test(cleaned);
  const uppercase = letters.filter((letter) => letter === letter.toUpperCase()).length;
  return uppercase / letters.length > 0.55 || /[!?]$/.test(cleaned);
}

function isStandaloneVisibleText(line) {
  if (/^\(?[A-Z0-9][A-Z0-9\s.,!?'"’‘“”:#%&/;<>+=-]{2,}\)?$/.test(line)) return true;
  return /^[-\w ./:]+:\s+/.test(line) && looksLikeVisibleText(line);
}

function isLikelyVisualDescription(line) {
  const lower = line.toLowerCase();
  return /\b(close-up|close up|view|scene|setting|panel|illustration|drawing|diagram|background|shows?|appears?|standing|sitting|wearing|holding)\b/.test(
    lower
  );
}

function isLikelyExplanation(line) {
  return /\b(the joke|implying|implies|suggesting|suggests|because|meaning|pun)\b/i.test(line);
}

function quotedVisibleText(line) {
  const matches = [];
  const pattern = /["“”]([^"“”]{2,})["“”]/g;
  let match = pattern.exec(line);
  while (match) {
    matches.push(cleanVisibleText(match[1]));
    match = pattern.exec(line);
  }
  return matches.filter(Boolean);
}

function visibleValueTexts(value) {
  const quoted = quotedVisibleText(value);
  if (quoted.length) {
    const remainder = value.replace(/["“”][^"“”]+["“”]/g, "").replace(/[(),.;:\s-]+/g, "");
    if (!remainder) return quoted;
  }
  return [cleanVisibleText(value)].filter(Boolean);
}

function descriptionFromLabel(label) {
  const cleaned = label
    .replace(/\([^)]*(caption|label|labeled|labelled|title|banner)[^)]*\)/gi, "")
    .replace(/^Panel\s+\d+\s*/i, "")
    .trim();
  if (!cleaned || hasTextCue(cleaned.toLowerCase()) || looksLikeSpeakerLabel(cleaned)) return "";
  return cleaned.endsWith(".") ? cleaned : `${cleaned}.`;
}

function cleanVisibleText(text) {
  return String(text || "")
    .replace(/^[\s("'“”‘’]+|[\s)"'“”‘’]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupeLines(lines) {
  const seen = new Set();
  const deduped = [];
  for (const line of lines.map(cleanTranscriptText).filter(Boolean)) {
    const key = squashWhitespace(line).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(line);
  }
  return deduped;
}

function applySemanticCorrections(id, field, text) {
  let corrected = text;
  for (const correction of semanticCorrections) {
    if (correction.id === id && correction.field === field) {
      corrected = corrected.replace(correction.search, correction.replacement);
    }
  }
  return corrected;
}

function mapTranscriptsBySmbcId(transcripts) {
  const byId = new Map();
  for (const transcript of transcripts) {
    if (!byId.has(transcript.smbcId)) byId.set(transcript.smbcId, transcript);
  }
  return byId;
}

async function updateCachedRecord(comic) {
  const recordPath = path.join(recordDir, `${comic.id}.json`);
  const record = await readJsonIfExists(recordPath);
  if (!record) return;

  await writeJsonAtomic(recordPath, {
    ...record,
    comicText: comic.comicText,
    voteyText: comic.voteyText,
    descriptionText: comic.descriptionText,
    comicTextSource: comic.comicTextSource,
    voteyTextSource: comic.voteyTextSource,
    descriptionTextSource: comic.descriptionTextSource,
    semanticTranscriptUrl: comic.semanticTranscriptUrl,
    semanticUpdatedAt: new Date().toISOString()
  });
}

async function fetchText(url, options) {
  await sleep(options.delayMs);
  const response = await fetch(url, {
    headers: {
      "user-agent": userAgent,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    }
  });
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  return response.text();
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

function smbcSlug(url) {
  try {
    const parsed = new URL(url);
    const match = /^\/comic\/(.+)$/.exec(parsed.pathname);
    return match ? decodeURIComponent(match[1].replace(/\/$/, "")) : "";
  } catch {
    return "";
  }
}

function stableId(slug) {
  const safe = slug.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (safe) return safe;
  return createHash("sha1").update(slug).digest("hex").slice(0, 12);
}

function squashWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function readJsonIfExists(filePath) {
  try {
    return await readJson(filePath);
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

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms) {
  if (!ms) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}
