// Browser side of the Claude features. Everything goes through our own
// /api/claude function (api/claude.ts), which holds the key. If the site is
// hosted without that function, or the key isn't set, calls fail with
// NotSetUp and the features show a friendly note instead.

export type ClaudeTask = "search" | "movers";

export class NotSetUp extends Error {
  constructor(message = "Niche isn't set up on this site yet.") {
    super(message);
    this.name = "NotSetUp";
  }
}

const API = ((import.meta.env.VITE_CLAUDE_API as string | undefined) ?? "/api/claude").replace(/\/$/, "");
const cache = new Map<string, string>();

/** Ask Claude for one of the fixed tasks. Same input = cached answer. */
export async function askClaude(task: ClaudeTask, input: unknown, signal?: AbortSignal): Promise<string> {
  const key = task + JSON.stringify(input);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  let res: Response;
  try {
    res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task, input }),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new NotSetUp("Couldn't reach Niche.");
  }
  const isJson = (res.headers.get("content-type") ?? "").includes("json");
  const body = isJson ? ((await res.json().catch(() => ({}))) as { text?: string; error?: string; code?: string }) : {};
  // No function on this host (404, or the HTML page) or no key: not set up.
  if (!isJson || res.status === 404 || body.code === "no_key") throw new NotSetUp(body.error);
  if (!res.ok || typeof body.text !== "string") throw new Error(body.error ?? `Niche said ${res.status}`);
  cache.set(key, body.text);
  return body.text;
}

/** Pull the first JSON object out of a reply (models sometimes wrap it). */
export function parseJsonReply<T>(text: string): T | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
