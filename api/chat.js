/**
 * MCQ Test Maker — AI chat function (Vercel)
 *
 * SETUP:
 *   1. Place this file at  api/chat.js  in your Vercel project
 *      (so it is served as POST /api/chat).
 *   2. In Vercel: Project → Settings → Environment Variables,
 *      add  GROQ_API_KEY  with your Groq key (from console.groq.com).
 *   3. Redeploy the project.
 *
 * The key is read only from process.env on the server. It is never
 * hardcoded and never sent to the browser.
 *
 * ------------------------------------------------------------------
 * MODE 1 — "explain" (default, backward compatible)
 *   The tutor on the results screen. Used AFTER a test is finished.
 *   Request  (POST, JSON):
 *     { question, options, correctAnswers, userChoice, message }
 *     ("mode" may be omitted, or sent as "explain")
 *   Success  (200, JSON): { reply }
 *
 * MODE 2 — "chat" (ask about the uploaded content)
 *   For a file that contains study material / notes / a chapter —
 *   not just questions. Answers come ONLY from that content.
 *   Request  (POST, JSON):
 *     { mode: "chat", content, message }
 *     - content: the text extracted from the user's uploaded file
 *     - message: the user's question about that content
 *   Success  (200, JSON): { reply }
 *     plus { truncated: true } if the content was cut to the limit.
 *   If the answer is not in the content, the reply says so clearly
 *   instead of inventing facts.
 *
 * MODE 3 — "generate" (make MCQs from the uploaded content)
 *   Turns study material into a ready-to-use question set, in the
 *   same shape the site's test uses.
 *   Request  (POST, JSON):
 *     { mode: "generate", content, count }
 *     - content: the text extracted from the user's uploaded file
 *     - count:   how many questions to make (1–20, default 5)
 *   Success  (200, JSON):
 *     { questions: [
 *         { question: "...",
 *           options: ["...", "...", "...", "..."],
 *           correctAnswers: ["B"]            // single-answer
 *           // or correctAnswers: ["B", "D"] // multi-answer
 *         }, ... ] }
 *     plus { truncated: true } if the content was cut to the limit.
 *   Questions are single-answer by default; multi-answer is used
 *   only where the content genuinely supports more than one
 *   correct option.
 *
 * Errors (all modes, JSON): { error: "..." }
 *   400 bad request (missing/invalid fields, unknown mode, or — in
 *       generate mode — no valid question could be produced)
 *   405 method not allowed (POST only)
 *   500 { error: "Missing GROQ_API_KEY" } if the key is not set
 *   5xx if Groq itself fails or times out
 * ------------------------------------------------------------------
 */

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const PRIMARY_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const FALLBACK_MODEL = "llama-3.1-8b-instant";
const CONTENT_LIMIT = 12000; // chars of uploaded content per request
const MAX_GENERATE_COUNT = 20;

const EXPLAIN_PROMPT = [
  "You are a friendly tutor explaining MCQ results AFTER a test is finished.",
  "You are given exactly one question, its options, the correct answer(s),",
  "what the user chose, and the user's message about that question.",
  "Explain in clear, simple language:",
  "  1. what the question is asking,",
  "  2. why the correct answer(s) are correct, and",
  "  3. why the user's choice was wrong — only if it was wrong.",
  "     If the user was correct, say so briefly and reinforce why.",
  "     If the user skipped the question, just explain the correct answer.",
  "Keep it concise and encouraging. Use short paragraphs or a short list.",
  "Do not invent or reveal answers for any other question: you only know",
  "about the single question in this request, so if asked about another",
  "question, say you can only explain the question currently shown.",
].join("\n");

const CHAT_PROMPT = [
  "You are a helpful study assistant answering questions about a",
  "document the user uploaded.",
  "Answer ONLY from the content provided in this request.",
  "Do not use outside knowledge and do not invent facts, names,",
  "numbers, or examples that are not in the content.",
  "If the answer is not in the content, say clearly that the",
  "uploaded content does not cover it, and do not guess.",
  "If the content was truncated, do not claim to have seen parts",
  "that were not provided.",
  "Keep answers clear, simple, and concise. Quote or paraphrase",
  "the content where that helps the user find the relevant part.",
].join("\n");

