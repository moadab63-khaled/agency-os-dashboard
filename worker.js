const NOTION_VERSION = "2022-06-28";
const NOTION_VERSION_DATA_SOURCES = "2025-09-03";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

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

async function handleNotionData(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return new Response("Invalid JSON body", { status: 400, headers: CORS });
  }

  const { token, action } = payload;

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
            content:
              "You are a social media content repurposer for a marketing agency. Given a piece of long-form content (title and body), produce 3 short repurposed pieces: (1) a LinkedIn post (3-5 sentences, professional tone), (2) a Twitter/X thread opener plus 2 follow-up tweets, (3) a one-line Instagram caption with 3 relevant hashtags. Format clearly with headers for each platform. Keep the total output concise and ready to copy-paste.",
          },
          {
            role: "user",
            content: `Title: ${title || "(untitled)"}\n\nBody:\n${body || "(no body provided)"}`,
          },
        ],
        max_tokens: 600,
      });
      const text = aiResult.response || "";
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
            content:
              "You are a financial analyst for a small creative/marketing agency. Given summary stats from their Finance database (paid revenue, pending amount, overdue amount, expense total, counts, net cash flow), write a short weekly financial insights summary in plain text (no markdown headers): 1) one headline sentence on overall financial health, 2) 2-3 short bullet-style observations (e.g. cash flow risk from overdue invoices, expense trends, pending backlog), 3) one concrete recommended next action. Keep the whole thing under 150 words.",
          },
          {
            role: "user",
            content: `Finance summary:\n${JSON.stringify(stats, null, 2)}`,
          },
        ],
        max_tokens: 400,
      });
      const text = aiResult.response || "";
      return json({ result: text });
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
    "Content-Type": "application/json",
  };

  const notionHeadersDataSources = {
    Authorization: `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION_DATA_SOURCES,
    "Content-Type": "application/json",
  };

  if (action === "create") {
    const { databaseId, properties } = payload;
    if (!databaseId || !properties) {
      return json({ error: "Missing databaseId or properties" }, 400);
    }
    try {
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
      const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
        method: "PATCH",
        headers: notionHeaders,
        body: JSON.stringify({ properties }),
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
      const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
        method: "PATCH",
        headers: notionHeaders,
        body: JSON.stringify({ archived: true }),
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
    return json(results);
  } catch (err) {
    return json({ error: err.message }, 502);
  }
}

export default {
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

    return env.ASSETS.fetch(request);
  },
};
