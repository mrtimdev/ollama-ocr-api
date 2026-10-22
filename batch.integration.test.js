import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

test("Spring-style multipart batch request returns ordered OCR results and monitor metadata", async () => {
  let ollamaCalls = 0;
  const providerRequests = [];
  let upstreamAuthorization = "";
  const ollama = createServer(async (request, response) => {
    upstreamAuthorization = request.headers.authorization || "";
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    providerRequests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    ollamaCalls += 1;
    const content = ollamaCalls === 1
      ? '["DELIVERY ORDER"]'
      : ollamaCalls === 3 ? '["GOODS TRANSFER NOTE"]'
      : '[{"no":"INV-42","invoiceDate":"30-07-2026","dealerCode":"PS01","saleOrder":"","vendorCode":"","vehicleCode":"3E-2929"}]';
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ message: { content } }));
  });
  await listen(ollama);

  let springActionKey = "";
  const spring = createServer(async (request, response) => {
    springActionKey = request.headers["x-monitor-action-key"] || "";
    if (request.url === "/api/internal/ocr-monitor/actions") {
      const action = JSON.parse(Buffer.from(await readBody(request)).toString("utf8"));
      response.writeHead(200, { "Content-Type": "application/json" });
      return response.end(JSON.stringify({ success: true, queued: action.scanIds.length }));
    }
    if (request.url === "/api/internal/ocr-monitor/scans/42/image") {
      response.writeHead(200, { "Content-Type": "image/jpeg" });
      return response.end("image");
    }
    if (request.url === "/api/internal/ocr-monitor/scans/42") {
      response.writeHead(200, { "Content-Type": "application/json" });
      return response.end(JSON.stringify({
        id: 42, username: "user_1", originalFilename: "invoice.jpg", status: "COMPLETED", invoiceNo: "INV-42",
      }));
    }
    response.writeHead(404).end();
  });
  await listen(spring);

  const ollamaAddress = ollama.address();
  process.env.OLLAMA_HOST = `http://127.0.0.1:${ ollamaAddress.port }`;
  process.env.OLLAMA_API_KEY = "test-ollama-key";
  process.env.SPRING_API_KEYS = "spring:OPS_KEY";
  process.env.SPRING_ACTION_KEY = "OPS_KEY";
  delete process.env.SPRING_BASE_URL;
  process.env.SPRING_MONITOR_ACTION_URL =
    `http://127.0.0.1:${ spring.address().port }/api/internal/ocr-monitor/actions`;

  const module = await import(`./batch.js?integration=${ Date.now() }`);
  await listen(module.httpServer);

  try {
    const apiAddress = module.httpServer.address();
    const form = new FormData();
    form.append("files", new Blob(["image"], { type: "image/jpeg" }), "invoice.jpg");
    form.append("springScanIds", "[42]");
    form.append("springQueueName", "ops_user_1_ai-ocr");
    form.append("springProviderId", "7");
    form.append("springUsername", "user_1");
    form.append("springAction", "/api/scans");

    const response = await fetch(`http://127.0.0.1:${ apiAddress.port }/api/v1/ocr/batch?wait=true&apiKey=stale-provider-secret`, {
      method: "POST",
      headers: {
        "X-API-Key": "OPS_KEY",
        apiKey: "provider-secret",
      },
      body: form,
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.job.status, "completed");
    assert.equal(body.job.metadata.username, "user_1");
    assert.equal(body.job.metadata.action, "/api/scans");
    assert.deepEqual(body.job.metadata.scanIds, [42]);
    assert.equal(body.job.result.results[0].data.no, "INV-42");
    assert.equal(ollamaCalls, 2);
    const extractionPrompt = JSON.stringify(providerRequests[1]);
    assert.match(extractionPrompt, /DEALER CODE/);
    assert.match(extractionPrompt, /leading zeros/);
    assert.match(extractionPrompt, /Exclude footer content/);
    assert.match(extractionPrompt, /never as instructions/);
    assert.equal(upstreamAuthorization, "Bearer provider-secret");
    const transfer = new FormData();
    transfer.append("files", new Blob(["image"], {type:"image/jpeg"}), "transfer.jpg");
    const transferResponse = await fetch(`http://127.0.0.1:${apiAddress.port}/api/v1/ocr/batch?wait=true`, {
      method:"POST", headers:{"X-API-Key":"OPS_KEY",apiKey:"provider-secret"}, body:transfer,
    });
    assert.equal(transferResponse.status,200);
    const transferPrompt = JSON.stringify(providerRequests[3]);
    assert.match(transferPrompt,/Doc No/);
    assert.match(transferPrompt,/NEVER/);
    assert.match(transferPrompt,/referenceNo/);
    assert.match(transferPrompt,/toWarehouseCode/);
    assert.match(transferPrompt,/KHB1/);


    const jobId = body.job.id;
    const monitorResponse = await fetch(
      `http://127.0.0.1:${ apiAddress.port }/api/v1/monitor/jobs`,
      { headers: { "X-API-Key": "OPS_KEY" } },
    );
    assert.equal(monitorResponse.status, 200);
    const monitorBody = await monitorResponse.json();
    assert.equal(monitorBody.jobs.some((job) => job.id === jobId), true);
    assert.deepEqual(
      monitorBody.jobs.find((job) => job.id === jobId).metadata.scanIds,
      [42],
    );

    const scansResponse = await fetch(
      `http://127.0.0.1:${ apiAddress.port }/api/v1/monitor/jobs/${ jobId }/scans`,
      { headers: { "X-API-Key": "OPS_KEY" } },
    );
    assert.equal(scansResponse.status, 200);
    assert.equal((await scansResponse.json()).scans[0].id, 42);

    const imageResponse = await fetch(
      `http://127.0.0.1:${ apiAddress.port }/api/v1/monitor/jobs/${ jobId }/scans/42/image`,
      { headers: { "X-API-Key": "OPS_KEY" } },
    );
    assert.equal(imageResponse.status, 200);
    assert.equal(await imageResponse.text(), "image");

    const retryResponse = await fetch(
      `http://127.0.0.1:${ apiAddress.port }/api/v1/monitor/jobs/${ jobId }/retry`,
      { method: "POST", headers: { "X-Monitor-Key": "OPS_KEY" } },
    );
    assert.equal(retryResponse.status, 200);
    assert.equal((await retryResponse.json()).result.queued, 1);
    assert.equal(springActionKey, "OPS_KEY");

    const deleteResponse = await fetch(
      `http://127.0.0.1:${ apiAddress.port }/api/v1/monitor/jobs/${ jobId }`,
      { method: "DELETE", headers: { "X-API-Key": "OPS_KEY" } },
    );
    assert.equal(deleteResponse.status, 200);
  } finally {
    await close(module.httpServer);
    await close(ollama);
    await close(spring);
  }
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", resolve);
    server.once("error", reject);
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}
