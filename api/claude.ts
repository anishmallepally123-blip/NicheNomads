// Small server-side helper for the two Niche features (plain-English
// search and mover descriptions). It runs as a Vercel
// serverless function at /api/claude, and the Vite dev server mounts the same
// code locally (frontend/vite.config.ts).
//
// The API key lives only here, read from the ANTHROPIC_API_KEY environment
// variable. The browser never sees it. The browser also can't send its own
// prompt: it picks one of four fixed tasks and sends a little JSON of facts,
// and this file writes the prompt. That keeps the endpoint useless as a free
// general chatbot for strangers.
//
// Cost guards: the cheapest current model, a small max_tokens per task, a
// cap on input size, and a simple rate limit per visitor plus a daily cap.
// The limits are kept in memory, so they are per server instance, which is
// fine for a hackathon site.
import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-haiku-5-5";
const MAX_INPUT_CHARS = 4000;
const PER_IP_LIMIT = 20; // requests per visitor...
const PER_IP_WINDOW_MS = 10 * 60 * 1000; // ...per 10 minutes
const DAILY_LIMIT = Number(env().CLAUDE_DAILY_LIMIT ?? 600); // all visitors, per instance

type Task = "search" | "movers" | "chat";

const STYLE =
  "Write for a curious teenager or a member of the public. Plain words, short sentences, no markdown, " +
  "no headings, no bullet points. Be accurate. If you are not sure about a fact, say so instead of guessing.";

const TASKS: Record<Task, { maxTokens: number; system: string }> = {
  search: {
    maxTokens: 220,
    system:
      "You turn a plain-English sky search into a position for a SPHEREx image viewer. You get the user's text and " +
      "a list of built-in targets with coordinates. If a built-in target fits, use it. Otherwise pick one real, " +
      "well-known object that best fits, and give its ICRS J2000 coordinates only if you know them well. " +
      "Reply with JSON only, no other text, in this shape: " +
      '{"name": string, "simbad": string, "ra": number, "dec": number, "target_id": string|null, "why": string} ' +
      "where ra and dec are decimal degrees, simbad is a name SIMBAD can look up, target_id is the id of the " +
      "built-in target or null, and why is one friendly sentence (under 25 words) saying why you picked it. " +
      'If nothing sensible fits, reply {"name": null, "why": "<short reason>"}.',
  },
  movers: {
    maxTokens: 600,
    system:
      "You describe mover candidates found automatically in SPHEREx images. Each candidate is a dot whose position " +
      "drifted in a straight line across several visits months apart. You get JSON: the field (and any known " +
      "object there) and candidates with their shift in arcseconds, direction, rate in arcseconds per year, how " +
      "many times bigger the motion is than the normal wobble of other stars, and any catalogue star nearby with " +
      "its known proper motion in milliarcseconds per year. For each candidate write one or two plain sentences: " +
      "what it might be (a nearby star or brown dwarf, or a likely artefact such as a saturated bright star, a " +
      "blend of two stars, or noise) and how much to trust it. A catalogue match with a similar proper motion is " +
      "strong support. SPHEREx pixels are about 6 arcsec, so shifts of a few arcsec are near the limit. " +
      'Reply with JSON only: {"notes": [{"id": number, "text": string}]}. ' + STYLE,
  },
  chat: {
    maxTokens: 280,
    system:
      "You are Niche, the small helper inside the Niche Space Directory, a site that blinks NASA SPHEREx infrared " +
      "images of one patch of sky from different dates so moving objects stand out. Answer questions about what " +
      "is on the user's screen (given as JSON facts after this text) and about SPHEREx, infrared astronomy and " +
      "how to use the site. Keep answers to 1 to 4 short sentences unless asked for more. Only use the screen facts " +
      "and well-known astronomy. If you don't know, or the facts don't say, say so plainly instead of guessing. " +
      "Politely decline topics unrelated to astronomy or this site. " + STYLE,
  },
};

// Chat: only the last few turns, each cut short, so a long chat stays cheap.
const CHAT_TURNS = 6;
const CHAT_TURN_CHARS = 600;

type Turn = { role: "user" | "assistant"; content: string };

