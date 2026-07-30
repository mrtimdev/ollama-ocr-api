import express from "express";
import multer from "multer";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { Server as SocketIOServer } from "socket.io";
import { authenticateMonitorKey, requireApiKey, requireMonitorKey } from "./auth.js";
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

function normalizeResult(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new Error("Model output is not a JSON object.");
    }

    const normalized = Object.fromEntries(
        REQUIRED_FIELDS.map((field) => [field, data[field] == null ? "" : String(data[field]).trim()])
    );
    const date = normalized.invoiceDate.match(/^(\d{1,2})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{4})$/);
    if (date) {
        normalized.invoiceDate = `${ date[1].padStart(2, "0") }-${ date[2].padStart(2, "0") }-${ date[3] }`;
    }
    const vehicle = normalized.vehicleCode.toUpperCase().match(VEHICLE_CODE_PATTERN);
    normalized.vehicleCode = vehicle?.[1] || "";
    return normalized;
}

async function extractDocument(apiKey, imageBase64, template, customPrompt) {
    const templatePrompt =
        template === "GOODS TRANSFER NOTE" ? GOODS_TRANSFER_NOTE_PROMPT : DELIVERY_ORDER_PROMPT;
    const output = await chatWithImage(apiKey, imageBase64, buildPrompt(customPrompt, templatePrompt));
    return normalizeResult(parseJSONResponse(output));
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

    return results.map(normalizeResult);
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

function parseSpringMetadata(body) {
    let scanIds = [];
    try {
        const parsed = JSON.parse(body?.springScanIds || "[]");
        scanIds = Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : [];
    } catch {
        scanIds = [];
    }
    if (!scanIds.length) return null;
    const providerId = Number(body?.springProviderId);
    return {
        source: "spring-redis",
        scanIds,
        username: String(body?.springUsername || ""),
        action: String(body?.springAction || ""),
        queueName: String(body?.springQueueName || ""),
        providerId: Number.isFinite(providerId) ? providerId : null,
    };
}

function springActionUrl() {
    return process.env.SPRING_MONITOR_ACTION_URL?.trim()
        || `${ springBaseUrl() }/api/internal/ocr-monitor/actions`;
}

function springBaseUrl() {
    return (process.env.SPRING_BASE_URL?.trim() || "http://127.0.0.1:8083").replace(/\/$/, "");
}

function springActionHeaders() {
    return { "X-Monitor-Action-Key": process.env.SPRING_ACTION_KEY || "KEY_FOR_TIM" };
}

async function requestSpringAction(job, action) {
    if (!job?.metadata?.scanIds?.length) {
        throw new Error("This OCR request is not linked to Spring scans.");
    }
    const response = await fetch(springActionUrl(), {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...springActionHeaders(),
        },
        body: JSON.stringify({
            action,
            scanIds: job.metadata.scanIds,
            providerId: job.metadata.providerId,
            queueName: job.metadata.queueName,
            ocrJobId: job.id,
        }),
        signal: AbortSignal.timeout(15_000),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(result.message || result.error || `Spring action failed (${ response.status }).`);
    }
    return result;
}

async function requestSpringScan(scanId, suffix = "") {
    const response = await fetch(
        `${ springBaseUrl() }/api/internal/ocr-monitor/scans/${ encodeURIComponent(scanId) }${ suffix }`,
        {
            headers: springActionHeaders(),
            signal: AbortSignal.timeout(15_000),
        },
    );
    if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.message || result.error || `Spring scan request failed (${ response.status }).`);
    }
    return response;
}

function ollamaKey(request) {
    // Prefer the request header. Provider base URLs are often copied with an old
    // apiKey query parameter, while Spring always sends the current stored key
    // in this header.
    const apiKey = request?.get?.("apiKey")
        || request?.get?.("x-provider-api-key")
        || request?.query?.apiKey
        || process.env.OLLAMA_API_KEY;
    if (!apiKey) {
        throw new Error("The provider apiKey query parameter is required (or set OLLAMA_API_KEY).");
    }
    return String(apiKey).trim();
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

function monitorJobs(request) {
    const jobs = queue.list();
    return request.monitorAccess?.scope === "monitor"
        ? jobs
        : jobs.filter((job) => job.ownerId === request.monitorAccess?.user?.keyId);
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
    const authorization = socket.handshake.headers?.authorization || "";
    const bearerKey = authorization.toLowerCase().startsWith("bearer ")
        ? authorization.slice(7).trim()
        : "";
    const key = socket.handshake.auth?.monitorKey
        || socket.handshake.auth?.apiKey
        || socket.handshake.headers?.["x-monitor-key"]
        || socket.handshake.headers?.["x-api-key"]
        || socket.handshake.query?.monitorKey
        || socket.handshake.query?.apiKey
        || bearerKey
        || "";
    const access = authenticateMonitorKey(key);
    if (!access) return next(new Error("unauthorized"));
    socket.monitorAccess = access;
    next();
});