function generatePrompt(count) {
  return [
    `You create multiple-choice questions from study content.`,
    `Create exactly ${count} multiple-choice questions using ONLY`,
    "the content provided. Do not use outside knowledge and do not",
    "invent facts that are not in the content.",
    "Each question must have:",
    "  - a clear question stem,",
    "  - exactly 4 options, and",
    "  - the correct answer(s) identified by letter (A, B, C or D).",
    "Default to single-answer questions (exactly one correct option).",
    "Use a multi-answer question (two correct options) only where the",
    "content genuinely supports more than one correct option.",
    "Make the wrong options plausible but clearly wrong from the content.",
    "Spread the correct answers across A, B, C and D; do not make the",
    "same letter correct for every question.",
    "Return ONLY a JSON object in exactly this shape — no markdown,",
    "no code fences, no explanation, no text before or after it:",
    '{"questions":[{"question":"...","options":["...","...","...","..."],',
    '"correctAnswers":["B"]}]}',
    'For a multi-answer question, use e.g. "correctAnswers":["B","D"].',
  ].join("\n");
}

function setCors(req, res) {
  const origin = req.headers && req.headers.origin;
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function sendJson(res, status, payload) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body);
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw); // throws on bad JSON — handled by the caller
}

function asList(value) {
  if (value == null || value === "") return [];
  return (Array.isArray(value) ? value : [value]).map(String);
}

function getContent(body) {
  const raw =
    typeof body.content === "string" ? body.content :
    typeof body.fileContent === "string" ? body.fileContent :
    typeof body.documentText === "string" ? body.documentText :
    typeof body.text === "string" ? body.text : "";
  const text = raw.trim();
  if (text.length <= CONTENT_LIMIT) return { text, truncated: false };
  return { text: text.slice(0, CONTENT_LIMIT), truncated: true };
}

function formatOptions(options) {
  return options
    .map((opt, i) => {
      const label = String.fromCharCode(65 + i);
      if (opt && typeof opt === "object") {
        return `${opt.label || label}. ${opt.text ?? opt.value ?? ""}`.trim();
      }
      return `${label}. ${String(opt)}`;
    })
    .join("\n");
}

function buildExplainPrompt({ question, options, correctAnswers, userChoice, message }) {
  const lines = [
    `Question:\n${question}`,
    `\nOptions:\n${formatOptions(options)}`,
    `\nCorrect answer(s): ${asList(correctAnswers).join(", ") || "(not provided)"}`,
  ];
  const chosen = asList(userChoice);
  lines.push(
    chosen.length
      ? `\nUser's choice: ${chosen.join(", ")}`
      : "\nUser's choice: (did not answer)"
  );
  lines.push(`\nUser's message: ${message}`);
  lines.push("\nPlease explain this question as instructed.");
  return lines.join("\n");
}

async function callGroq(apiKey, model, messages, opts = {}) {
  const timeoutMs = opts.timeoutMs || 25000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(GROQ_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: opts.temperature ?? 0.4,
        max_tokens: opts.maxTokens || 700,
      }),
    });
  } finally {
    clearTimeout(timer);
  }
}

// Tries the primary model, then the fallback once. Returns either
// { reply } or { status, detail } describing the last failure.
async function askGroq(apiKey, messages, opts = {}) {
  const models = [...new Set([PRIMARY_MODEL, FALLBACK_MODEL])];
  let lastStatus = 502;
  let lastDetail = "";
  for (const model of models) {
    let groqRes;
    try {
      groqRes = await callGroq(apiKey, model, messages, opts);
    } catch (err) {
      lastStatus = 502;
      lastDetail =
        err && err.name === "AbortError"
          ? "Groq request timed out."
          : "Could not reach Groq.";
      continue;
    }
    if (groqRes.ok) {
      const data = await groqRes.json().catch(() => null);
      const reply = data?.choices?.[0]?.message?.content?.trim();
      if (reply) return { reply };
      lastStatus = 502;
      lastDetail = "Groq returned an empty reply.";
      continue;
    }
    const errBody = await groqRes.json().catch(() => null);
    lastStatus =
      groqRes.status === 401 || groqRes.status === 403 ? 502 : groqRes.status;
    lastDetail =
      errBody?.error?.message || `Groq request failed (${groqRes.status}).`;
    if (![400, 404, 429, 500, 502, 503].includes(groqRes.status)) break;
  }
  return { status: lastStatus, detail: lastDetail || "Groq request failed." };
}

