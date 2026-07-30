import assert from "node:assert/strict";
import test from "node:test";
import { app, extractJson, normalizeResult } from "./app.js";
import { JobQueue } from "./queue.js";

test("health endpoint is accessible over HTTP", async () => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("extractJson accepts fenced model output", () => {
  assert.deepEqual(extractJson('```json\n{"no":"001"}\n```'), { no: "001" });
});

test("normalizeResult formats fields, date, and vehicle code", () => {
  assert.deepEqual(
    normalizeResult({
      no: 12,
      invoiceDate: "1/7/2026",
      dealerCode: " PS01 ",
      vehicleCode: "3e-2929 T02P",
    }),
    {
      no: "12",
      invoiceDate: "01-07-2026",
      dealerCode: "PS01",
      saleOrder: "",
      vendorCode: "",
      vehicleCode: "3E-2929",
    },
  );
});

test("job queue processes work and returns the result", async () => {
  const queue = new JobQueue({ concurrency: 1 });
  const created = queue.add({
    type: "single",
    owner: { name: "tester", keyId: "abc123" },
    filenames: ["invoice.jpg"],
    fileCount: 1,
    run: async (progress) => {
      progress(50);
      return { success: true, value: 42 };
    },
  });

  const finished = await queue.waitFor(created.id);
  assert.equal(finished.status, "completed");
  assert.equal(finished.progress, 100);
  assert.deepEqual(finished.result, { success: true, value: 42 });
});

test("job queue exposes Spring metadata and deletes monitor history", async () => {
  const queue = new JobQueue({ concurrency: 1 });
  const created = queue.add({
    type: "batch",
    owner: { name: "spring", keyId: "spring123" },
    filenames: ["invoice.jpg"],
    fileCount: 1,
    metadata: { source: "spring-redis", scanIds: [42], queueName: "ops_user_1_ai-ocr", providerId: 7 },
    run: async () => ({ success: true }),
  });
  const finished = await queue.waitFor(created.id);
  assert.deepEqual(finished.metadata.scanIds, [42]);
  assert.equal(queue.delete(created.id), true);
  assert.equal(queue.get(created.id), null);
});
