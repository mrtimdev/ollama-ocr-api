# KHB Invoice OCR API

Node.js/Express API that classifies and extracts fields from KHB Delivery Orders
and Goods Transfer Notes with an Ollama Cloud vision model. Requests run through
an in-memory job queue and can be monitored live through Socket.IO.

## Setup

```bash
npm install
cp .env.example .env
npm run css:build
node --env-file=.env batch.js
```

Node.js 20 or newer is required. Environment variables can be exported by your
host or loaded using Node's `--env-file=.env` option.

## Endpoints

- `GET /health` — server and queue health
- `GET /monitor` — live Tailwind CSS monitoring dashboard
- `POST /api/v1/ocr/single` — queue one image
- `POST /api/v1/ocr/batch` — queue up to `MAX_BATCH_SIZE` images
- `GET /api/v1/jobs` — list jobs belonging to the caller
- `GET /api/v1/jobs/:id` — retrieve status and result for a caller's job

Upload requests require a user-facing key from `API_KEYS`. The Ollama key is
never accepted from the caller and stays on the server.

```bash
curl -i -X POST "http://localhost:3000/api/v1/ocr/single" \
  -H "X-API-Key: YOUR_USER_KEY" \
  -F "file=@/path/to/invoice.jpg" \
  -F "customPrompt=Optional extra extraction instruction"
```

The upload returns `202 Accepted`, a job ID, and a `statusUrl`. Poll the URL
using the same user key:

```bash
curl "http://localhost:3000/api/v1/jobs/JOB_ID" \
  -H "X-API-Key: YOUR_USER_KEY"
```

For compatibility with clients that need the completed OCR response in one
request, add `?wait=true`. The request still runs through the queue.

Batch example:

```bash
curl -X POST "http://localhost:3000/api/v1/ocr/batch" \
  -H "Authorization: Bearer YOUR_USER_KEY" \
  -F "files=@/path/to/first.jpg" \
  -F "files=@/path/to/second.jpg"
```

Spring workers should use wait mode so the HTTP response contains the completed
results that are written back to each scan:

```text
http://localhost:3000/api/v1/ocr/single?wait=true
```

Set each Spring AI provider's `baseUrl` directly to the desired endpoint, such
as `http://127.0.0.1:3000/api/v1/ocr/batch` (do not save an `apiKey` query
parameter in the base URL). The provider's stored API key is sent as the
`apiKey` header, while `app.ocr.access-key` is sent
separately in the `X-API-Key` header. Spring sends up to
`app.queue.batch-size` files. Keep
`MAX_BATCH_SIZE` on this service greater than or equal to Spring's batch size
(the default for both is 5).

Open `http://localhost:3000/monitor`. When `MONITOR_API_KEY` is configured, use
the **Monitor access** button to connect. The dashboard receives job metadata
only; OCR results, image buffers, and credentials are not broadcast.

The monitor accepts the dedicated `MONITOR_API_KEY` or any key configured in
`API_KEYS`/`SPRING_API_KEYS`. Monitoring REST calls may send the key in
`X-Monitor-Key`, `X-API-Key`, or `Authorization: Bearer ...`.

Spring-originated requests include scan IDs, their Redis queue name, and the
selected provider ID as monitor metadata. User uploads also preserve their
originating Spring action (`/api/scans`) in that metadata. A dedicated
`MONITOR_API_KEY` can view all jobs; a regular `X-API-Key` can view and manage
only jobs created with the same key. The monitor actions are:

- **Retry** — securely calls Spring and requeues the scans in Spring Redis.
- **Delete** — removes only the Node monitor-history record.
- **More** — displays job, Spring scan, queue, provider, timing, and error data.

Configure the callback when Spring is not running on the default local port:

```env
SPRING_MONITOR_ACTION_URL=http://127.0.0.1:8083/api/internal/ocr-monitor/actions
SPRING_BASE_URL=http://127.0.0.1:8083
SPRING_ACTION_KEY=KEY_FOR_TIM
```

`SPRING_ACTION_KEY` must match Spring's `app.ocr.access-key`/`OCR_ACCESS_KEY`.
When Spring uses the default `127.0.0.1:8083`, the callback variables are
optional. The monitor proxies linked scan details and images through the Node
API, so the Spring action key is never exposed to the browser.

## Queue behavior

The queue is in memory, so queued jobs and history are lost when the process
restarts. `QUEUE_CONCURRENCY` controls simultaneous Ollama jobs and
`JOB_RETENTION_MS` controls how long finished job metadata/results remain
available. For multiple server instances or durable processing, replace the
`JobQueue` adapter with Redis/BullMQ.

The server listens on `0.0.0.0`, so the endpoint is accessible from other
machines through the server's IP address and port when the firewall allows it.

## Deploy to Vercel

The app exports its Express server for Vercel's Node.js runtime. No
`vercel.json` is required.

1. Install and authenticate the CLI:

   ```bash
   npm install --global vercel
   vercel login
   ```

2. From this project directory, link or create the Vercel project:

   ```bash
   vercel link
   ```

3. Store the Ollama key as a Vercel environment variable. Select Production,
   Preview, and Development when prompted:

   ```bash
   vercel env add OLLAMA_API_KEY
   vercel env add API_KEYS
   vercel env add MONITOR_API_KEY
   ```

   Optional variables:

   ```bash
   vercel env add OLLAMA_MODEL
   vercel env add OLLAMA_HOST
   ```

4. Create and test a preview deployment:

   ```bash
   npm run deploy
   ```

5. Deploy to production:

   ```bash
   npm run deploy:prod
   ```

Test the deployed API:

```bash
curl "https://YOUR-PROJECT.vercel.app/health"

curl -X POST "https://YOUR-PROJECT.vercel.app/api/v1/ocr/single?wait=true" \
  -H "X-API-Key: YOUR_USER_KEY" \
  -F "file=@/path/to/invoice.jpg"
```

Vercel Functions accept request payloads up to 4.5 MB. This API limits the
uploaded image to 4 MB to leave room for multipart headers. For larger images,
resize/compress them before uploading or upload them directly to object storage
and change the API to accept a file URL.

Socket.IO and an in-memory queue are best run as a persistent Node.js process.
On serverless Vercel Functions, instances do not share queue state and
persistent Socket.IO connections are not a suitable production architecture.


cd ~/node-js-ocr-api
npm ci --omit=dev

sudo mkdir -p /etc/node-js-ocr-api

sudo nano /etc/node-js-ocr-api/environment

sudo chmod 600 /etc/node-js-ocr-api/environment
sudo chown deverloper:deverloper /etc/node-js-ocr-api/environment
