var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var NOTION_VERSION = "2022-06-28";
var NOTION_VERSION_DATA_SOURCES = "2025-09-03";
var CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" }
  });
}
__name(json, "json");
function isMultiDataSourceError(errText) {
  return typeof errText === "string" && errText.includes("multiple_data_sources_for_database");
}
__name(isMultiDataSourceError, "isMultiDataSourceError");
async function fetchWithRetry(url, options, maxRetries = 1) {
  let attempt = 0;
  while (true) {
    const res = await fetch(url, options);
    if (res.status !== 429 || attempt >= maxRetries) return res;
    const retryAfterHeader = res.headers.get("Retry-After");
    const waitSec = Math.min(parseInt(retryAfterHeader, 10) || 1, 5);
    await new Promise((resolve) => setTimeout(resolve, waitSec * 1e3));
    attempt++;
  }
}
__name(fetchWithRetry, "fetchWithRetry");
function coerceAiText(raw) {
  if (typeof raw === "string") return raw;
  if (raw == null) return "";
  if (typeof raw === "object") {
    if (typeof raw.response === "string") return raw.response;
    if (Array.isArray(raw)) {
      return raw.map((item) => typeof item === "string" ? item : JSON.stringify(item)).join("\n");
    }
    return JSON.stringify(raw);
  }
  return String(raw);
}
__name(coerceAiText, "coerceAiText");

// ---------------------------------------------------------------------------
// LICENSE VERIFICATION
// ---------------------------------------------------------------------------
// KV binding expected: env.LICENSES (bind the "agency_os_licenses" namespace
// to this Worker in Settings -> Bindings, variable name LICENSES)
//
// A license record stored in KV looks like:
//   key:   the license key string, e.g. "AOS-XXXX-XXXX-XXXX"
//   value: JSON.stringify({ status: "active", edition: "agency", note: "" })
//
// status can be "active" or "revoked". Any other value, or a missing key,
// is treated as invalid.
async function checkLicense(env, licenseKey) {
  if (!licenseKey || typeof licenseKey !== "string") {
    return { valid: false, reason: "missing" };
  }
  if (!env.LICENSES) {
    // Binding not configured yet -- fail closed, not open.
    return { valid: false, reason: "not_configured" };
  }
  const raw = await env.LICENSES.get(licenseKey.trim());
  if (!raw) {
    return { valid: false, reason: "not_found" };
  }
  let record;
  try {
    record = JSON.parse(raw);
  } catch (e) {
    return { valid: false, reason: "corrupt_record" };
  }
  if (record.status !== "active") {
    return { valid: false, reason: "revoked" };
  }
  return { valid: true, edition: record.edition || null };
}
__name(checkLicense, "checkLicense");

// Admin endpoint to add/update/revoke a license key without touching the
// Cloudflare dashboard. Protected by env.ADMIN_SECRET (set this as a Worker
// secret: wrangler secret put ADMIN_SECRET, or via Settings -> Variables ->
// Encrypt).
async function handleAdminLicense(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const { adminSecret, licenseKey, status, edition, note } = payload;
  if (!env.ADMIN_SECRET || adminSecret !== env.ADMIN_SECRET) {
    return json({ error: "Unauthorized" }, 401);
  }
  if (!licenseKey || typeof licenseKey !== "string") {
    return json({ error: "Missing licenseKey" }, 400);
  }
  if (!env.LICENSES) {
    return json({ error: "LICENSES KV binding not configured on this Worker" }, 500);
  }
  const record = {
    status: status === "revoked" ? "revoked" : "active",
    edition: edition || null,
    note: note || "",
    updatedAt: new Date().toISOString()
  };
  await env.LICENSES.put(licenseKey.trim(), JSON.stringify(record));
  return json({ ok: true, licenseKey: licenseKey.trim(), record });
}
__name(handleAdminLicense, "handleAdminLicense");

async function getDataSourceIds(databaseId, token) {
  const res = await fetchWithRetry(`https://api.notion.com/v1/databases/${databaseId}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION_DATA_SOURCES
    }
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Notion API error (${res.status}) resolving data sources: ${errText}`);
  }
  const data = await res.json();
  const ids = (data.data_sources || []).map((ds) => ds.id).filter(Boolean);
  if (!ids.length) {
    throw new Error("Could not find any data sources for this database.");
  }
  return ids;
}
__name(getDataSourceIds, "getDataSourceIds");