// --- generate mode: robust parsing & validation -------------------

function normalizeLetters(value) {
  // Accepts "B", ["B", "D"], "B, D", 1 (index), ["A. ..."] etc.
  const items = Array.isArray(value) ? value : [value];
  const letters = [];
  for (const item of items) {
    if (typeof item === "number" && item >= 0 && item <= 3) {
      letters.push(String.fromCharCode(65 + item));
      continue;
    }
    if (item == null) continue;
    for (const part of String(item).split(/[,;]+|\s+and\s+/i)) {
      const m = part.trim().match(/^\(?([A-Da-d])\b/);
      if (m) letters.push(m[1].toUpperCase());
    }
  }
  return [...new Set(letters)].sort();
}

function validateQuestion(raw) {
  if (!raw || typeof raw !== "object") return null;
  const question =
    typeof raw.question === "string" ? raw.question.trim() :
    typeof raw.text === "string" ? raw.text.trim() :
    typeof raw.stem === "string" ? raw.stem.trim() : "";
  if (!question) return null;
  const rawOptions = Array.isArray(raw.options) ? raw.options : [];
  if (rawOptions.length !== 4) return null;
  const options = rawOptions.map((o) =>
    o && typeof o === "object" ? String(o.text ?? o.value ?? "").trim() : String(o).trim()
  );
  if (options.some((o) => !o)) return null;
  const correctAnswers = normalizeLetters(
    raw.correctAnswers ?? raw.correctAnswer ?? raw.answers ?? raw.answer
  );
  if (!correctAnswers.length) return null;
  // normalizeLetters only yields A–D, all valid for 4 options.
  return { question, options, correctAnswers };
}

function parseGenerated(text) {
  if (!text) return [];
  let cleaned = String(text).trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  let parsed = null;
  try { parsed = JSON.parse(cleaned); } catch { /* try extraction */ }
  if (parsed == null) {
    const start = Math.min(
      ...[cleaned.indexOf("{"), cleaned.indexOf("[")].filter((i) => i >= 0),
      Infinity
    );
    const end = Math.max(cleaned.lastIndexOf("}"), cleaned.lastIndexOf("]"));
    if (start !== Infinity && end > start) {
      try { parsed = JSON.parse(cleaned.slice(start, end + 1)); } catch { /* give up */ }
    }
  }
  if (parsed == null) return [];
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.questions) ? parsed.questions : [];
  return list.map(validateQuestion).filter(Boolean);
}

// --- mode handlers --------------------------------------------------

async function handleExplain(req, res, apiKey, body) {
  const question =
    typeof body.question === "string" ? body.question.trim() : "";
  const options = Array.isArray(body.options) ? body.options : [];
  const correctAnswers = asList(body.correctAnswers);
  const message =
    typeof body.message === "string" && body.message.trim()
      ? body.message.trim().slice(0, 2000)
      : "Explain this question.";
  if (!question) {
    sendJson(res, 400, { error: "Missing required field: question" });
    return;
  }
  if (options.length < 2) {
    sendJson(res, 400, { error: "Missing required field: options" });
    return;
  }
  if (!correctAnswers.length) {
    sendJson(res, 400, { error: "Missing required field: correctAnswers" });
    return;
  }
  const result = await askGroq(apiKey, [
    { role: "system", content: EXPLAIN_PROMPT },
    { role: "user", content: buildExplainPrompt({
        question, options, correctAnswers,
        userChoice: body.userChoice, message }) },
  ], { timeoutMs: 25000, maxTokens: 700, temperature: 0.4 });
  if (result.reply) sendJson(res, 200, { reply: result.reply });
  else sendJson(res, result.status, { error: result.detail });
}

async function handleChat(req, res, apiKey, body) {
  const { text: content, truncated } = getContent(body);
  const message =
    typeof body.message === "string" ? body.message.trim().slice(0, 2000) : "";
  if (!content) {
    sendJson(res, 400, { error: "Missing required field: content" });
    return;
  }
  if (!message) {
    sendJson(res, 400, { error: "Missing required field: message" });
    return;
  }
  const userPrompt = [
    "Uploaded content:",
    '"""',
    content,
    '"""',
    truncated
      ? "(Note: the content above was truncated to the first " +
        `${CONTENT_LIMIT} characters of the uploaded file.)`
      : "",
    `\nUser's question: ${message}`,
    "\nAnswer using only the content above, as instructed.",
  ].filter(Boolean).join("\n");
  const result = await askGroq(apiKey, [
    { role: "system", content: CHAT_PROMPT },
    { role: "user", content: userPrompt },
  ], { timeoutMs: 25000, maxTokens: 800, temperature: 0.3 });
  if (result.reply) {
    const payload = { reply: result.reply };
    if (truncated) {
      payload.truncated = true;
      payload.note =
        `The uploaded content was longer than ${CONTENT_LIMIT} characters, ` +
        "so only the first part was used.";
    }
    sendJson(res, 200, payload);
  } else {
    sendJson(res, result.status, { error: result.detail });
  }
}

