import express from "express";
import multer from "multer";
import { pathToFileURL } from "node:url";

const MODEL_NAME = process.env.OLLAMA_MODEL || "gemma4:31b-cloud";
const OLLAMA_HOST = (process.env.OLLAMA_HOST || "https://ollama.com").replace(/\/$/, "");
const PORT = Number(process.env.PORT || 3000);

const REQUIRED_FIELDS = [
  "no",
  "invoiceDate",
  "dealerCode",
  "saleOrder",
  "vendorCode",
  "vehicleCode",
];

const VEHICLE_CODE_PATTERN = /(?<![A-Z0-9])([A-Z0-9]{2}-[A-Z0-9]{4})(?![A-Z0-9])/i;

const DELIVERY_ORDER_PROMPT = `
Extract KHB DELIVERY ORDER fields and return ONLY valid JSON:
{
  "no": "", "invoiceDate": "", "dealerCode": "",
  "saleOrder": "", "vendorCode": "", "vehicleCode": ""
}
Rules:
- no: value under/near "No." and under "លេខ".
- invoiceDate: value under/near "DATE", formatted DD-MM-YYYY.
- dealerCode: value ONLY under/near "DEALER CODE". Never use the numeric code from "DEALER NAME & ADDRESS".
- saleOrder: value under/near "SALE ORDER". Keep leading zeros.
- vendorCode: value under/near "VENDOR CODE". Keep leading zeros.
- vehicleCode: value under/near "VEHICLE No". Keep letters and dashes.
Ignore handwritten notes, stamps, signatures, item codes, route, warehouse, quantity, and description.
Return an empty string if not found. Return JSON only, with no markdown or explanation.
`;

const GOODS_TRANSFER_NOTE_PROMPT = `
Extract fields from this KHB GOODS TRANSFER NOTE and return ONLY valid JSON:
{
  "no": "", "invoiceDate": "", "dealerCode": "",
  "saleOrder": "", "vendorCode": "", "vehicleCode": ""
}
- no: value beside/after Khmer "លេខយោង" or "Ref No:". This is the invoice number.
- invoiceDate: value beside/after Khmer "កាលបរិច្ឆេទ" or "Date:".
- dealerCode: destination code inside/beside Khmer "ជូន" or "To:". Choose the short dealer code (for example PS01).
- saleOrder and vendorCode: return empty strings because this template does not contain those fields.
- vehicleCode: find a standalone vehicle number near the reference/header area.
Format invoiceDate as DD-MM-YYYY. vehicleCode must be exactly AA-AAAA, where A is a letter or digit.
Preserve leading zeros. Ignore notes, stamps, signatures, item codes, route, warehouse, quantity, and description.
Return an empty string if not found. Return JSON only, with no markdown or explanation.
`;

const TEMPLATE_CLASSIFICATION_PROMPT = `
Classify this image as exactly one of these KHB document templates:
- DELIVERY ORDER
- GOODS TRANSFER NOTE
Use the large printed document title, not handwritten notes or stamps.
Return ONLY one exact label: DELIVERY ORDER or GOODS TRANSFER NOTE.
`;

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter: (_request, file, callback) => {
    if (!file.mimetype.startsWith("image/")) {
      return callback(new Error("Only image files are accepted."));
    }
    callback(null, true);
  },
});

async function chatWithImage(apiKey, imageBase64, prompt) {
  const response = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL_NAME,
      messages: [{ role: "user", content: prompt, images: [imageBase64] }],
      stream: false,
      options: { temperature: 0, num_ctx: 8192 },
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Ollama request failed (${response.status}): ${detail.slice(0, 500)}`);
  }

  const body = await response.json();
  if (!body?.message?.content) throw new Error("Ollama returned an empty response.");
  return body.message.content;
}

async function filterImageTemplate(apiKey, imageBase64) {
  const raw = await chatWithImage(apiKey, imageBase64, TEMPLATE_CLASSIFICATION_PROMPT);
  const template = raw.toUpperCase().replace(/[^A-Z ]/g, "").trim();
  if (template.includes("GOODS TRANSFER NOTE")) return "GOODS TRANSFER NOTE";
  if (template.includes("DELIVERY ORDER")) return "DELIVERY ORDER";
  throw new Error("Unsupported image template. Expected DELIVERY ORDER or GOODS TRANSFER NOTE.");
}

function buildPrompt(customPrompt, templatePrompt) {
  if (!customPrompt?.trim()) return templatePrompt;
  return `${templatePrompt}
Additional caller instructions:
${customPrompt.trim()}
The template rules and exact JSON structure above remain mandatory.`;
}

function extractJson(text) {
  const cleaned = text.trim().replace(/```json|```/gi, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON found in model output.");
  return JSON.parse(match[0]);
}

function normalizeResult(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Model output is not a JSON object.");
  }

  const normalized = Object.fromEntries(
    REQUIRED_FIELDS.map((field) => [field, data[field] == null ? "" : String(data[field]).trim()]),
  );

  const date = normalized.invoiceDate.match(/^(\d{1,2})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{4})$/);
  if (date) {
    normalized.invoiceDate = `${date[1].padStart(2, "0")}-${date[2].padStart(2, "0")}-${date[3]}`;
  }

  const vehicle = normalized.vehicleCode.toUpperCase().match(VEHICLE_CODE_PATTERN);
  normalized.vehicleCode = vehicle?.[1] || "";
  return normalized;
}

async function extractDocument(apiKey, imageBase64, template, customPrompt) {
  const templatePrompt =
    template === "GOODS TRANSFER NOTE" ? GOODS_TRANSFER_NOTE_PROMPT : DELIVERY_ORDER_PROMPT;
  const output = await chatWithImage(apiKey, imageBase64, buildPrompt(customPrompt, templatePrompt));
  return normalizeResult(extractJson(output));
}

app.get("/", (_request, response) => {
  response.json({
    name: "Tim Dev: Invoice OCR API - AI Cloud",
    status: "ok",
    endpoint: "POST /api/v1/ocr/single",
  });
});

app.get("/health", (_request, response) => response.json({ status: "ok" }));

app.post("/api/v1/ocr/single", upload.single("file"), async (request, response, next) => {
  try {
    const apiKey = request.query.apiKey || process.env.OLLAMA_API_KEY;
    if (!apiKey) {
      return response.status(400).json({
        success: false,
        error: "apiKey query parameter is required (or set OLLAMA_API_KEY).",
      });
    }
    if (!request.file) {
      return response.status(400).json({ success: false, error: "Image field 'file' is required." });
    }

    const imageBase64 = request.file.buffer.toString("base64");
    const template = await filterImageTemplate(apiKey, imageBase64);
    const data = await extractDocument(
      apiKey,
      imageBase64,
      template,
      request.body?.customPrompt,
    );

    return response.json({
      success: true,
      result: {
        data,
        missingFields: REQUIRED_FIELDS.filter((field) => !data[field]),
        template,
        filename: request.file.originalname,
        customPromptUsed: Boolean(request.body?.customPrompt?.trim()),
      },
    });
  } catch (error) {
    next(error);
  }
});

app.use((error, request, response, _next) => {
  const status = error instanceof multer.MulterError || error.message.includes("image files") ? 400 : 502;
  response.status(status).json({
    success: false,
    error: error.message || "Unexpected server error.",
    filename: request.file?.originalname || null,
  });
});

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`OCR API listening on http://0.0.0.0:${PORT}`);
  });
}

export { app, extractJson, normalizeResult };
