import assert from "node:assert/strict";
import { test } from "node:test";

import { readSmbcResponse } from "./smbc-response.mjs";

const comicUrl = "https://www.smbc-comics.com/comic/revenge";
const archiveUrl = "https://www.smbc-comics.com/comic/archive";
const comicHtml = `<!doctype html><html><body>
  <img title="Linguists are cruel."
       src="https://www.smbc-comics.com/comics/1792532851-20261022.png" id="cc-comic">
  <div id="aftercomic"><img src="/comics/179253290520261022after.png"></div>
</body></html>`;
const archiveHtml = `<select class="archive" name='comic'>
  <option value="">Choose a comic</option>
  <option value="comic/revenge">October 22, 2026 - Revenge</option>
</select>`;

test("successful responses are returned unchanged", async () => {
  assert.equal(await readSmbcResponse(comicUrl, new Response(comicHtml)), comicHtml);
});

test("HTTP 500 comic pages retain comic, hover, and votey markup", async () => {
  assert.equal(await readSmbcResponse(comicUrl, new Response(comicHtml, { status: 500 })), comicHtml);
});

test("HTTP 500 comic pages support relative image URLs", async () => {
  const html = `<img id='cc-comic' src='/comics/1792532851-20261022.png'>`;
  assert.equal(await readSmbcResponse(comicUrl, new Response(html, { status: 500 })), html);
});

test("HTTP 500 archives require entries and tolerate different attribute formatting", async () => {
  assert.equal(await readSmbcResponse(archiveUrl, new Response(archiveHtml, { status: 500 })), archiveHtml);
});

test("genuine HTTP 500 error pages are rejected", async () => {
  for (const html of [
    "Internal Server Error",
    "<html><h1>Database unavailable</h1></html>",
    `<img id="cc-comic">`,
    `<img id="cc-comic" src="   ">`,
    `<img id="cc-comic" src="javascript:void(0)">`,
    `<img id="cc-comic" src="https://[invalid">`,
    `<div id="cc-comic" src="/comics/example.png"></div>`,
    `<!-- <img id="cc-comic" src="/comics/example.png"> -->`,
    `<meta property="og:image" content="/logo.png">`
  ]) {
    await assert.rejects(
      readSmbcResponse(comicUrl, new Response(html, { status: 500, statusText: "Internal Server Error" })),
      /Failed to fetch .*\/comic\/revenge: 500 Internal Server Error/
    );
  }
});

test("empty or unrelated archives are rejected even with a comic selector", async () => {
  for (const html of [
    `<select name="comic"></select>`,
    `<select name="comic"><option value="comic/">Choose a comic</option></select>`,
    `<select name="comic"><option value="other/revenge">Revenge</option></select>`,
    comicHtml
  ]) {
    await assert.rejects(readSmbcResponse(archiveUrl, new Response(html, { status: 500 })), /Failed to fetch/);
  }
});

test("the HTTP 500 exception is restricted to official SMBC page URLs", async () => {
  for (const url of [
    "https://example.com/comic/revenge",
    "https://www.smbc-comics.com.example.com/comic/revenge",
    "https://www.smbc-comics.com/other/revenge"
  ]) {
    await assert.rejects(readSmbcResponse(url, new Response(comicHtml, { status: 500 })), /Failed to fetch/);
  }
});

test("other HTTP errors remain fatal even when the response contains comic markup", async () => {
  for (const status of [403, 404, 429, 502, 503]) {
    await assert.rejects(readSmbcResponse(comicUrl, new Response(comicHtml, { status })), new RegExp(`: ${status}`));
  }
});
