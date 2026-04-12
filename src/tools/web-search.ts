import { registerCustomTool } from "../agent/tool-registry.js";

const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";

interface BraveWebResult {
  title: string;
  url: string;
  description: string;
}

interface BraveSearchResponse {
  web?: { results: BraveWebResult[] };
  query?: { original: string };
}

/**
 * Register the web_search tool. Requires BRAVE_SEARCH_API_KEY.
 *
 * Uses Brave Search API — free tier allows 2000 queries/month.
 * Returns concise formatted results for the agent to synthesize.
 */
export function registerWebSearchTool(): void {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) {
    console.log("BRAVE_SEARCH_API_KEY not set — web search tool disabled");
    return;
  }

  registerCustomTool({
    name: "web_search",
    description:
      "Search the web for current information. Use this when users ask about " +
      "recent events, facts you're unsure about, or anything that benefits from " +
      "live web results. Returns top search results with titles, URLs, and snippets.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query",
        },
        count: {
          type: "number",
          description: "Number of results to return (default 5, max 10)",
        },
      },
      required: ["query"],
    },
    handler: async (args) => {
      const query = args.query as string;
      const count = Math.min((args.count as number) || 5, 10);

      const url = new URL(BRAVE_SEARCH_URL);
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(count));

      const res = await fetch(url, {
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "gzip",
          "X-Subscription-Token": apiKey,
        },
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Brave Search API error (${res.status}): ${body.slice(0, 200)}`);
      }

      const data = (await res.json()) as BraveSearchResponse;
      const results = data.web?.results ?? [];

      if (results.length === 0) {
        return `No results found for "${query}".`;
      }

      const formatted = results
        .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.description}`)
        .join("\n\n");

      return `Search results for "${query}":\n\n${formatted}`;
    },
  });

  console.log("Web search tool registered (Brave Search)");
}