async function handleGenerate(req, res, apiKey, body) {
  const { text: content, truncated } = getContent(body);
  if (!content) {
    sendJson(res, 400, { error: "Missing required field: content" });
    return;
  }
  let count = Number(body.count ?? body.numQuestions ?? 5);
  if (!Number.isFinite(count)) count = 5;
  count = Math.max(1, Math.min(MAX_GENERATE_COUNT, Math.floor(count)));

  const messages = [
    { role: "system", content: generatePrompt(count) },
    { role: "user", content:
        "Content to make questions from:\n\"\"\"\n" + content + "\n\"\"\"\n" +
        (truncated
          ? `(Only the first ${CONTENT_LIMIT} characters were provided.)\n`
          : "") +
        `Return ONLY the JSON object with exactly ${count} questions.` },
  ];
  const opts = {
    timeoutMs: 60000,
    maxTokens: Math.min(4000, 400 + count * 350),
    temperature: 0.3,
  };

  // Parse per model so a malformed reply from the primary model
  // still gets a chance with the fallback model.
  const models = [...new Set([PRIMARY_MODEL, FALLBACK_MODEL])];
  let lastStatus = 502;
  let lastDetail = "";
  for (const model of models) {
    let groqRes;
    try {
      groqRes = await callGroq(apiKey, model, messages, opts);
    } catch (err) {
      lastStatus = 502;
      lastDetail =
        err && err.name === "AbortError"
          ? "Groq request timed out."
          : "Could not reach Groq.";
      continue;
    }
    if (!groqRes.ok) {
      const errBody = await groqRes.json().catch(() => null);
      lastStatus =
        groqRes.status === 401 || groqRes.status === 403 ? 502 : groqRes.status;
      lastDetail =
        errBody?.error?.message || `Groq request failed (${groqRes.status}).`;
      if (![400, 404, 429, 500, 502, 503].includes(groqRes.status)) break;
      continue;
    }
    const data = await groqRes.json().catch(() => null);
    const raw = data?.choices?.[0]?.message?.content?.trim();
    const questions = parseGenerated(raw);
    if (questions.length) {
      const payload = { questions: questions.slice(0, count) };
      if (truncated) {
        payload.truncated = true;
        payload.note =
          `The uploaded content was longer than ${CONTENT_LIMIT} characters, ` +
          "so questions were made from the first part only.";
      }
      if (payload.questions.length < count) {
        payload.warning =
          `Only ${payload.questions.length} of the ${count} requested ` +
          "questions were valid and could be used.";
      }
      sendJson(res, 200, payload);
      return;
    }
    lastStatus = 502;
    lastDetail = "Groq returned an empty reply.";
  }
  if (lastDetail === "Groq returned an empty reply." || !lastDetail) {
    sendJson(res, 400, {
      error:
        "No valid questions could be generated from this content. " +
        "Try content with more detail, or request fewer questions.",
    });
  } else {
    sendJson(res, lastStatus, { error: lastDetail });
  }
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    sendJson(res, 405, { error: "Method not allowed: use POST." });
    return;
  }
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    sendJson(res, 500, { error: "Missing GROQ_API_KEY" });
    return;
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: "Invalid JSON in request body." });
    return;
  }
  const mode =
    typeof body.mode === "string" && body.mode.trim()
      ? body.mode.trim().toLowerCase()
      : "explain";
  if (mode === "explain") return handleExplain(req, res, apiKey, body);
  if (mode === "chat") return handleChat(req, res, apiKey, body);
  if (mode === "generate") return handleGenerate(req, res, apiKey, body);
  sendJson(res, 400, {
    error: 'Unknown mode: use "explain", "chat", or "generate".',
  });
}
