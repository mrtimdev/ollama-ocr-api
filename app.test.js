import assert from "node:assert/strict";
import test from "node:test";
import { app, extractJson, normalizeResult } from "./app.js";

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
