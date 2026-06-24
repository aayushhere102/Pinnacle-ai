// /api/ai.js — Vercel Serverless Function
// This runs on the server only. The OpenAI key NEVER reaches the browser.
//
// Frontend sends: { messages: [{ role:'user', content: string | [{type:'text',text},{type:'image',source:{media_type,data}}] }], maxTokens }
// We translate that into OpenAI's Chat Completions format and call OpenAI.
//
// Required Vercel env var: OPENAI_API_KEY  (set in Vercel dashboard → Project → Settings → Environment Variables)
// Optional env var: OPENAI_MODEL (defaults to "gpt-5.4-mini" — cheap + supports vision. Change anytime without code edits.)

// --- very basic in-memory per-IP rate limiter -----------------------------
// NOTE: this resets whenever the serverless function cold-starts, so it is
// a soft speed-bump against accidental bursts/abuse, NOT a hard cost guarantee.
// For real cost control, ALSO set a hard monthly budget limit in your OpenAI
// dashboard (platform.openai.com → Settings → Limits).
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 15; // max requests per IP per minute
const hits = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  arr.push(now);
  hits.set(ip, arr);
  // keep the map from growing forever across warm invocations
  if (hits.size > 5000) hits.clear();
  return arr.length > RATE_LIMIT_MAX;
}

function toOpenAIMessages(messages) {
  const out = [];
  for (const m of messages || []) {
    if (typeof m.content === "string") {
      out.push({ role: m.role || "user", content: m.content });
      continue;
    }
    if (Array.isArray(m.content)) {
      const parts = [];
      for (const block of m.content) {
        if (block.type === "text") {
          parts.push({ type: "text", text: block.text });
        } else if (block.type === "image" && block.source) {
          parts.push({
            type: "image_url",
            image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
          });
        }
      }
      out.push({ role: m.role || "user", content: parts });
      continue;
    }
    out.push({ role: m.role || "user", content: String(m.content || "") });
  }
  return out;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  if (isRateLimited(ip)) {
    res.setHeader("Retry-After", "20");
    return res.status(429).json({ error: "Too many requests — please slow down a little." });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Server misconfigured: OPENAI_API_KEY is not set in Vercel environment variables." });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const { messages, maxTokens } = body || {};
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "Missing 'messages' in request body." });
  }

  const model = process.env.OPENAI_MODEL || "gpt-5.4-mini";

  try {
    const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens || 1000,
        messages: toOpenAIMessages(messages),
      }),
    });

    const data = await upstream.json();

    if (!upstream.ok || data.error) {
      const status = upstream.status === 429 ? 429 : upstream.status >= 500 ? 502 : 400;
      return res.status(status).json({ error: (data.error && data.error.message) || "OpenAI request failed." });
    }

    const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
    return res.status(200).json({ text });
  } catch (err) {
    return res.status(502).json({ error: "Could not reach OpenAI. Please try again." });