function chatMessages(input: unknown): { context: string; messages: Turn[] } | null {
  const i = (input ?? {}) as { context?: unknown; messages?: unknown };
  if (!Array.isArray(i.messages)) return null;
  const messages = i.messages
    .filter((m): m is Turn => (m?.role === "user" || m?.role === "assistant") && typeof m.content === "string" && m.content.trim() !== "")
    .slice(-CHAT_TURNS)
    .map((m) => ({ role: m.role, content: m.content.slice(0, CHAT_TURN_CHARS) }));
  while (messages.length && messages[0].role !== "user") messages.shift();
  if (!messages.length || messages[messages.length - 1].role !== "user") return null;
  return { context: JSON.stringify(i.context ?? {}).slice(0, 2500), messages };
}

// ---------------------------------------------------------------------------

function env(): Record<string, string | undefined> {
  return (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
}

const hits = new Map<string, number[]>();
let day = "";
let dayCount = 0;

function rateLimited(ip: string): string | null {
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  if (today !== day) {
    day = today;
    dayCount = 0;
  }
  if (dayCount >= DAILY_LIMIT) return "The site has used up today's Niche allowance. Try again tomorrow.";
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < PER_IP_WINDOW_MS);
  if (recent.length >= PER_IP_LIMIT) return "That's a lot of questions in a short time. Wait a few minutes and try again.";
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear(); // don't grow forever
  dayCount++;
  return null;
}

export interface Reply {
  status: number;
  body: { text?: string; error?: string; code?: "no_key" | "bad_request" | "rate_limited" | "upstream" };
}

let client: Anthropic | null = null;

/** Shared by the Vercel function and the Vite dev middleware. */
export async function handleClaude(raw: unknown, ip: string): Promise<Reply> {
  const key = env().ANTHROPIC_API_KEY;
  if (!key) return { status: 503, body: { code: "no_key", error: "Niche isn't set up on this site yet." } };

  const req = (raw ?? {}) as { task?: string; input?: unknown };
  const task = req.task as Task;
  if (!(task in TASKS)) return { status: 400, body: { code: "bad_request", error: "Unknown task" } };
  const input = JSON.stringify(req.input ?? {});
  if (input.length > (task === "chat" ? MAX_INPUT_CHARS * 2 : MAX_INPUT_CHARS)) return { status: 413, body: { code: "bad_request", error: "Too much input" } };

  const limited = rateLimited(ip);
  if (limited) return { status: 429, body: { code: "rate_limited", error: limited } };

  client ??= new Anthropic({ apiKey: key, maxRetries: 1, timeout: 25_000 });
  const { maxTokens, system } = TASKS[task];
  let messages: Turn[] = [{ role: "user", content: input }];
  let fullSystem = system;
  if (task === "chat") {
    const chat = chatMessages(req.input);
    if (!chat) return { status: 400, body: { code: "bad_request", error: "Ask a question first" } };
    messages = chat.messages;
    fullSystem = `${system}\n\nOn screen now: ${chat.context}`;
  }
  try {
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      // Short factual answers: no thinking, low effort, to keep each call cheap.
      thinking: { type: "disabled" },
      output_config: { effort: "low" },
      system: fullSystem,
      messages,
    });
    if (msg.stop_reason === "refusal") {
      return { status: 502, body: { code: "upstream", error: "Niche declined to answer that one." } };
    }
    const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
    return { status: 200, body: { text } };
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      return { status: 429, body: { code: "rate_limited", error: "Niche is busy right now. Try again in a minute." } };
    }
    if (err instanceof Anthropic.AuthenticationError) {
      return { status: 503, body: { code: "no_key", error: "The site's Niche key isn't working. Ask the site owner to check it." } };
    }
    console.error("claude call failed", err);
    return { status: 502, body: { code: "upstream", error: "Couldn't reach Niche just now." } };
  }
}

// Vercel Node.js function. JSON bodies arrive already parsed as req.body.
interface NodeReq {
  method?: string;
  body?: unknown;
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
}
interface NodeRes {
  status(code: number): NodeRes;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
}

export function clientIp(headers: NodeReq["headers"], fallback = "unknown"): string {
  const fwd = headers["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
  return first || fallback;
}

export default async function handler(req: NodeReq, res: NodeRes) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "GET") {
    // Lets the page check whether Claude is set up without spending anything.
    return res.status(200).json({ ready: Boolean(env().ANTHROPIC_API_KEY) });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });
  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ code: "bad_request", error: "Body must be JSON" });
    }
  }
  const reply = await handleClaude(body, clientIp(req.headers, req.socket?.remoteAddress));
  return res.status(reply.status).json(reply.body);
}