io.on("connection", (socket) => {
    const jobs = socket.monitorAccess?.scope === "monitor"
        ? queue.list()
        : queue.list().filter((job) => job.ownerId === socket.monitorAccess?.user?.keyId);
    socket.emit("monitor:snapshot", { jobs, stats: queue.stats() });
});

queue.on("updated", (job) => {
    for (const socket of io.sockets.sockets.values()) {
        if (socket.monitorAccess?.scope === "monitor"
            || socket.monitorAccess?.user?.keyId === job.ownerId) {
            socket.emit("job:updated", job);
        }
    }
});
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

app.get("/api/v1/monitor/jobs", requireMonitorKey, (request, response) => {
    response.json({ success: true, jobs: monitorJobs(request), stats: queue.stats() });
});

app.get("/api/v1/monitor/jobs/:id/scans", requireMonitorKey, async (request, response, next) => {
    try {
        const job = queue.get(request.params.id);
        if (!job || (request.monitorAccess?.scope !== "monitor"
            && job.ownerId !== request.monitorAccess?.user?.keyId)) {
            return response.status(404).json({ success: false, error: "Job not found." });
        }
        const scans = await Promise.all(
            (job.metadata?.scanIds || []).map(async (scanId) =>
                requestSpringScan(scanId).then((springResponse) => springResponse.json())),
        );
        return response.json({ success: true, scans });
    } catch (error) {
        next(error);
    }
});

app.get("/api/v1/monitor/jobs/:id/scans/:scanId/image", requireMonitorKey, async (request, response, next) => {
    try {
        const job = queue.get(request.params.id);
        const scanId = Number(request.params.scanId);
        if (!job || !job.metadata?.scanIds?.includes(scanId)
            || (request.monitorAccess?.scope !== "monitor"
                && job.ownerId !== request.monitorAccess?.user?.keyId)) {
            return response.status(404).json({ success: false, error: "Scan image not found." });
        }
        const springResponse = await requestSpringScan(scanId, "/image");
        response.set("Content-Type", springResponse.headers.get("content-type") || "application/octet-stream");
        response.set("Cache-Control", "private, no-store");
        return response.send(Buffer.from(await springResponse.arrayBuffer()));
    } catch (error) {
        next(error);
    }
});

app.post("/api/v1/monitor/jobs/:id/retry", requireMonitorKey, async (request, response, next) => {
    try {
        const job = queue.get(request.params.id);
        if (!job || (request.monitorAccess?.scope !== "monitor"
            && job.ownerId !== request.monitorAccess?.user?.keyId)) {
            return response.status(404).json({ success: false, error: "Job not found." });
        }
        if (!["completed", "failed"].includes(job.status)) {
            return response.status(409).json({ success: false, error: "Only completed or failed requests can be retried." });
        }
        queue.setActionStatus(job.id, "Sending retry to Spring Redis");
        const result = await requestSpringAction(job, "retry");
        queue.setActionStatus(job.id, `Retry queued (${ result.queued || 0 })`);
        return response.json({ success: true, result });
    } catch (error) {
        queue.setActionStatus(request.params.id, `Retry failed: ${ error.message }`);
        next(error);
    }
});

app.delete("/api/v1/monitor/jobs/:id", requireMonitorKey, (request, response) => {
    try {
        const job = queue.get(request.params.id);
        if (!job || (request.monitorAccess?.scope !== "monitor"
            && job.ownerId !== request.monitorAccess?.user?.keyId)) {
            return response.status(404).json({ success: false, error: "Job not found." });
        }
        if (!queue.delete(request.params.id)) {
            return response.status(404).json({ success: false, error: "Job not found." });
        }
        return response.json({ success: true });
    } catch (error) {
        return response.status(409).json({ success: false, error: error.message });
    }
});

app.post("/api/v1/ocr/single", requireApiKey, upload.single("file"), async (request, response, next) => {
    try {
        if (!request.file) {
            return response.status(400).json({ success: false, error: "Image field 'file' is required." });
        }

        const imageBase64 = request.file.buffer.toString("base64");
        const filename = request.file.originalname;
        const customPrompt = request.body?.customPrompt;
        const providerApiKey = ollamaKey(request);
        const job = queue.add({
            type: "single",
            owner: request.apiUser,
            filenames: [filename],
            fileCount: 1,
            metadata: parseSpringMetadata(request.body),
            run: async (progress) => {
                const apiKey = providerApiKey;
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
        const providerApiKey = ollamaKey(request);
        const job = queue.add({
            type: "batch",
            owner: request.apiUser,
            filenames,
            fileCount: files.length,
            metadata: parseSpringMetadata(request.body),
            run: async (progress) => {
                const apiKey = providerApiKey;
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
        console.log(`OCR API listening on http://127.0.0.1:${ PORT }`);
        console.log(`Monitoring UI: http://127.0.0.1:${ PORT }/monitor`);
        console.log(`Max batch size: ${ MAX_BATCH_SIZE }`);
        console.log(`Queue concurrency: ${ QUEUE_CONCURRENCY }`);
    });
}

export { app, httpServer, io, normalizeResult, parseJSONResponse, queue };
export default app;
