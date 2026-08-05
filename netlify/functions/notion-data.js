// Agency OS — Live Dashboard data proxy
//
// This function exists only because Notion's API blocks direct calls from a
// browser (CORS). It receives the buyer's own integration token + database
// IDs (or page data to write) from their browser on every request, calls the
// Notion API server-side, and returns the result. Nothing is stored, logged,
// or persisted here — the token lives only in the buyer's own browser
// (localStorage) and passes through this function on each request.
//
// Supports three request shapes, distinguished by payload.action:
//   (no action / "query")  — existing behavior: query multiple databases
//   "create"                — create a new page (record) in a database
//   "update"                — update properties on an existing page
//
// Notion recently introduced "multiple data sources per database". Older
// API versions (and the plain /v1/databases/{id}/query and
// parent:{database_id} endpoints) reject any database that has more than
// one data source with a 400 "multiple_data_sources_for_database" error.
// To stay robust regardless of how a buyer's workspace is set up, every
// database/create call below first tries the classic (legacy) approach,
// and — only if Notion reports that specific error — transparently
// resolves the database's data source(s) and retries against those
// instead. This requires no configuration and no manual Notion cleanup.

const NOTION_VERSION = "2022-06-28";
const NOTION_VERSION_DATA_SOURCES = "2025-09-03";

function isMultiDataSourceError(errText) {
  return typeof errText === "string" && errText.includes("multiple_data_sources_for_database");
}

async function getDataSourceIds(databaseId, token) {
  const res = await fetch(`https://api.notion.com/v1/databases/${databaseId}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION_DATA_SOURCES,
    },
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

exports.handler = async (event) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: cors, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: cors, body: "Method not allowed" };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 400, headers: cors, body: "Invalid JSON body" };
  }

  const { token, action } = payload;

  if (!token) {
    return {
      statusCode: 400,
      headers: cors,
      body: JSON.stringify({ error: "Missing token" }),
    };
  }

  const notionHeaders = {
    Authorization: `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };

  const notionHeadersDataSources = {
    Authorization: `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION_DATA_SOURCES,
    "Content-Type": "application/json",
  };

  // ---- WRITE: create a new record -----------------------------------
  if (action === "create") {
    const { databaseId, properties } = payload;
    if (!databaseId || !properties) {
      return {
        statusCode: 400,
        headers: cors,
        body: JSON.stringify({ error: "Missing databaseId or properties" }),
      };
    }
    try {
      // Try the classic single-data-source path first.
      let res = await fetch("https://api.notion.com/v1/pages", {
        method: "POST",
        headers: notionHeaders,
        body: JSON.stringify({
          parent: { database_id: databaseId },
          properties,
        }),
      });
      let data = await res.json();

      if (!res.ok && isMultiDataSourceError(JSON.stringify(data))) {
        // Database has multiple data sources — resolve and create against
        // the first one instead.
        const dataSourceIds = await getDataSourceIds(databaseId, token);
        res = await fetch("https://api.notion.com/v1/pages", {
          method: "POST",
          headers: notionHeadersDataSources,
          body: JSON.stringify({
            parent: { type: "data_source_id", data_source_id: dataSourceIds[0] },
            properties,
          }),
        });
        data = await res.json();
      }

      if (!res.ok) {
        throw new Error(data.message || `Notion API error (${res.status})`);
      }
      return {
        statusCode: 200,
        headers: { ...cors, "Content-Type": "application/json" },
        body: JSON.stringify(data),
      };
    } catch (err) {
      return {
        statusCode: 502,
        headers: cors,
        body: JSON.stringify({ error: err.message }),
      };
    }
  }

  // ---- WRITE: update an existing record ------------------------------
  if (action === "update") {
    const { pageId, properties } = payload;
    if (!pageId || !properties) {
      return {
        statusCode: 400,
        headers: cors,
        body: JSON.stringify({ error: "Missing pageId or properties" }),
      };
    }
    try {
      const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
        method: "PATCH",
        headers: notionHeaders,
        body: JSON.stringify({ properties }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || `Notion API error (${res.status})`);
      }
      return {
        statusCode: 200,
        headers: { ...cors, "Content-Type": "application/json" },
        body: JSON.stringify(data),
      };
    } catch (err) {
      return {
        statusCode: 502,
        headers: cors,
        body: JSON.stringify({ error: err.message }),
      };
    }
  }

  // ---- READ: query multiple databases (existing behavior) ------------
  const { databases } = payload;
  // databases: { clients: "id", finance: "id", tasks: "id", team: "id", content: "id" }

  if (!databases) {
    return {
      statusCode: 400,
      headers: cors,
      body: JSON.stringify({ error: "Missing databases" }),
    };
  }

  async function queryDataSource(dataSourceId) {
    const res = await fetch(
      `https://api.notion.com/v1/data_sources/${dataSourceId}/query`,
      {
        method: "POST",
        headers: notionHeadersDataSources,
        body: JSON.stringify({ page_size: 50 }),
      }
    );
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Notion API error (${res.status}): ${errText}`);
    }
    return res.json();
  }

  async function queryDatabase(databaseId) {
    if (!databaseId) return { results: [] };

    const res = await fetch(
      `https://api.notion.com/v1/databases/${databaseId}/query`,
      {
        method: "POST",
        headers: notionHeaders,
        body: JSON.stringify({ page_size: 50 }),
      }
    );

    if (res.ok) {
      return res.json();
    }

    const errText = await res.text();

    if (!isMultiDataSourceError(errText)) {
      throw new Error(`Notion API error (${res.status}): ${errText}`);
    }

    // Database has multiple data sources — resolve them and merge results
    // from every data source into a single combined result set.
    const dataSourceIds = await getDataSourceIds(databaseId, token);
    const perSource = await Promise.all(dataSourceIds.map(queryDataSource));
    const combinedResults = perSource.flatMap((r) => r.results || []);
    return { results: combinedResults };
  }

  try {
    const entries = Object.entries(databases).filter(([, id]) => !!id);
    const results = {};
    for (const [key, id] of entries) {
      results[key] = await queryDatabase(id);
    }
    return {
      statusCode: 200,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify(results),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: cors,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
