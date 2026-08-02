// Agency OS — Live Dashboard data proxy
//
// This function exists only because Notion's API blocks direct calls from a
// browser (CORS). It receives the buyer's own integration token + database
// IDs from their browser on every request, calls the Notion API server-side,
// and returns the result. Nothing is stored, logged, or persisted here —
// the token lives only in the buyer's own browser (localStorage) and passes
// through this function on each page load.

const NOTION_VERSION = "2022-06-28";

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

  const { token, databases } = payload;
  // databases: { clients: "id", finance: "id", tasks: "id", team: "id", content: "id" }

  if (!token || !databases) {
    return {
      statusCode: 400,
      headers: cors,
      body: JSON.stringify({ error: "Missing token or databases" }),
    };
  }

  async function queryDatabase(databaseId) {
    if (!databaseId) return { results: [] };
    const res = await fetch(
      `https://api.notion.com/v1/databases/${databaseId}/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ page_size: 50 }),
      }
    );
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Notion API error (${res.status}): ${errText}`);
    }
    return res.json();
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
