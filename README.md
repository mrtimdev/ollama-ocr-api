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
