import express from "express";
import multer from "multer";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { Server as SocketIOServer } from "socket.io";
import { requireApiKey, requireMonitorKey, isMonitorKeyValid } from "./auth.js";
import { JobQueue } from "./queue.js";

const MODEL_NAME = process.env.OLLAMA_MODEL || "gemma4:31b-cloud";
const OLLAMA_HOST = (process.env.OLLAMA_HOST || "https://ollama.com").replace(/\/$/, "");
const PORT = Number(process.env.PORT || 3000);
const MAX_BATCH_SIZE = Number(process.env.MAX_BATCH_SIZE || 5);
const QUEUE_CONCURRENCY = Number(process.env.QUEUE_CONCURRENCY || 2);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REQUIRED_FIELDS = [
    "no",
    "invoiceDate",
    "dealerCode",
    "saleOrder",
    "vendorCode",
    "vehicleCode",
];

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

const BATCH_CLASSIFICATION_PROMPT = `
Classify each of the following images as exactly one of these KHB document templates:
- DELIVERY ORDER
- GOODS TRANSFER NOTE

For each image, identify the document template based on the large printed document title, not handwritten notes or stamps.

Return ONLY a JSON array where each element is the template label for the corresponding image:
["DELIVERY ORDER", "GOODS TRANSFER NOTE", ...]

Return JSON only, with no markdown or explanation.
`;

function createBatchExtractionPrompt(documents, customPrompts) {
    let prompt = `Extract fields from the following KHB documents and return ONLY valid JSON array.\n\n`;

    documents.forEach((doc, index) => {
        const templatePrompt = doc.template === "GOODS TRANSFER NOTE"
            ? GOODS_TRANSFER_NOTE_PROMPT
            : DELIVERY_ORDER_PROMPT;

        const customInstruction = customPrompts[index]?.trim() || "";
        const fullPrompt = customInstruction
            ? `${ templatePrompt }\nAdditional caller instructions for document ${ index + 1 }:\n${ customInstruction }\nThe template rules and exact JSON structure above remain mandatory.`
            : templatePrompt;

        prompt += `--- Document ${ index + 1 } (${ doc.template }) ---\n`;
        prompt += fullPrompt;
        prompt += `\n\n`;
    });

    prompt += `\nReturn a JSON array of objects, each with the fields: ${ REQUIRED_FIELDS.join(", ") }. Order must match the document order. Return JSON only.`;

    return prompt;
}

const app = express();
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer);
const queue = new JobQueue({
    concurrency: QUEUE_CONCURRENCY,
    retentionMs: Number(process.env.JOB_RETENTION_MS || 60 * 60 * 1000),
});
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 4 * 1024 * 1024,
        files: MAX_BATCH_SIZE
    },
    fileFilter: (_request, file, callback) => {
        if (!file.mimetype.startsWith("image/")) {
            return callback(new Error("Only image files are accepted."));
        }
        callback(null, true);
    },
});

async function chatWithImage(apiKey, imageBase64, prompt) {
    const response = await fetch(`${ OLLAMA_HOST }/api/chat`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${ apiKey }`,
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
        throw new Error(`Ollama request failed (${ response.status }): ${ detail.slice(0, 500) }`);
    }

    const body = await response.json();
    if (!body?.message?.content) throw new Error("Ollama returned an empty response.");
    return body.message.content;
}

async function chatWithMultipleImages(apiKey, imagesBase64, prompt) {
    const response = await fetch(`${ OLLAMA_HOST }/api/chat`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${ apiKey }`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: MODEL_NAME,
            messages: [{ role: "user", content: prompt, images: imagesBase64 }],
            stream: false,
            options: { temperature: 0, num_ctx: 16384 },
        }),
        signal: AbortSignal.timeout(180_000),
    });

    if (!response.ok) {
        const detail = await response.text();
        throw new Error(`Ollama batch request failed (${ response.status }): ${ detail.slice(0, 500) }`);
    }

    const body = await response.json();
    if (!body?.message?.content) throw new Error("Ollama returned an empty response.");
    return body.message.content;
}

async function filterImageTemplate(apiKey, imageBase64) {
    const raw = await chatWithImage(apiKey, imageBase64, TEMPLATE_CLASSIFICATION_PROMPT);
    const template = raw.trim();
    if (template === "GOODS TRANSFER NOTE") return "GOODS TRANSFER NOTE";
    if (template === "DELIVERY ORDER") return "DELIVERY ORDER";
    throw new Error(`Unsupported image template: ${ template }`);
}

