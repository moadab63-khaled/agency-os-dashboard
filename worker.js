var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var __defProp2 = Object.defineProperty;
var __name2 = /* @__PURE__ */ __name((target, value) => __defProp2(target, "name", { value, configurable: true }), "__name");
var __defProp22 = Object.defineProperty;
var __name22 = /* @__PURE__ */ __name2((target, value) => __defProp22(target, "name", { value, configurable: true }), "__name");
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
__name2(json, "json");
__name22(json, "json");
function isMultiDataSourceError(errText) {
  return typeof errText === "string" && errText.includes("multiple_data_sources_for_database");
}
__name(isMultiDataSourceError, "isMultiDataSourceError");
__name2(isMultiDataSourceError, "isMultiDataSourceError");
__name22(isMultiDataSourceError, "isMultiDataSourceError");
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
__name2(fetchWithRetry, "fetchWithRetry");
__name22(fetchWithRetry, "fetchWithRetry");
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
__name2(coerceAiText, "coerceAiText");
__name22(coerceAiText, "coerceAiText");
async function checkLicense(env, licenseKey) {
  if (!licenseKey || typeof licenseKey !== "string") {
    return { valid: false, reason: "missing" };
  }
  if (!env.LICENSES) {
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
__name2(checkLicense, "checkLicense");
__name22(checkLicense, "checkLicense");
async function handleAdminLicense(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const { adminSecret, licenseKey, status, edition, note, resetWorkspace } = payload;
  if (!env.ADMIN_SECRET || adminSecret !== env.ADMIN_SECRET) {
    return json({ error: "Unauthorized" }, 401);
  }
  if (!licenseKey || typeof licenseKey !== "string") {
    return json({ error: "Missing licenseKey" }, 400);
  }
  if (!env.LICENSES) {
    return json({ error: "LICENSES KV binding not configured on this Worker" }, 500);
  }
  const trimmedKey = licenseKey.trim();
  let existing = {};
  const rawExisting = await env.LICENSES.get(trimmedKey);
  if (rawExisting) {
    try {
      existing = JSON.parse(rawExisting);
    } catch (e) {
      existing = {};
    }
  }
  const record = {
    ...existing,
    status: status === "revoked" ? "revoked" : "active",
    edition: edition || existing.edition || null,
    note: note !== void 0 ? note : existing.note || "",
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  if (resetWorkspace === true) {
    delete record.notionWorkspaceId;
    delete record.notionWorkspaceName;
    delete record.notionAccessToken;
    delete record.connectedAt;
  }
  await env.LICENSES.put(trimmedKey, JSON.stringify(record));
  return json({ ok: true, licenseKey: trimmedKey, record });
}
__name(handleAdminLicense, "handleAdminLicense");
__name2(handleAdminLicense, "handleAdminLicense");
__name22(handleAdminLicense, "handleAdminLicense");
var OAUTH_STATE_TTL_SECONDS = 600;
var RECONNECT_COOLDOWN_MS = 48 * 60 * 60 * 1e3;
function dashboardBaseUrl(request) {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}
__name(dashboardBaseUrl, "dashboardBaseUrl");
__name2(dashboardBaseUrl, "dashboardBaseUrl");
__name22(dashboardBaseUrl, "dashboardBaseUrl");
function redirectToDashboard(request, params) {
  const base = dashboardBaseUrl(request);
  const qs = new URLSearchParams(params).toString();
  return Response.redirect(`${base}/?${qs}`, 302);
}
__name(redirectToDashboard, "redirectToDashboard");
__name2(redirectToDashboard, "redirectToDashboard");
__name22(redirectToDashboard, "redirectToDashboard");
async function handleOAuthStart(request, env) {
  const url = new URL(request.url);
  const licenseKey = (url.searchParams.get("licenseKey") || "").trim();
  if (!licenseKey) {
    return redirectToDashboard(request, { connect: "missing_license" });
  }
  const licenseCheck = await checkLicense(env, licenseKey);
  if (!licenseCheck.valid) {
    return redirectToDashboard(request, { connect: "invalid_license" });
  }
  if (!env.NOTION_CLIENT_ID) {
    return redirectToDashboard(request, { connect: "not_configured" });
  }
  const state = crypto.randomUUID();
  await env.LICENSES.put(`oauth_state:${state}`, licenseKey, {
    expirationTtl: OAUTH_STATE_TTL_SECONDS
  });
  const redirectUri = `${dashboardBaseUrl(request)}/oauth/callback`;
  const authorizeUrl = new URL("https://api.notion.com/v1/oauth/authorize");
  authorizeUrl.searchParams.set("client_id", env.NOTION_CLIENT_ID);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("owner", "user");
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("state", state);
  return Response.redirect(authorizeUrl.toString(), 302);
}
__name(handleOAuthStart, "handleOAuthStart");
__name2(handleOAuthStart, "handleOAuthStart");
__name22(handleOAuthStart, "handleOAuthStart");
async function handleOAuthCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const notionError = url.searchParams.get("error");
  if (notionError) {
    return redirectToDashboard(request, { connect: "denied" });
  }
  if (!code || !state) {
    return redirectToDashboard(request, { connect: "bad_request" });
  }
  const stateKey = `oauth_state:${state}`;
  const licenseKey = await env.LICENSES.get(stateKey);
  if (!licenseKey) {
    return redirectToDashboard(request, { connect: "expired" });
  }
  await env.LICENSES.delete(stateKey);
  if (!env.NOTION_CLIENT_ID || !env.NOTION_CLIENT_SECRET) {
    return redirectToDashboard(request, { connect: "not_configured" });
  }
  const redirectUri = `${dashboardBaseUrl(request)}/oauth/callback`;
  const basicAuth = btoa(`${env.NOTION_CLIENT_ID}:${env.NOTION_CLIENT_SECRET}`);
  let tokenRes;
  try {
    tokenRes = await fetch("https://api.notion.com/v1/oauth/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri
      })
    });
  } catch (e) {
    return redirectToDashboard(request, { connect: "token_exchange_failed" });
  }
  if (!tokenRes.ok) {
    return redirectToDashboard(request, { connect: "token_exchange_failed" });
  }
  const tokenData = await tokenRes.json();
  const {
    access_token: accessToken,
    workspace_id: workspaceId,
    workspace_name: workspaceName
  } = tokenData;
  if (!accessToken || !workspaceId) {
    return redirectToDashboard(request, { connect: "token_exchange_failed" });
  }
  const rawRecord = await env.LICENSES.get(licenseKey);
  let record = {};
  if (rawRecord) {
    try {
      record = JSON.parse(rawRecord);
    } catch (e) {
      record = {};
    }
  }
  if (record.notionWorkspaceId && record.notionWorkspaceId !== workspaceId) {
    return redirectToDashboard(request, { connect: "workspace_mismatch" });
  }
  if (record.lastWorkspaceId && record.lastWorkspaceId !== workspaceId) {
    const elapsedMs = Date.now() - new Date(record.lastDisconnectedAt || 0).getTime();
    if (elapsedMs < RECONNECT_COOLDOWN_MS) {
      return redirectToDashboard(request, { connect: "cooldown" });
    }
  }
  record.notionWorkspaceId = workspaceId;
  record.notionWorkspaceName = workspaceName || null;
  record.notionAccessToken = accessToken;
  record.connectedAt = (/* @__PURE__ */ new Date()).toISOString();
  await env.LICENSES.put(licenseKey, JSON.stringify(record));
  return redirectToDashboard(request, { connect: "success" });
}
__name(handleOAuthCallback, "handleOAuthCallback");
__name2(handleOAuthCallback, "handleOAuthCallback");
__name22(handleOAuthCallback, "handleOAuthCallback");
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
__name2(getDataSourceIds, "getDataSourceIds");
__name22(getDataSourceIds, "getDataSourceIds");
var DB_NAME_ALIASES = {
  team: ["team"],
  clients: ["clients", "client"],
  projects: ["projects", "project"],
  tasks: ["tasks", "task"],
  finance: ["finance", "financial"],
  content: ["content calendar", "content", "calendar"],
  timeEntries: ["time entries", "time entry", "time tracking", "timesheet"]
};
var REQUIRED_DB_KEYS = ["clients", "finance"];
function normalizeNotionId(idOrUrl) {
  if (!idOrUrl || typeof idOrUrl !== "string") return null;
  const cleaned = idOrUrl.split("?")[0].split("#")[0];
  const hexMatch = cleaned.replace(/-/g, "").match(/([0-9a-fA-F]{32})(?!.*[0-9a-fA-F]{32})/);
  if (!hexMatch) return null;
  const hex = hexMatch[1].toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
__name(normalizeNotionId, "normalizeNotionId");
__name2(normalizeNotionId, "normalizeNotionId");
__name22(normalizeNotionId, "normalizeNotionId");
async function fetchChildDatabaseBlocks(blockId, token) {
  const found = [];
  let cursor = void 0;
  let page = 0;
  const MAX_PAGES = 10;
  do {
    const qs = cursor ? `?start_cursor=${encodeURIComponent(cursor)}&page_size=100` : "?page_size=100";
    const res = await fetchWithRetry(`https://api.notion.com/v1/blocks/${blockId}/children${qs}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION
      }
    });
    if (!res.ok) {
      const errText = await res.text();
      const err = new Error(`Notion API error (${res.status}) listing page contents: ${errText}`);
      err.notionStatus = res.status;
      throw err;
    }
    const data = await res.json();
    for (const block of data.results || []) {
      if (block.type === "child_database") {
        found.push({
          id: block.id,
          title: block.child_database && block.child_database.title || ""
        });
      }
    }
    cursor = data.has_more ? data.next_cursor : null;
    page++;
  } while (cursor && page < MAX_PAGES);
  return found;
}
__name(fetchChildDatabaseBlocks, "fetchChildDatabaseBlocks");
__name2(fetchChildDatabaseBlocks, "fetchChildDatabaseBlocks");
__name22(fetchChildDatabaseBlocks, "fetchChildDatabaseBlocks");
function matchDatabasesToKeys(childDatabases) {
  const found = {};
  const usedIds = /* @__PURE__ */ new Set();
  for (const key of Object.keys(DB_NAME_ALIASES)) {
    const aliases = DB_NAME_ALIASES[key];
    const match = childDatabases.find((db) => {
      if (usedIds.has(db.id)) return false;
      const title = (db.title || "").trim().toLowerCase();
      return aliases.includes(title);
    });
    if (match) {
      found[key] = match.id;
      usedIds.add(match.id);
    }
  }
  const missing = Object.keys(DB_NAME_ALIASES).filter((key) => !found[key]);
  const missingRequired = REQUIRED_DB_KEYS.filter((key) => !found[key]);
  return { found, missing, missingRequired };
}
__name(matchDatabasesToKeys, "matchDatabasesToKeys");
__name2(matchDatabasesToKeys, "matchDatabasesToKeys");
__name22(matchDatabasesToKeys, "matchDatabasesToKeys");
async function handleDiscoverDatabases(payload, token) {
  const { pageUrl } = payload;
  const pageId = normalizeNotionId(pageUrl);
  if (!pageId) {
    return json({
      error: "Could not read a Notion page ID from that link. Please double-check the page URL."
    }, 400);
  }
  let childDatabases;
  try {
    childDatabases = await fetchChildDatabaseBlocks(pageId, token);
  } catch (err) {
    if (err.notionStatus === 404) {
      return json({
        error: "Could not access that page. Either the link is wrong, or you haven't shared this page with your integration yet (Share -> Connections -> add your integration)."
      }, 404);
    }
    if (err.notionStatus === 401) {
      return json({
        error: "That Notion token was not accepted. Please double-check you copied the full token correctly."
      }, 401);
    }
    return json({ error: err.message }, 502);
  }
  if (!childDatabases.length) {
    return json({
      error: "No databases were found on that page. Make sure you shared the main workspace page (the one containing Clients, Finance and your other databases) with your integration -- not a sub-page like Command Center.",
      all: []
    }, 404);
  }
  const { found, missing, missingRequired } = matchDatabasesToKeys(childDatabases);
  if (missingRequired.length) {
    return json({
      error: `Found this page, but could not find: ${missingRequired.join(", ")}. These are required to connect -- make sure none of the database names were changed.`,
      found,
      missing,
      all: childDatabases
    }, 404);
  }
  return json({ ok: true, databases: found, missing, all: childDatabases });
}
__name(handleDiscoverDatabases, "handleDiscoverDatabases");
__name2(handleDiscoverDatabases, "handleDiscoverDatabases");
__name22(handleDiscoverDatabases, "handleDiscoverDatabases");
async function fetchAllAccessiblePages(token) {
  const found = [];
  let cursor = void 0;
  let page = 0;
  const MAX_PAGES = 10;
  do {
    const res = await fetchWithRetry("https://api.notion.com/v1/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        filter: { value: "page", property: "object" },
        page_size: 100,
        ...cursor ? { start_cursor: cursor } : {}
      })
    });
    if (!res.ok) {
      const errText = await res.text();
      const err = new Error(`Notion API error (${res.status}) searching accessible pages: ${errText}`);
      err.notionStatus = res.status;
      throw err;
    }
    const data = await res.json();
    for (const item of data.results || []) {
      let titleText = "";
      const titleProp = item.properties && Object.values(item.properties).find((p) => p && p.type === "title");
      if (titleProp && Array.isArray(titleProp.title)) {
        titleText = titleProp.title.map((t) => t.plain_text || "").join("");
      }
      found.push({ id: item.id, url: item.url || null, parent: item.parent || null, title: titleText });
    }
    cursor = data.has_more ? data.next_cursor : null;
    page++;
  } while (cursor && page < MAX_PAGES);
  return found;
}
__name(fetchAllAccessiblePages, "fetchAllAccessiblePages");
__name2(fetchAllAccessiblePages, "fetchAllAccessiblePages");
__name22(fetchAllAccessiblePages, "fetchAllAccessiblePages");
function pickMainPage(pages, edition) {
  if (!pages || !pages.length) return { page: null, reason: "none" };
  // Prefer a top-level page (direct child of the workspace root) -- this is
  // the one buyers are told to share with their integration. Falling back to
  // the full list only if none are top-level (unusual, but keeps discovery
  // from failing outright).
  const topLevel = pages.filter((p) => p.parent && p.parent.type === "workspace");
  const candidates = topLevel.length ? topLevel : pages;
  // Edition-aware disambiguation AND enforcement: the purchased license
  // records which edition this buyer is on. If we know the edition, the
  // connected page must actually be that edition's page -- both to pick
  // correctly when more than one top-level page is accessible (e.g. a
  // workspace holding both a Freelancer and an Agency template), and to
  // REJECT the connection outright if only a mismatched edition's page is
  // available (e.g. a Freelancer license pointed at an Agency workspace).
  // A licensed buyer should never be able to pull an edition's data/features
  // (Team, Agency-only automations, etc.) that they didn't purchase.
  if (edition) {
    const editionMatch = candidates.find(
      (p) => (p.title || "").toLowerCase().includes(`${edition.toLowerCase()} edition`)
    );
    if (editionMatch) return { page: { id: editionMatch.id, url: editionMatch.url || null }, reason: "ok" };
    return { page: null, reason: "edition_mismatch" };
  }
  const chosen = candidates[0];
  if (!chosen) return { page: null, reason: "none" };
  return { page: { id: chosen.id, url: chosen.url || null }, reason: "ok" };
}
__name(pickMainPage, "pickMainPage");
__name2(pickMainPage, "pickMainPage");
__name22(pickMainPage, "pickMainPage");
async function handleDiscoverDatabasesViaSearch(token, edition) {
  // IMPORTANT: this scopes discovery to the child databases of ONE identified
  // page, rather than searching for databases by title across every database
  // the token can access. A pure title-based global search breaks down the
  // moment more than one accessible database shares a name (e.g. duplicate
  // template copies in a testing workspace, or a buyer who duplicated the
  // template twice) -- Notion's Search API result order isn't guaranteed
  // stable, so the wrong same-named database could silently get matched on
  // any reconnect, with no error (just an empty-looking dashboard).
  let accessiblePages;
  try {
    accessiblePages = await fetchAllAccessiblePages(token);
  } catch (err) {
    if (err.notionStatus === 401) {
      return json({
        error: "Your Notion connection is no longer valid. Please reconnect via Settings."
      }, 401);
    }
    return json({ error: err.message }, 502);
  }
  if (!accessiblePages.length) {
    return json({
      error: "No pages were found. Make sure you selected the page containing Clients, Finance and your other databases when you clicked Allow on Notion's screen.",
      all: []
    }, 404);
  }
  const pick = pickMainPage(accessiblePages, edition);
  if (!pick.page) {
    if (pick.reason === "edition_mismatch") {
      return json({
        error: `This license is for the ${edition} edition, but the page(s) you connected don't match. Please reconnect via Settings and make sure you select your ${edition} edition workspace page (its title should include "${edition[0].toUpperCase() + edition.slice(1)} Edition").`,
        all: []
      }, 403);
    }
    return json({
      error: "Could not identify your main workspace page. Please reconnect via Settings and make sure you select the top-level page containing your databases.",
      all: []
    }, 404);
  }
  const mainPage = pick.page;
  let childDatabases;
  try {
    childDatabases = await fetchChildDatabaseBlocks(mainPage.id, token);
  } catch (err) {
    if (err.notionStatus === 404) {
      return json({
        error: "Could not access the page you selected. Please reconnect via Settings."
      }, 404);
    }
    if (err.notionStatus === 401) {
      return json({
        error: "Your Notion connection is no longer valid. Please reconnect via Settings."
      }, 401);
    }
    return json({ error: err.message }, 502);
  }
  if (!childDatabases.length) {
    return json({
      error: "No databases were found on the page you selected. Make sure it's the main workspace page (the one containing Clients, Finance and your other databases).",
      all: []
    }, 404);
  }
  const { found, missing, missingRequired } = matchDatabasesToKeys(childDatabases);
  if (missingRequired.length) {
    return json({
      error: `Connected to Notion, but could not find: ${missingRequired.join(", ")}. Make sure you selected the right page when connecting, and that none of the database names were changed.`,
      found,
      missing,
      all: childDatabases
    }, 404);
  }
  return json({ ok: true, databases: found, missing, all: childDatabases, mainPageUrl: mainPage.url });
}
__name(handleDiscoverDatabasesViaSearch, "handleDiscoverDatabasesViaSearch");
__name2(handleDiscoverDatabasesViaSearch, "handleDiscoverDatabasesViaSearch");
__name22(handleDiscoverDatabasesViaSearch, "handleDiscoverDatabasesViaSearch");
async function handleNotionData(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return new Response("Invalid JSON body", { status: 400, headers: CORS });
  }
  const { action, licenseKey } = payload;
  let { token } = payload;
  if (action === "verify-license") {
    const result = await checkLicense(env, licenseKey);
    if (result.valid && env.LICENSES) {
      const rawRecord = await env.LICENSES.get(licenseKey.trim());
      if (rawRecord) {
        try {
          const record = JSON.parse(rawRecord);
          result.notionConnected = !!record.notionAccessToken;
          result.notionWorkspaceName = record.notionWorkspaceName || null;
        } catch (e) {
        }
      }
    }
    return json(result);
  }
  const licenseCheck = await checkLicense(env, licenseKey);
  if (!licenseCheck.valid) {
    return json({ error: "Invalid or missing product license.", reason: licenseCheck.reason }, 403);
  }
  if ((!token || token === "__oauth__") && licenseKey && env.LICENSES) {
    const rawRecord = await env.LICENSES.get(licenseKey.trim());
    if (rawRecord) {
      try {
        const record = JSON.parse(rawRecord);
        if (record.notionAccessToken) token = record.notionAccessToken;
      } catch (e) {
      }
    }
  }
  if (action === "disconnect-notion") {
    if (!env.LICENSES) {
      return json({ error: "Not configured" }, 500);
    }
    const trimmedKey = licenseKey.trim();
    const rawRecord = await env.LICENSES.get(trimmedKey);
    if (rawRecord) {
      let record;
      try {
        record = JSON.parse(rawRecord);
      } catch (e) {
        record = {};
      }
      const previousWorkspaceId = record.notionWorkspaceId;
      delete record.notionWorkspaceId;
      delete record.notionWorkspaceName;
      delete record.notionAccessToken;
      delete record.connectedAt;
      if (previousWorkspaceId) {
        record.lastWorkspaceId = previousWorkspaceId;
        record.lastDisconnectedAt = (/* @__PURE__ */ new Date()).toISOString();
      }
      await env.LICENSES.put(trimmedKey, JSON.stringify(record));
    }
    return json({ ok: true });
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
  if (action === "handoff-summary") {
    const { projectName, deliverables, completedTasks } = payload;
    if (!projectName) {
      return json({ error: "Missing projectName" }, 400);
    }
    try {
      const aiResult = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
        messages: [
          {
            role: "system",
            content: "You write client-facing project handoff notes for a marketing/creative agency. Given a project name, its deliverables description, and a list of completed task titles, write a short, professional handoff summary in plain text (no markdown headers): 1) one sentence confirming the project is complete and what was delivered, 2) a short bullet-style list of the concrete deliverables/completed items, 3) one sentence inviting the client to review and reach out with questions. Keep it under 120 words, warm but professional, and written as if the agency is sending it directly to the client."
          },
          {
            role: "user",
            content: `Project: ${projectName}

Deliverables: ${deliverables || "(none specified)"}

Completed tasks:
${(completedTasks || []).map((t) => `- ${t}`).join("\n") || "(none listed)"}`
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
  if (action === "discover-databases") {
    return handleDiscoverDatabases(payload, token);
  }
  if (action === "discover-databases-oauth") {
    return handleDiscoverDatabasesViaSearch(token, licenseCheck.edition);
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
  __name2(queryDataSource, "queryDataSource");
  __name22(queryDataSource, "queryDataSource");
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
  __name2(queryDatabase, "queryDatabase");
  __name22(queryDatabase, "queryDatabase");
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
__name2(handleNotionData, "handleNotionData");
__name22(handleNotionData, "handleNotionData");
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
    if (url.pathname === "/oauth/start" && request.method === "GET") {
      return handleOAuthStart(request, env);
    }
    if (url.pathname === "/oauth/callback" && request.method === "GET") {
      return handleOAuthCallback(request, env);
    }
    return env.ASSETS.fetch(request);
  }
};
export {
  worker_default as default
};
