import assert from "node:assert/strict";
import test from "node:test";
import { normalizeResult } from "./app.js";

test("invoice normalization preserves all item columns, Khmer, quantities and extra document fields", () => {
  const result = normalizeResult({ no: "001", documentType: "DELIVERY ORDER", dealerName: "ហាង",
    fromLocation: "Warehouse A", toCode: "PS01", total: "123.50", items: [
      { productCode: "0001", description: " ទំនិញ ", orderedQuantity: "2.50", deliveredQuantity: 2, tax: "10%" },
      { productCode: "0001", description: "Second row", quantity: "1" }
    ] });
  assert.equal(result.total, "123.50");
  assert.equal(result.dealerName, "ហាង");
  assert.equal(result.items.length, 2);
  assert.deepEqual(result.items[0], { productCode: "0001", description: "ទំនិញ", orderedQuantity: "2.50", deliveredQuantity: 2, tax: "10%" });
});

test("invalid item containers and non-object rows cannot corrupt structured items", () => {
  assert.deepEqual(normalizeResult({ items: "bad" }).items, []);
  assert.deepEqual(normalizeResult({ items: [null, "bad", [], { quantity: "0" }] }).items, [{ quantity: "0" }]);
});
