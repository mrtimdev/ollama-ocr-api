import assert from "node:assert/strict";
import test from "node:test";

process.env.API_KEYS = "warehouse:warehouse-secret";
process.env.SPRING_API_KEYS = "spring:OPS_KEY";
process.env.MONITOR_API_KEY = "monitor-secret";

const {
  authenticateMonitorKey,
  isMonitorKeyValid,
  readMonitorKey,
} = await import(`./auth.js?test=${ Date.now() }`);

test("monitor accepts dedicated, API, and Spring keys", () => {
  assert.equal(isMonitorKeyValid("monitor-secret"), true);
  assert.equal(isMonitorKeyValid("warehouse-secret"), true);
  assert.equal(isMonitorKeyValid("OPS_KEY"), true);
  assert.equal(isMonitorKeyValid("wrong-key"), false);
  assert.equal(isMonitorKeyValid(""), false);
});

test("monitor access distinguishes the monitor key from user API keys", () => {
  assert.deepEqual(authenticateMonitorKey("monitor-secret"), { scope: "monitor", user: null });
  assert.equal(authenticateMonitorKey("warehouse-secret").scope, "user");
  assert.equal(authenticateMonitorKey("warehouse-secret").user.name, "warehouse");
  assert.equal(authenticateMonitorKey("wrong-key"), null);
});

test("monitor key can use monitor, API, bearer, or query transport", () => {
  const request = (headers = {}, query = {}) => ({
    get(name) {
      return headers[name.toLowerCase()] || "";
    },
    query,
  });

  assert.equal(readMonitorKey(request({ "x-monitor-key": "monitor-secret" })), "monitor-secret");
  assert.equal(readMonitorKey(request({ "x-api-key": "OPS_KEY" })), "OPS_KEY");
  assert.equal(readMonitorKey(request({ authorization: "Bearer warehouse-secret" })), "warehouse-secret");
  assert.equal(readMonitorKey(request({}, { apiKey: "OPS_KEY" })), "OPS_KEY");
});
