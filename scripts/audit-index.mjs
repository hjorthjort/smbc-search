import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const index = await readJson(path.join(rootDir, "public", "data", "search-index.json"));
const archive = await readJson(path.join(rootDir, "data", "archive.json"));
const failures = [];
const latestOcrFallbackCount = 4;

const comicsById = new Map(index.comics.map((comic) => [comic.id, comic]));
const duplicateIds = index.comics.map((comic) => comic.id).filter((id, index, ids) => ids.indexOf(id) !== index);
const missingFromIndex = archive.entries.filter((entry) => !comicsById.has(entry.id));
const missingThumbs = [];

for (const comic of index.comics) {
  if (!comic.thumbnail || !(await exists(path.join(rootDir, "public", comic.thumbnail)))) {
    missingThumbs.push(comic.id);
  }
}

const emptyComicText = index.comics.filter((comic) => !String(comic.comicText || "").trim());
const emptyAllSearchableText = index.comics.filter(
  (comic) => ![comic.comicText, comic.hoverText, comic.voteyText, comic.title, comic.date, comic.slug].join("").trim()
);
const semanticComicText = index.comics.filter((comic) => comic.comicTextSource === "ohyesrobot");
const semanticVoteyText = index.comics.filter((comic) => comic.voteyTextSource === "ohyesrobot");
const semanticTranscriptUrls = index.comics.filter((comic) => comic.semanticTranscriptUrl);
const manualComicText = index.comics.filter((comic) => comic.comicTextSource === "manual");
const manualVoteyText = index.comics.filter((comic) => comic.voteyTextSource === "manual");
const tesseractComicText = index.comics.filter((comic) => comic.comicTextSource === "tesseract" || !comic.comicTextSource);
const tesseractVoteyText = index.comics.filter(
  (comic) => comic.voteyText && (comic.voteyTextSource === "tesseract" || !comic.voteyTextSource)
);
const latestOcrFallbackIds = new Set(archive.entries.slice(-latestOcrFallbackCount).map((entry) => entry.id));
const staleTesseractComicText = tesseractComicText.filter((comic) => !latestOcrFallbackIds.has(comic.id));
const staleTesseractVoteyText = tesseractVoteyText.filter((comic) => !latestOcrFallbackIds.has(comic.id));
const suspiciousOcr = findSuspiciousOcr(index.comics);

if (archive.entries.length !== index.totalArchiveComics) {
  failures.push(`Archive count mismatch: archive has ${archive.entries.length}, index says ${index.totalArchiveComics}.`);
}
if (index.comics.length !== index.totalIndexedComics) {
  failures.push(`Index count mismatch: comics has ${index.comics.length}, index says ${index.totalIndexedComics}.`);
}
if (archive.entries.length !== index.comics.length) {
  failures.push(`Coverage mismatch: archive has ${archive.entries.length}, index has ${index.comics.length}.`);
}
if (duplicateIds.length) failures.push(`Duplicate ids: ${duplicateIds.slice(0, 10).join(", ")}`);
if (missingFromIndex.length) failures.push(`Missing archive entries: ${missingFromIndex.slice(0, 10).map((entry) => entry.id).join(", ")}`);
if (missingThumbs.length) failures.push(`Missing thumbnails: ${missingThumbs.slice(0, 10).join(", ")}`);
if (emptyAllSearchableText.length) failures.push(`Records with no searchable text at all: ${emptyAllSearchableText.slice(0, 10).map((comic) => comic.id).join(", ")}`);
if (semanticComicText.length < 7700) {
  failures.push(`Semantic comic text coverage too low: ${semanticComicText.length} of ${index.comics.length}.`);
}
if (staleTesseractComicText.length) {
  failures.push(`Raw Tesseract comic text remains outside the newest ${latestOcrFallbackCount}: ${staleTesseractComicText.slice(0, 10).map((comic) => comic.id).join(", ")}`);
}
if (staleTesseractVoteyText.length) {
  failures.push(`Raw Tesseract votey text remains outside the newest ${latestOcrFallbackCount}: ${staleTesseractVoteyText.slice(0, 10).map((comic) => comic.id).join(", ")}`);
}

const probes = [
  { query: "meatmail", expectedId: "2014-12-17" },
  { query: "cheap information transfer", expectedId: "2014-12-17" },
  { query: "robotic minds", expectedId: "2014-12-17" },
  { query: "square root 64", expectedId: "2006-09-14" },
  { query: "popular science cosmopolitan", expectedId: "2014-11-22" },
  { query: "stokes theorem", expectedId: "2014-11-22" },
  { query: "2014-12-17", expectedId: "2014-12-17" }
];

