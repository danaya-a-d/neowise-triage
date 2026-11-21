import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { classify } from "./mock-ai.mjs";

const html = await readFile(new URL("./index.html", import.meta.url));

const MODEL_TIMEOUT_MS = 300;
const ALLOWED_TOPICS = new Set(["delivery", "pricing", "other"]);
const MANUAL_REVIEW = { status: "manual_review", topic: null, draft: null };

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

// Возвращает text из тела запроса или null, если тело не прошло проверку.
function parseTriageBody(raw) {
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const { text } = body;
  if (typeof text !== "string" || text.trim() === "") return null;
  return text;
}

// Вызывает модель не дольше MODEL_TIMEOUT_MS. Signal отменяет запрос у модели,
// а Promise.race гарантирует лимит, даже если модель signal игнорирует.
async function callModel(text) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`model did not respond within ${MODEL_TIMEOUT_MS} ms`);
      error.name = "TimeoutError";
      reject(error);
      controller.abort(error);
    }, MODEL_TIMEOUT_MS);
  });
  try {
    return await Promise.race([classify(text, { signal: controller.signal }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// Возвращает { topic, draft } из ответа модели или null, если ответ не подходит.
function parseModelOutput(raw) {
  if (typeof raw !== "string") return null;
  let output;
  try {
    output = JSON.parse(raw);
  } catch {
    return null;
  }
  if (output === null || typeof output !== "object" || Array.isArray(output)) return null;
  const { topic, draft } = output;
  if (!ALLOWED_TOPICS.has(topic)) return null;
  if (typeof draft !== "string" || draft.trim() === "") return null;
  return { topic, draft };
}

async function handleTriage(request, response) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = parseTriageBody(Buffer.concat(chunks).toString("utf8"));
  if (text === null) return json(response, 400, { status: "invalid_input" });

  let raw;
  try {
    raw = await callModel(text);
  } catch (error) {
    // Текст заявки в лог не пишем — только причину сбоя.
    console.error(`[triage] manual_review: model call failed (${error?.name}: ${error?.message})`);
    return json(response, 200, MANUAL_REVIEW);
  }

  const result = parseModelOutput(raw);
  if (result === null) {
    console.error("[triage] manual_review: model output failed validation");
    return json(response, 200, MANUAL_REVIEW);
  }
  return json(response, 200, { status: "ready", topic: result.topic, draft: result.draft });
}

createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(html);
    return;
  }
  if (request.method !== "POST" || request.url !== "/api/triage") {
    return json(response, 404, { status: "not_found" });
  }
  try {
    await handleTriage(request, response);
  } catch {
    json(response, 500, { status: "server_error" });
  }
}).listen(Number(process.env.PORT || 3000), "127.0.0.1");
