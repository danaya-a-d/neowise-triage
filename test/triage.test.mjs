import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApp } from "../app.mjs";

const MANUAL_REVIEW = { status: "manual_review", topic: null, draft: null };
const INVALID_INPUT = { status: "invalid_input" };

let server;
let url;

before(async () => {
  server = createApp();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  url = `http://127.0.0.1:${server.address().port}/api/triage`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

async function triage(body, target = url) {
  const response = await fetch(target, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  return { status: response.status, body: await response.json() };
}

const triageText = (text) => triage(JSON.stringify({ text }));

test("обычная заявка про доставку → ready, тема delivery", async () => {
  const { status, body } = await triageText("Когда будет доставка заказа?");
  assert.equal(status, 200);
  assert.equal(body.status, "ready");
  assert.equal(body.topic, "delivery");
  assert.equal(typeof body.draft, "string");
  assert.ok(body.draft.trim().length > 0);
});

test("заявка про цену → ready, тема pricing", async () => {
  const { status, body } = await triageText("Какая цена за ремонт?");
  assert.equal(status, 200);
  assert.equal(body.status, "ready");
  assert.equal(body.topic, "pricing");
  assert.equal(typeof body.draft, "string");
  assert.ok(body.draft.trim().length > 0);
});

for (const tag of ["[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
  test(`сбой модели ${tag} → manual_review`, async () => {
    const { status, body } = await triageText(`Где мой заказ? ${tag}`);
    assert.equal(status, 200);
    assert.deepEqual(body, MANUAL_REVIEW);
  });
}

test("таймаут модели [timeout] → manual_review быстрее 600 мс", async () => {
  const started = performance.now();
  const { status, body } = await triageText("Где мой заказ? [timeout]");
  const elapsed = performance.now() - started;
  assert.equal(status, 200);
  assert.deepEqual(body, MANUAL_REVIEW);
  assert.ok(elapsed < 600, `ответ пришёл за ${Math.round(elapsed)} мс`);
});

test("модель игнорирует signal и не отвечает → manual_review быстрее 600 мс", { timeout: 2000 }, async (t) => {
  // Подменная модель: signal не слушает, промис никогда не завершается.
  const hangingClassify = () => new Promise(() => {});
  const hangingServer = createApp({ classify: hangingClassify });
  // t.after выполняется и после таймаута теста, в отличие от finally.
  t.after(() => {
    hangingServer.closeAllConnections();
    hangingServer.close();
  });
  hangingServer.listen(0, "127.0.0.1");
  await once(hangingServer, "listening");

  const target = `http://127.0.0.1:${hangingServer.address().port}/api/triage`;
  const started = performance.now();
  const { status, body } = await triage(JSON.stringify({ text: "Где мой заказ?" }), target);
  const elapsed = performance.now() - started;
  assert.equal(status, 200);
  assert.deepEqual(body, MANUAL_REVIEW);
  assert.ok(elapsed < 600, `ответ пришёл за ${Math.round(elapsed)} мс`);
});

for (const raw of ["{bad", "null", "[]", "{}", '{"text":42}', '{"text":" "}']) {
  test(`некорректное тело ${raw} → 400 invalid_input`, async () => {
    const { status, body } = await triage(raw);
    assert.equal(status, 400);
    assert.deepEqual(body, INVALID_INPUT);
  });
}