async function handleNotionData(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return new Response("Invalid JSON body", { status: 400, headers: CORS });
  }
  const { token, action, licenseKey } = payload;

  // "verify-license" is the one action allowed with no prior valid license --
  // it's how the dashboard checks a key the user just typed in.
  if (action === "verify-license") {
    const result = await checkLicense(env, licenseKey);
    return json(result);
  }

  // Every other action requires a valid, active license key.
  const licenseCheck = await checkLicense(env, licenseKey);
  if (!licenseCheck.valid) {
    return json({ error: "Invalid or missing product license.", reason: licenseCheck.reason }, 403);
  }

  if (action === "repurpose") {
    const { title, body } = payload;
    if (!body && !title) {
      return json({ error: "Missing content to repurpose" }, 400);
    }
    try {
      const aiResult = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
        messages: [
          {
            role: "system",
            content: "You are a social media content repurposer for a marketing agency. Given a piece of long-form content (title and body), produce 3 short repurposed pieces: (1) a LinkedIn post (3-5 sentences, professional tone), (2) a Twitter/X thread opener plus 2 follow-up tweets, (3) a one-line Instagram caption with 3 relevant hashtags. Format clearly with headers for each platform. Keep the total output concise and ready to copy-paste."
          },
          {
            role: "user",
            content: `Title: ${title || "(untitled)"}

Body:
${body || "(no body provided)"}`
          }
        ],
        max_tokens: 600
      });
      const text = coerceAiText(aiResult.response);
      return json({ result: text });
    } catch (err) {
      return json({ error: err.message }, 502);
    }
  }
  if (action === "financial-insights") {
    const { stats } = payload;
    if (!stats) {
      return json({ error: "Missing stats" }, 400);
    }
    try {
      const aiResult = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
        messages: [
          {
            role: "system",
            content: "You are a financial analyst for a small creative/marketing agency. Given summary stats from their Finance database (paid revenue, pending amount, overdue amount, expense total, counts, net cash flow), write a short weekly financial insights summary in plain text (no markdown headers): 1) one headline sentence on overall financial health, 2) 2-3 short bullet-style observations (e.g. cash flow risk from overdue invoices, expense trends, pending backlog), 3) one concrete recommended next action. Keep the whole thing under 150 words."
          },
          {
            role: "user",
            content: `Finance summary:
${JSON.stringify(stats, null, 2)}`
          }
        ],
        max_tokens: 400
      });
      const text = coerceAiText(aiResult.response);
      return json({ result: text });
    } catch (err) {
      return json({ error: err.message }, 502);
    }
  }
  if (action === "meeting-to-action") {
    const { notes } = payload;
    if (!notes) {
      return json({ error: "Missing meeting notes" }, 400);
    }
    try {
      const aiResult = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
        messages: [
          {
            role: "system",
            content: 'You extract action items from meeting notes for a marketing agency. Given raw meeting notes, return ONLY a JSON array of short, clear task titles (max 10 words each), one per actionable item mentioned. No explanations, no markdown formatting, no numbering, no preamble \u2014 output must be nothing but a raw JSON array of strings, e.g. ["Send proposal to client", "Update project timeline"]. If no clear action items exist, return an empty array [].'
          },
          {
            role: "user",
            content: notes
          }
        ],
        max_tokens: 500
      });
      const text = coerceAiText(aiResult.response);
      let tasks = [];
      try {
        const match = text.match(/\[[\s\S]*\]/);
        if (match) {
          const parsed = JSON.parse(match[0]);
          if (Array.isArray(parsed)) tasks = parsed;
        }
      } catch (e) {
        tasks = [];
      }
      if (!tasks.length) {
        tasks = text.split(/\r?\n/).map(
          (line) => line.replace(/^[\-\*\u2022\d]+[\.\)]?\s*/, "").replace(/^["']|["']$/g, "").trim()
        ).filter((line) => line.length >= 3 && line.length <= 200 && /[\p{L}\p{N}]/u.test(line));
      }
      tasks = tasks.filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim());
      return json({ tasks });
    } catch (err) {
      return json({ error: err.message }, 502);
    }
  }
  if (!token) {
    return json({ error: "Missing token" }, 400);
  }
  const notionHeaders = {
    Authorization: `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json"
  };
  const notionHeadersDataSources = {
    Authorization: `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION_DATA_SOURCES,
    "Content-Type": "application/json"
  };
  if (action === "create") {
    const { databaseId, properties } = payload;
    if (!databaseId || !properties) {
      return json({ error: "Missing databaseId or properties" }, 400);
    }
    try {
      let res = await fetchWithRetry("https://api.notion.com/v1/pages", {
        method: "POST",
        headers: notionHeaders,
        body: JSON.stringify({
          parent: { database_id: databaseId },
          properties
        })
      });
      let data = await res.json();
      if (!res.ok && isMultiDataSourceError(JSON.stringify(data))) {
        const dataSourceIds = await getDataSourceIds(databaseId, token);
        res = await fetchWithRetry("https://api.notion.com/v1/pages", {
          method: "POST",
          headers: notionHeadersDataSources,
          body: JSON.stringify({
            parent: { type: "data_source_id", data_source_id: dataSourceIds[0] },
            properties
          })
        });
        data = await res.json();
      }
      if (!res.ok) {
        throw new Error(data.message || `Notion API error (${res.status})`);
      }
      return json(data);
    } catch (err) {
      return json({ error: err.message }, 502);
    }
  }
  if (action === "update") {
    const { pageId, properties } = payload;
    if (!pageId || !properties) {
      return json({ error: "Missing pageId or properties" }, 400);
    }
    try {
      const res = await fetchWithRetry(`https://api.notion.com/v1/pages/${pageId}`, {
        method: "PATCH",
        headers: notionHeaders,
        body: JSON.stringify({ properties })
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || `Notion API error (${res.status})`);
      }
      return json(data);
    } catch (err) {
      return json({ error: err.message }, 502);
    }
  }
  if (action === "delete") {
    const { pageId } = payload;
    if (!pageId) {
      return json({ error: "Missing pageId" }, 400);
    }
    try {
      const res = await fetchWithRetry(`https://api.notion.com/v1/pages/${pageId}`, {
        method: "PATCH",
        headers: notionHeaders,
        body: JSON.stringify({ archived: true })
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || `Notion API error (${res.status})`);
      }
      return json(data);
    } catch (err) {
      return json({ error: err.message }, 502);
    }
  }
  const { databases } = payload;
  if (!databases) {
    return json({ error: "Missing databases" }, 400);
  }
  const MAX_PAGES = 10;
  const PAGE_SIZE = 100;
  async function queryDataSource(dataSourceId) {
    let results2 = [];
    let cursor = void 0;
    let page = 0;
    do {
      const res = await fetchWithRetry(
        `https://api.notion.com/v1/data_sources/${dataSourceId}/query`,
        {
          method: "POST",
          headers: notionHeadersDataSources,
          body: JSON.stringify({
            page_size: PAGE_SIZE,
            ...cursor ? { start_cursor: cursor } : {}
          })
        }
      );
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Notion API error (${res.status}): ${errText}`);
      }
      const data = await res.json();
      results2 = results2.concat(data.results || []);
      cursor = data.has_more ? data.next_cursor : null;
      page++;
    } while (cursor && page < MAX_PAGES);
    return { results: results2 };
  }
  __name(queryDataSource, "queryDataSource");
  async function queryDatabase(databaseId) {
    if (!databaseId) return { results: [] };
    let results2 = [];
    let cursor = void 0;
    let page = 0;
    do {
      const res = await fetchWithRetry(
        `https://api.notion.com/v1/databases/${databaseId}/query`,
        {
          method: "POST",
          headers: notionHeaders,
          body: JSON.stringify({
            page_size: PAGE_SIZE,
            ...cursor ? { start_cursor: cursor } : {}
          })
        }
      );
      if (!res.ok) {
        const errText = await res.text();
        if (page === 0 && isMultiDataSourceError(errText)) {
          const dataSourceIds = await getDataSourceIds(databaseId, token);
          const perSource = await Promise.all(dataSourceIds.map(queryDataSource));
          return { results: perSource.flatMap((r) => r.results || []) };
        }
        throw new Error(`Notion API error (${res.status}): ${errText}`);
      }
      const data = await res.json();
      results2 = results2.concat(data.results || []);
      cursor = data.has_more ? data.next_cursor : null;
      page++;
    } while (cursor && page < MAX_PAGES);
    return { results: results2 };
  }
  __name(queryDatabase, "queryDatabase");
  const entries = Object.entries(databases).filter(([, id]) => !!id);
  const results = {};
  for (const [key, id] of entries) {
    try {
      results[key] = await queryDatabase(id);
    } catch (err) {
      results[key] = { results: [], error: err.message };
    }
  }
  return json(results);
}
__name(handleNotionData, "handleNotionData");

var worker_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/notion-data") {
      if (request.method === "OPTIONS") {
        return new Response("", { status: 200, headers: CORS });
      }
      if (request.method === "POST") {
        return handleNotionData(request, env);
      }
    }
    if (url.pathname === "/api/admin-license") {
      if (request.method === "OPTIONS") {
        return new Response("", { status: 200, headers: CORS });
      }
      if (request.method === "POST") {
        return handleAdminLicense(request, env);
      }
    }
    return env.ASSETS.fetch(request);
  }
};
export {
  worker_default as default
};