async function filterMultipleImageTemplates(apiKey, imagesBase64) {
    const raw = await chatWithMultipleImages(apiKey, imagesBase64, BATCH_CLASSIFICATION_PROMPT);
    const templates = JSON.parse(raw.trim());

    if (!Array.isArray(templates) || templates.length !== imagesBase64.length) {
        throw new Error(`Expected ${ imagesBase64.length } templates, got ${ templates?.length || 0 }`);
    }

    return templates.map(template => {
        const normalized = String(template).trim();
        if (normalized === "GOODS TRANSFER NOTE") return "GOODS TRANSFER NOTE";
        if (normalized === "DELIVERY ORDER") return "DELIVERY ORDER";
        throw new Error(`Unsupported template: ${ template }`);
    });
}

function buildPrompt(customPrompt, templatePrompt) {
    if (!customPrompt?.trim()) return templatePrompt;
    return `${ templatePrompt }
Additional caller instructions:
${ customPrompt.trim() }
The template rules and exact JSON structure above remain mandatory.`;
}

function parseJSONResponse(text) {
    const cleaned = text.trim().replace(/```json|```/gi, "").trim();
    return JSON.parse(cleaned);
}

async function extractDocument(apiKey, imageBase64, template, customPrompt) {
    const templatePrompt =
        template === "GOODS TRANSFER NOTE" ? GOODS_TRANSFER_NOTE_PROMPT : DELIVERY_ORDER_PROMPT;
    const output = await chatWithImage(apiKey, imageBase64, buildPrompt(customPrompt, templatePrompt));
    return parseJSONResponse(output);
}

async function extractMultipleDocuments(apiKey, imagesBase64, templates, customPrompts) {
    const prompt = createBatchExtractionPrompt(
        templates.map(t => ({ template: t })),
        customPrompts || []
    );

    const output = await chatWithMultipleImages(apiKey, imagesBase64, prompt);
    const results = parseJSONResponse(output);

    if (!Array.isArray(results) || results.length !== imagesBase64.length) {
        throw new Error(`Expected ${ imagesBase64.length } results, got ${ results?.length || 0 }`);
    }

    return results;
}

function parseCustomPrompts(value) {
    if (!value) return [];
    try {
        const parsed = typeof value === "string" ? JSON.parse(value) : value;
        return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
        return [String(value)];
    }
}

function ollamaKey() {
    if (!process.env.OLLAMA_API_KEY) {
        throw new Error("OLLAMA_API_KEY is not configured on the server.");
    }
    return process.env.OLLAMA_API_KEY;
}

function jobResponse(job) {
    return {
        success: job.status !== "failed",
        job,
        statusUrl: `/api/v1/jobs/${ job.id }`,
    };
}

function canReadJob(request, job) {
    return job && request.apiUser?.keyId === job.ownerId;
}

async function sendQueuedResponse(request, response, job) {
    if (request.query.wait !== "true") {
        response.set("Location", `/api/v1/jobs/${ job.id }`);
        return response.status(202).json(jobResponse(job));
    }

    const finished = await queue.waitFor(job.id);
    return response.status(finished.status === "failed" ? 502 : 200).json(jobResponse(finished));
}

io.use((socket, next) => {
    const key = socket.handshake.auth?.monitorKey || "";
    if (!isMonitorKeyValid(key)) return next(new Error("unauthorized"));
    next();
});

io.on("connection", (socket) => {
    socket.emit("monitor:snapshot", { jobs: queue.list(), stats: queue.stats() });
});

queue.on("updated", (job) => io.emit("job:updated", job));
queue.on("stats", (stats) => io.emit("queue:stats", stats));
queue.on("removed", (id) => io.emit("job:removed", id));

app.use("/assets", express.static(path.join(__dirname, "public/assets")));
app.get("/monitor", (_request, response) => {
    response.sendFile(path.join(__dirname, "public/index.html"));
});

app.get("/", (_request, response) => {
    response.json({
        name: "Tim Dev: Invoice OCR API - AI Cloud",
        status: "ok",
        endpoints: {
            single: "POST /api/v1/ocr/single",
            batch: "POST /api/v1/ocr/batch",
            job: "GET /api/v1/jobs/:id",
            monitor: "GET /monitor",
        },
        maxBatchSize: MAX_BATCH_SIZE,
        queueConcurrency: QUEUE_CONCURRENCY,
    });
});

