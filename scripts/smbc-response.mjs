import * as cheerio from "cheerio";

const siteOrigin = "https://www.smbc-comics.com";

export async function readSmbcResponse(url, response) {
  const html = await response.text();
  if (response.ok) return html;

  // SMBC sometimes returns complete pages with HTTP 500, including individual
  // comics since October 2026. Accept only recognizable content on official URLs.
  if (response.status === 500 && hasSmbcContent(url, html)) {
    console.warn(`SMBC returned HTTP 500 with valid page content; continuing: ${url}`);
    return html;
  }

  throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
}

function hasSmbcContent(url, html) {
  const pageUrl = new URL(url);
  if (pageUrl.origin !== siteOrigin) return false;

  const $ = cheerio.load(html);
  if (pageUrl.pathname === "/comic/archive") {
    return $("select[name='comic'] option[value^='comic/']")
      .toArray()
      .some((option) => $(option).attr("value").slice("comic/".length).trim());
  }

  if (!/^\/comic\/[^/]+\/?$/.test(pageUrl.pathname)) return false;
  const imageSrc = $("img#cc-comic").first().attr("src")?.trim();
  if (!imageSrc) return false;
  try {
    return ["http:", "https:"].includes(new URL(imageSrc, pageUrl).protocol);
  } catch {
    return false;
  }
}