for (const probe of probes) {
  const matches = search(probe.query, index.comics);
  if (!matches.some((match) => match.id === probe.expectedId)) {
    failures.push(`Search probe "${probe.query}" did not find ${probe.expectedId}.`);
  }
}

console.log(
  JSON.stringify(
    {
      generatedAt: index.generatedAt,
      archiveComics: archive.entries.length,
      indexedComics: index.comics.length,
      duplicateIds: duplicateIds.length,
      missingFromIndex: missingFromIndex.length,
      missingThumbs: missingThumbs.length,
      emptyComicText: emptyComicText.length,
      emptyAllSearchableText: emptyAllSearchableText.length,
      semanticComicText: semanticComicText.length,
      semanticVoteyText: semanticVoteyText.length,
      semanticTranscriptUrls: semanticTranscriptUrls.length,
      manualComicText: manualComicText.length,
      manualVoteyText: manualVoteyText.length,
      tesseractComicText: tesseractComicText.length,
      tesseractVoteyText: tesseractVoteyText.length,
      latestOcrFallbackIds: Array.from(latestOcrFallbackIds),
      staleTesseractComicText: staleTesseractComicText.length,
      staleTesseractVoteyText: staleTesseractVoteyText.length,
      suspiciousOcr: suspiciousOcr.length,
      suspiciousExamples: suspiciousOcr.slice(0, 20),
      probes: Object.fromEntries(probes.map((probe) => [probe.query, search(probe.query, index.comics).slice(0, 5).map((comic) => comic.id)]))
    },
    null,
    2
  )
);

if (failures.length) {
  console.error(`\nAudit failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  process.exitCode = 1;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function findSuspiciousOcr(comics) {
  return comics
    .map((comic) => {
      const text = normalize([comic.comicText, comic.hoverText, comic.voteyText].join(" "));
      const words = text ? text.split(" ") : [];
      const alpha = words.filter((word) => /[a-z]/.test(word));
      const weird = words.filter((word) => word.length > 24 || /[0-9].*[a-z]|[a-z].*[0-9]/.test(word));
      const shortRatio = alpha.length ? alpha.filter((word) => word.length <= 2).length / alpha.length : 1;
      return {
        id: comic.id,
        date: comic.date,
        title: comic.title,
        words: words.length,
        alpha: alpha.length,
        shortRatio: Number(shortRatio.toFixed(3)),
        weird: weird.slice(0, 5)
      };
    })
    .filter((entry) => entry.alpha === 0 || (entry.words > 0 && entry.words < 3) || (entry.alpha > 20 && entry.shortRatio > 0.72) || entry.weird.length >= 4)
    .sort((left, right) => left.alpha - right.alpha || right.shortRatio - left.shortRatio);
}

function search(query, comics) {
  const clauses = parseQuery(query);
  return comics.filter((comic) => {
    const fields = [
      comic.comicText,
      [comic.title, comic.date, comic.dateLabel, comic.slug, comic.url].join(" "),
      comic.hoverText,
      comic.voteyText
    ].map((field) => ({ normalized: normalize(field), tokens: tokenize(field) }));

    return clauses.every((clause) =>
      fields.some((field) => {
        if (clause.type === "phrase") return ` ${field.normalized} `.includes(` ${clause.value} `);
        if (field.normalized.includes(clause.value)) return true;
        return countFuzzyOccurrences(field.tokens, clause.value) > 0;
      })
    );
  });
}

function parseQuery(query) {
  const clauses = [];
  const quotedPattern = /"([^"]+)"/g;
  let withoutQuoted = query;
  let match = quotedPattern.exec(query);

  while (match) {
    const phrase = normalize(match[1]);
    if (phrase) clauses.push({ type: "phrase", value: phrase });
    match = quotedPattern.exec(query);
  }

  withoutQuoted = withoutQuoted.replace(quotedPattern, " ");
  for (const term of tokenize(withoutQuoted)) clauses.push({ type: "term", value: term });
  return clauses;
}

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value) {
  return normalize(value)
    .split(" ")
    .filter((term) => term.length > 1);
}

function countFuzzyOccurrences(tokens, term) {
  if (term.length < 5) return 0;
  return tokens.filter((token) => Math.abs(token.length - term.length) <= 1 && isEditDistanceAtMostOne(token, term)).length;
}

function isEditDistanceAtMostOne(left, right) {
  if (left === right) return true;
  if (Math.abs(left.length - right.length) > 1) return false;

  let edits = 0;
  let leftIndex = 0;
  let rightIndex = 0;

  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }

    edits += 1;
    if (edits > 1) return false;

    if (left.length > right.length) leftIndex += 1;
    else if (right.length > left.length) rightIndex += 1;
    else {
      leftIndex += 1;
      rightIndex += 1;
    }
  }

  return edits + (left.length - leftIndex) + (right.length - rightIndex) <= 1;
}