app.get("/health", (_request, response) => response.json({
    status: "ok",
    queue: queue.stats(),
}));

app.get("/api/v1/jobs", requireApiKey, (request, response) => {
    const jobs = queue.list().filter((job) => job.ownerId === request.apiUser.keyId);
    response.json({ success: true, jobs });
});

app.get("/api/v1/jobs/:id", requireApiKey, (request, response) => {
    const job = queue.get(request.params.id);
    if (!canReadJob(request, job)) {
        return response.status(404).json({ success: false, error: "Job not found." });
    }
    response.json(jobResponse(job));
});

app.get("/api/v1/monitor/jobs", requireMonitorKey, (_request, response) => {
    response.json({ success: true, jobs: queue.list(), stats: queue.stats() });
});

app.post("/api/v1/ocr/single", requireApiKey, upload.single("file"), async (request, response, next) => {
    try {
        if (!request.file) {
            return response.status(400).json({ success: false, error: "Image field 'file' is required." });
        }

        const imageBase64 = request.file.buffer.toString("base64");
        const filename = request.file.originalname;
        const customPrompt = request.body?.customPrompt;
        const job = queue.add({
            type: "single",
            owner: request.apiUser,
            filenames: [filename],
            fileCount: 1,
            run: async (progress) => {
                const apiKey = ollamaKey();
                const template = await filterImageTemplate(apiKey, imageBase64);
                progress(50);
                const data = await extractDocument(apiKey, imageBase64, template, customPrompt);
                return {
                    success: true,
                    result: {
                        data,
                        missingFields: REQUIRED_FIELDS.filter((field) => !data[field]),
                        template,
                        filename,
                        customPromptUsed: Boolean(customPrompt?.trim()),
                    },
                };
            },
        });
        return await sendQueuedResponse(request, response, job);
    } catch (error) {
        next(error);
    }
});

app.post("/api/v1/ocr/batch", requireApiKey, upload.array("files", MAX_BATCH_SIZE), async (request, response, next) => {
    try {
        const files = request.files;
        if (!files || files.length === 0) {
            return response.status(400).json({
                success: false,
                error: "At least one image file is required in 'files' field."
            });
        }

        if (files.length > MAX_BATCH_SIZE) {
            return response.status(400).json({
                success: false,
                error: `Maximum ${ MAX_BATCH_SIZE } files allowed per batch.`,
            });
        }

        const customPrompts = parseCustomPrompts(request.body?.customPrompts);
        const imagesBase64 = files.map(file => file.buffer.toString("base64"));
        const filenames = files.map((file) => file.originalname);
        const job = queue.add({
            type: "batch",
            owner: request.apiUser,
            filenames,
            fileCount: files.length,
            run: async (progress) => {
                const apiKey = ollamaKey();
                const templates = await filterMultipleImageTemplates(apiKey, imagesBase64);
                progress(50);
                const dataArray = await extractMultipleDocuments(apiKey, imagesBase64, templates, customPrompts);
                const results = files.map((file, index) => ({
                    data: dataArray[index] || null,
                    missingFields: dataArray[index]
                        ? REQUIRED_FIELDS.filter((field) => !dataArray[index][field])
                        : REQUIRED_FIELDS,
                    template: templates[index] || null,
                    filename: file.originalname,
                    customPromptUsed: Boolean(customPrompts[index]?.trim()),
                }));
                const failures = results.filter((result) => !result.data);
                return {
                    success: failures.length === 0,
                    total: files.length,
                    successCount: results.length - failures.length,
                    failureCount: failures.length,
                    results,
                };
            },
        });
        return await sendQueuedResponse(request, response, job);
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
    httpServer.listen(PORT, "0.0.0.0", () => {
        console.log(`OCR API listening on http://0.0.0.0:${ PORT }`);
        console.log(`Monitoring UI: http://0.0.0.0:${ PORT }/monitor`);
        console.log(`Max batch size: ${ MAX_BATCH_SIZE }`);
        console.log(`Queue concurrency: ${ QUEUE_CONCURRENCY }`);
    });
}

export { app, httpServer, io, parseJSONResponse, queue };
export default app;
