const fieldLabels = new Map([
  ["comicText", "Comic"],
  ["hoverText", "Hover"],
  ["voteyText", "Votey"]
]);

const fieldWeights = new Map([
  ["comicText", 3],
  ["hoverText", 2],
  ["voteyText", 2]
]);

const queryInput = document.querySelector("#query");
const searchForm = document.querySelector("#searchForm");
const filterInputs = Array.from(document.querySelectorAll("input[name='field']"));
const resultsElement = document.querySelector("#results");
const resultCountElement = document.querySelector("#resultCount");
const indexMetaElement = document.querySelector("#indexMeta");
const resultLimitElement = document.querySelector("#resultLimit");
const template = document.querySelector("#resultTemplate");

let index = null;
let normalizedComics = [];

init();

async function init() {
  try {
    const response = await fetch("/data/search-index.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`Index request failed with ${response.status}`);
    index = await response.json();
    normalizedComics = index.comics.map((comic) => ({
      ...comic,
      normalized: {
        comicText: normalize(comic.comicText),
        hoverText: normalize(comic.hoverText),
        voteyText: normalize(comic.voteyText)
      }
    }));
    indexMetaElement.textContent = `${index.totalIndexedComics.toLocaleString()} indexed`;
    runSearch();
  } catch (error) {
    indexMetaElement.textContent = "Index unavailable";
    resultsElement.innerHTML = `<div class="empty">Run npm run scrape first.</div>`;
    console.error(error);
  }
}

searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  runSearch();
});

queryInput.addEventListener("input", debounce(runSearch, 120));
resultLimitElement.addEventListener("change", runSearch);

filterInputs.forEach((input) => {
  input.addEventListener("change", () => {
    if (!selectedFields().length) input.checked = true;
    runSearch();
  });
});

function runSearch() {
  if (!index) return;

  const query = queryInput.value.trim();
  const fields = selectedFields();
  const limit = Number(resultLimitElement.value);
  const scored = query ? search(query, fields) : recent(fields);
  const visible = limit > 0 ? scored.slice(0, limit) : scored;

  renderResults(visible, scored.length, query);
}

function search(query, fields) {
  const normalizedQuery = normalize(query);
  const terms = tokenize(normalizedQuery);
  if (!terms.length) return recent(fields);

  return normalizedComics
    .map((comic) => {
      const matches = [];
      let score = 0;

      for (const field of fields) {
        const haystack = comic.normalized[field] || "";
        if (!haystack) continue;
        const fieldWeight = fieldWeights.get(field) || 1;
        let fieldScore = 0;

        if (haystack.includes(normalizedQuery)) {
          fieldScore += 20 + normalizedQuery.length / 6;
        }

        for (const term of terms) {
          const count = countOccurrences(haystack, term);
          if (count > 0) fieldScore += (8 + Math.min(count, 8) * 2) * fieldWeight;
        }

        if (fieldScore > 0) {
          matches.push(field);
          score += fieldScore;
        }
      }

      if (score === 0) return null;
      return { comic, score: score + recencyBoost(comic.date), matches };
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score || compareDateDesc(left.comic.date, right.comic.date));
}

function recent(fields) {
  return normalizedComics
    .filter((comic) => fields.some((field) => comic.normalized[field]))
    .slice()
    .sort((left, right) => compareDateDesc(left.date, right.date))
    .map((comic) => ({ comic, score: 0, matches: fields.filter((field) => comic.normalized[field]) }));
}

function renderResults(results, total, query) {
  resultsElement.replaceChildren();
  resultCountElement.textContent = query
    ? `${total.toLocaleString()} ${total === 1 ? "match" : "matches"}`
    : `${total.toLocaleString()} available`;

  if (!results.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = query ? "No matches" : "No indexed comics";
    resultsElement.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const result of results) {
    const node = template.content.firstElementChild.cloneNode(true);
    node.href = result.comic.url;
    node.querySelector("img").src = `/${result.comic.thumbnail}`;
    node.querySelector("img").alt = "";
    node.querySelector(".resultTitle").textContent = result.comic.title || result.comic.slug;
    node.querySelector(".resultDate").textContent = result.comic.date || result.comic.dateLabel || "";

    const badges = node.querySelector(".badges");
    badges.replaceChildren(
      ...result.matches.map((field) => {
        const badge = document.createElement("span");
        badge.className = `badge ${field}`;
        badge.textContent = fieldLabels.get(field);
        return badge;
      })
    );

    fragment.append(node);
  }
  resultsElement.append(fragment);
}

function selectedFields() {
  return filterInputs.filter((input) => input.checked).map((input) => input.value);
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

function countOccurrences(haystack, needle) {
  let count = 0;
  let offset = 0;
  while (offset < haystack.length) {
    const index = haystack.indexOf(needle, offset);
    if (index === -1) break;
    count += 1;
    offset = index + needle.length;
  }
  return count;
}

function recencyBoost(date) {
  if (!date) return 0;
  const year = Number(date.slice(0, 4));
  return Number.isFinite(year) ? Math.max(0, year - 2002) / 100 : 0;
}

function compareDateDesc(left, right) {
  return String(right || "").localeCompare(String(left || ""));
}

function debounce(fn, waitMs) {
  let timer = 0;
  return (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), waitMs);
  };
}
