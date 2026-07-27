# KHB Invoice OCR API

Node.js/Express API that classifies and extracts fields from KHB Delivery Orders
and Goods Transfer Notes with an Ollama Cloud vision model.

## Setup

```bash
npm install
cp .env.example .env
npm start
```

Node.js 20 or newer is required. Environment variables can be exported by your
host or loaded using Node's `--env-file=.env` option.

## Endpoints

- `GET /health` — server health check
- `POST /api/v1/ocr/single` — OCR an image (multipart form data)

Example using an API key in the query:

```bash
curl -X POST "http://localhost:3000/api/v1/ocr/single?apiKey=YOUR_KEY" \
  -F "file=@/path/to/invoice.jpg" \
  -F "customPrompt=Optional extra extraction instruction"
```

If `OLLAMA_API_KEY` is configured on the server, omit `?apiKey=YOUR_KEY`.

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

curl -X POST "https://YOUR-PROJECT.vercel.app/api/v1/ocr/single" \
  -F "file=@/path/to/invoice.jpg"
```

Vercel Functions accept request payloads up to 4.5 MB. This API limits the
uploaded image to 4 MB to leave room for multipart headers. For larger images,
resize/compress them before uploading or upload them directly to object storage
and change the API to accept a file URL.
