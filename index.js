#!/usr/bin/env node

/**
 * Sasha Meeting Room API — Reference Client
 *
 * This application demonstrates how to integrate with the Sasha Meeting Room API.
 * It serves a web interface where you can:
 *
 *   1. Enter your Sasha credentials and a meeting URL
 *   2. Join a live meeting and transcribe via the REST API
 *   3. Watch real-time callback events stream in as Sasha delivers them
 *   4. Verify HMAC signatures on every incoming event
 *
 * The app runs a small Express server that:
 *   - Serves the web UI on the root path (/)
 *   - Receives callback POSTs from Sasha on /events
 *   - Streams those events to the browser via Server-Sent Events (SSE)
 *   - Proxies API calls to Sasha to avoid CORS issues
 *
 * Usage:
 *   npm install
 *   cp .env.example .env   # Optional — credentials can also be entered in the UI
 *   node index.js
 *   Open http://localhost:4000 in your browser
 */

import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';

// ── Configuration ───────────────────────────────────────────────────────────

const PORT = parseInt(process.env.CALLBACK_PORT || '4000', 10);

// These can be set in .env or entered through the web UI
let config = {
  sashaUrl: process.env.SASHA_URL || '',
  apiKey: process.env.API_KEY || '',
  signingSecret: process.env.SIGNING_SECRET || '',
  callbackUrl: process.env.CALLBACK_URL || '',
};

// ── State ───────────────────────────────────────────────────────────────────

let currentMeetingId = null;
let eventCount = 0;
const sseClients = new Set();

// ── HMAC Signature Verification ─────────────────────────────────────────────

/**
 * Verify the HMAC-SHA256 signature on an incoming callback event.
 *
 * Sasha signs every callback body with your signing secret so you can
 * confirm the event is authentic and hasn't been tampered with.
 *
 * @param {string} body      Raw JSON body string
 * @param {string} signature Value of the X-Sasha-Signature header ("sha256=...")
 * @param {string} secret    Your signing secret from API key creation
 * @returns {boolean}
 */
function verifySignature(body, signature, secret) {
  if (!secret || !signature) return false;

  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected)
    );
  } catch {
    return false;
  }
}

// ── Express App ─────────────────────────────────────────────────────────────

const app = express();

// Raw body parsing for callback endpoint — must come BEFORE express.json()
// so the /events route gets the raw Buffer for HMAC signature verification.
app.use('/events', express.raw({ type: 'application/json' }));

// JSON parsing for all other endpoints (proxy routes, etc.)
app.use(express.json());

// ── SSE: Stream events to browser ───────────────────────────────────────────

/**
 * GET /sse — Server-Sent Events endpoint
 *
 * The browser opens a persistent connection here. Every callback event
 * received from Sasha is forwarded to all connected browsers in real time.
 */
app.get('/sse', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('data: {"type":"connected"}\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

function broadcastSSE(data) {
  const message = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(message);
  }
}

// ── Callback Receiver ───────────────────────────────────────────────────────

/**
 * POST /events — Receives callback events from Sasha
 *
 * This is the endpoint you register as your callbackUrl when starting a
 * meeting. Sasha POSTs events here as they happen during the meeting.
 *
 * Headers sent by Sasha on every callback:
 *   X-Sasha-Signature:    sha256=<HMAC-SHA256 of body>
 *   X-Sasha-Event:        Event type (e.g. "segment_finalized")
 *   X-Sasha-Meeting-Id:   Meeting ID
 *   X-Sasha-Delivery-Id:  Unique delivery UUID
 */
app.post('/events', (req, res) => {
  const rawBody = req.body.toString('utf8');
  const signature = req.headers['x-sasha-signature'] || '';
  const eventType = req.headers['x-sasha-event'] || 'unknown';

  // Verify HMAC signature
  let hmacStatus = 'no_secret';
  if (config.signingSecret) {
    const valid = verifySignature(rawBody, signature, config.signingSecret);
    hmacStatus = valid ? 'ok' : 'fail';
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  eventCount++;

  // Forward to all connected browsers via SSE
  broadcastSSE({
    type: eventType,
    hmac: hmacStatus,
    sequence: event.sequence,
    meetingId: event.meetingId,
    timestamp: event.timestamp,
    payload: event.payload,
  });

  // Also log to server console for visibility
  console.log(`[${eventType}] #${event.sequence || '?'} HMAC:${hmacStatus}`);

  res.status(200).json({ received: true });
});

// ── Error Helpers ───────────────────────────────────────────────────────────

/**
 * Turn a raw fetch/network error into a human-readable message with guidance.
 */
function friendlyError(err, sashaUrl) {
  const msg = err.message || '';
  const code = err.code || err.cause?.code || '';

  if (!sashaUrl) {
    return 'No Sasha URL provided. Enter your Sasha Studio URL in the form above.';
  }

  if (code === 'ECONNREFUSED' || msg.includes('ECONNREFUSED')) {
    return `Could not connect to ${sashaUrl} — the server refused the connection. Check that Sasha Studio is running and the URL is correct.`;
  }

  if (code === 'ENOTFOUND' || msg.includes('ENOTFOUND') || msg.includes('getaddrinfo')) {
    const host = new URL(sashaUrl).hostname;
    return `Could not resolve hostname "${host}". Check that the Sasha URL is spelled correctly.`;
  }

  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || msg.includes('ETIMEDOUT')) {
    return `Connection to ${sashaUrl} timed out. The server may be down or unreachable from your network.`;
  }

  if (code === 'ECONNRESET' || msg.includes('ECONNRESET')) {
    return `Connection to ${sashaUrl} was reset. The server may have closed the connection unexpectedly.`;
  }

  if (code === 'CERT_HAS_EXPIRED' || msg.includes('certificate') || msg.includes('SSL') || msg.includes('UNABLE_TO_VERIFY')) {
    return `SSL/TLS error connecting to ${sashaUrl}. The server's certificate may be invalid or expired.`;
  }

  if (msg.includes('fetch failed') || msg.includes('Failed to fetch')) {
    return `Could not reach ${sashaUrl}. Check that the URL is correct and the server is running.`;
  }

  if (msg.includes('Invalid URL') || msg.includes('ERR_INVALID_URL')) {
    return `"${sashaUrl}" is not a valid URL. It should look like https://your-instance.sliplane.app`;
  }

  return `Could not connect to Sasha: ${msg}`;
}

/**
 * Safely parse a response as JSON, with a fallback for non-JSON error pages.
 */
async function safeResponseJson(response, sashaUrl) {
  const contentType = response.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    try {
      return await response.json();
    } catch {
      // Fall through to text handling
    }
  }

  // Non-JSON response — build a helpful error from the HTTP status
  const statusMessages = {
    400: 'Bad request — check the meeting URL format.',
    401: 'Invalid API key. Check that your key is correct and hasn\'t been revoked in Sasha Studio (My Account > API Tokens).',
    403: 'Access denied. Your API key may not have permission for this action.',
    404: `Endpoint not found at ${sashaUrl}. Check that the Sasha URL is correct and includes the right path. The API expects endpoints like /api/v1/meetings/start.`,
    429: 'Too many requests. Wait a moment and try again.',
    500: 'Sasha server error. The server encountered an internal problem — try again in a moment.',
    502: 'Bad gateway — Sasha may be restarting. Try again in a few seconds.',
    503: 'Sasha is temporarily unavailable. The server may be starting up or under maintenance.',
  };

  const hint = statusMessages[response.status] || `Unexpected response (HTTP ${response.status}).`;
  return { error: hint };
}

// ── Proxy Endpoints ─────────────────────────────────────────────────────────

/**
 * These endpoints proxy requests from the browser to the Sasha API.
 * This avoids CORS issues since the browser calls our local server,
 * which then forwards to Sasha with the API key.
 */

/** POST /proxy/start — Join an existing meeting */
app.post('/proxy/start', async (req, res) => {
  const { sashaUrl, apiKey, meetingUrl, title, callbackUrl, signingSecret } = req.body;

  // Update config from the form submission
  if (sashaUrl) config.sashaUrl = sashaUrl;
  if (apiKey) config.apiKey = apiKey;
  if (signingSecret !== undefined) config.signingSecret = signingSecret;

  if (!config.sashaUrl) {
    return res.status(400).json({ error: 'No Sasha URL provided. Enter your Sasha Studio URL in the form above.' });
  }
  if (!config.apiKey) {
    return res.status(400).json({ error: 'No API key provided. Enter your API key from Sasha Studio (My Account > API Tokens).' });
  }
  if (!meetingUrl) {
    return res.status(400).json({ error: 'No meeting URL provided. Paste a Teams or Google Meet link for the meeting you want to join.' });
  }

  const effectiveCallbackUrl = callbackUrl || config.callbackUrl || `http://localhost:${PORT}/events`;

  let response;
  try {
    response = await fetch(`${config.sashaUrl}/api/v1/meetings/start`, {
      method: 'POST',
      headers: {
        'X-API-Key': config.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: meetingUrl,
        title: title || 'API Meeting',
        callbackUrl: effectiveCallbackUrl,
      }),
    });
  } catch (err) {
    return res.status(502).json({ error: friendlyError(err, config.sashaUrl) });
  }

  const data = await safeResponseJson(response, config.sashaUrl);
  if (!response.ok) {
    return res.status(response.status).json(data);
  }

  currentMeetingId = data.meetingId;
  broadcastSSE({ type: 'api_response', action: 'start', data });
  res.json(data);
});

/** POST /proxy/stop — Stop a meeting */
app.post('/proxy/stop', async (req, res) => {
  const meetingId = req.body.meetingId || currentMeetingId;
  if (!meetingId) {
    return res.status(400).json({ error: 'No active meeting to leave. Join a meeting first.' });
  }

  let response;
  try {
    response = await fetch(`${config.sashaUrl}/api/v1/meetings/stop`, {
      method: 'POST',
      headers: {
        'X-API-Key': config.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ meetingId }),
    });
  } catch (err) {
    return res.status(502).json({ error: friendlyError(err, config.sashaUrl) });
  }

  const data = await safeResponseJson(response, config.sashaUrl);
  if (!response.ok) {
    return res.status(response.status).json(data);
  }

  if (meetingId === currentMeetingId) currentMeetingId = null;
  broadcastSSE({ type: 'api_response', action: 'stop', data });
  res.json(data);
});

/** GET /proxy/status — List active meetings */
app.get('/proxy/status', async (req, res) => {
  if (!config.sashaUrl) {
    return res.status(400).json({ error: 'No Sasha URL configured. Enter your Sasha Studio URL first.' });
  }

  let response;
  try {
    response = await fetch(`${config.sashaUrl}/api/v1/meetings/status`, {
      headers: { 'X-API-Key': config.apiKey },
    });
  } catch (err) {
    return res.status(502).json({ error: friendlyError(err, config.sashaUrl) });
  }

  const data = await safeResponseJson(response, config.sashaUrl);
  if (!response.ok) {
    return res.status(response.status).json(data);
  }

  res.json(data);
});

/** GET /proxy/transcript/:meetingId — Get transcript */
app.get('/proxy/transcript/:meetingId', async (req, res) => {
  if (!config.sashaUrl) {
    return res.status(400).json({ error: 'No Sasha URL configured. Enter your Sasha Studio URL first.' });
  }

  let response;
  try {
    response = await fetch(
      `${config.sashaUrl}/api/v1/meetings/${req.params.meetingId}/transcript`,
      { headers: { 'X-API-Key': config.apiKey } }
    );
  } catch (err) {
    return res.status(502).json({ error: friendlyError(err, config.sashaUrl) });
  }

  const data = await safeResponseJson(response, config.sashaUrl);
  if (!response.ok) {
    return res.status(response.status).json(data);
  }

  res.json(data);
});

// Health check
app.get('/health', (req, res) => res.json({ ok: true, events: eventCount }));

// ── Web UI ──────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.send(HTML_PAGE);
});

const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sasha Meeting Room API — Demo</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f8f9fa;
      color: #1a1a2e;
      line-height: 1.6;
    }

    .container {
      max-width: 960px;
      margin: 0 auto;
      padding: 2rem 1.5rem;
    }

    /* Header */
    header {
      text-align: center;
      margin-bottom: 2rem;
      padding-bottom: 1.5rem;
      border-bottom: 1px solid #e0e0e0;
    }
    header h1 {
      font-size: 1.75rem;
      font-weight: 700;
      color: #1a1a2e;
      margin-bottom: 0.5rem;
    }
    header p {
      color: #666;
      font-size: 0.95rem;
      max-width: 640px;
      margin: 0 auto;
    }
    header a { color: #4361ee; text-decoration: none; }
    header a:hover { text-decoration: underline; }

    /* Info box */
    .info-box {
      background: #eef2ff;
      border: 1px solid #c7d2fe;
      border-radius: 8px;
      padding: 1rem 1.25rem;
      margin-bottom: 2rem;
      font-size: 0.9rem;
      color: #3730a3;
    }
    .info-box strong { font-weight: 600; }
    .info-box code {
      background: #c7d2fe;
      padding: 0.15em 0.4em;
      border-radius: 3px;
      font-size: 0.85em;
    }

    /* Cards */
    .card {
      background: #fff;
      border: 1px solid #e0e0e0;
      border-radius: 10px;
      padding: 1.5rem;
      margin-bottom: 1.5rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.04);
    }
    .card h2 {
      font-size: 1.1rem;
      font-weight: 600;
      margin-bottom: 1rem;
      color: #1a1a2e;
    }

    /* Forms */
    .form-row {
      display: flex;
      gap: 0.75rem;
      margin-bottom: 0.75rem;
      flex-wrap: wrap;
    }
    .form-group {
      flex: 1;
      min-width: 200px;
    }
    .form-group.full { min-width: 100%; }
    label {
      display: block;
      font-size: 0.8rem;
      font-weight: 600;
      color: #555;
      margin-bottom: 0.25rem;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    input[type="text"], input[type="url"], input[type="password"] {
      width: 100%;
      padding: 0.6rem 0.75rem;
      border: 1px solid #d0d0d0;
      border-radius: 6px;
      font-size: 0.9rem;
      font-family: 'SF Mono', 'Fira Code', monospace;
      background: #fafafa;
      transition: border-color 0.15s;
    }
    input:focus {
      outline: none;
      border-color: #4361ee;
      background: #fff;
      box-shadow: 0 0 0 3px rgba(67, 97, 238, 0.1);
    }
    .hint {
      font-size: 0.75rem;
      color: #888;
      margin-top: 0.2rem;
    }

    /* Buttons */
    .btn-row {
      display: flex;
      gap: 0.75rem;
      margin-top: 1rem;
    }
    button {
      padding: 0.6rem 1.5rem;
      border: none;
      border-radius: 6px;
      font-size: 0.9rem;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s, opacity 0.15s;
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .btn-start {
      background: #4361ee;
      color: #fff;
    }
    .btn-start:hover:not(:disabled) { background: #3a56d4; }
    .btn-stop {
      background: #ef4444;
      color: #fff;
    }
    .btn-stop:hover:not(:disabled) { background: #dc2626; }
    .btn-secondary {
      background: #e5e7eb;
      color: #374151;
    }
    .btn-secondary:hover:not(:disabled) { background: #d1d5db; }

    /* Status badge */
    .status-bar {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.5rem 0;
      font-size: 0.85rem;
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #9ca3af;
    }
    .status-dot.connected { background: #22c55e; }
    .status-dot.active { background: #4361ee; animation: pulse 2s infinite; }
    .status-dot.error { background: #ef4444; }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    /* Event feed */
    #event-feed {
      max-height: 500px;
      overflow-y: auto;
      font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 0.82rem;
    }
    .event-item {
      padding: 0.6rem 0.75rem;
      border-bottom: 1px solid #f0f0f0;
      display: flex;
      gap: 0.75rem;
      align-items: flex-start;
    }
    .event-item:last-child { border-bottom: none; }
    .event-time {
      color: #9ca3af;
      white-space: nowrap;
      min-width: 70px;
      font-size: 0.78rem;
    }
    .event-badge {
      display: inline-block;
      padding: 0.1rem 0.5rem;
      border-radius: 4px;
      font-size: 0.72rem;
      font-weight: 600;
      text-transform: uppercase;
      white-space: nowrap;
      min-width: 80px;
      text-align: center;
    }
    .event-badge.status      { background: #dcfce7; color: #166534; }
    .event-badge.segment     { background: #dbeafe; color: #1e40af; }
    .event-badge.caption     { background: #f0f9ff; color: #0369a1; }
    .event-badge.insight     { background: #fef9c3; color: #854d0e; }
    .event-badge.participant { background: #f3e8ff; color: #6b21a8; }
    .event-badge.api         { background: #e0e7ff; color: #3730a3; }
    .event-badge.error       { background: #fee2e2; color: #991b1b; }
    .event-badge.hmac-fail   { background: #fee2e2; color: #991b1b; }
    .event-content {
      flex: 1;
      word-break: break-word;
    }
    .event-hmac {
      font-size: 0.72rem;
      padding: 0.1rem 0.4rem;
      border-radius: 3px;
      white-space: nowrap;
    }
    .hmac-ok   { background: #dcfce7; color: #166534; }
    .hmac-fail { background: #fee2e2; color: #991b1b; }
    .hmac-none { background: #f3f4f6; color: #6b7280; }

    .empty-state {
      text-align: center;
      padding: 3rem 1rem;
      color: #9ca3af;
    }
    .empty-state p { margin-bottom: 0.5rem; }

    /* API call indicator */
    .api-call {
      background: #f8f9fa;
      border: 1px solid #e5e7eb;
      border-radius: 6px;
      padding: 0.75rem 1rem;
      margin-bottom: 0.75rem;
      font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 0.8rem;
    }
    .api-call .method {
      font-weight: 700;
      color: #4361ee;
    }
    .api-call .url {
      color: #666;
    }

    /* Error events in feed */
    .event-item.error-item {
      background: #fef2f2;
      border-left: 3px solid #ef4444;
      border-bottom-color: #fecaca;
    }

    /* AI setup prompt */
    .ai-setup {
      background: linear-gradient(135deg, #f0f4ff 0%, #e8f0fe 100%);
      border: 2px solid #4361ee;
      border-radius: 10px;
      padding: 1.25rem 1.5rem;
      margin-bottom: 1.25rem;
    }
    .ai-setup-header {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-bottom: 0.5rem;
    }
    .ai-setup-header h3 {
      font-size: 1rem;
      font-weight: 700;
      color: #1a1a2e;
      margin: 0;
    }
    .ai-setup-badge {
      background: #4361ee;
      color: #fff;
      font-size: 0.7rem;
      font-weight: 600;
      padding: 0.15rem 0.5rem;
      border-radius: 10px;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    .ai-setup p {
      font-size: 0.88rem;
      color: #4b5563;
      margin: 0 0 0.75rem;
      line-height: 1.5;
    }
    .ai-prompt-box {
      background: #1f2937;
      color: #e5e7eb;
      padding: 1rem 1.25rem;
      border-radius: 8px;
      font-size: 0.82rem;
      font-family: 'SF Mono', 'Fira Code', monospace;
      line-height: 1.6;
      overflow-x: auto;
      white-space: pre-wrap;
      word-wrap: break-word;
      position: relative;
      margin-bottom: 0.75rem;
    }
    .copy-btn {
      position: absolute;
      top: 0.5rem;
      right: 0.5rem;
      background: #374151;
      color: #d1d5db;
      border: 1px solid #4b5563;
      border-radius: 5px;
      padding: 0.3rem 0.6rem;
      font-size: 0.75rem;
      cursor: pointer;
      transition: background 0.15s;
    }
    .copy-btn:hover {
      background: #4b5563;
      color: #fff;
    }
    .ai-setup .footnote {
      font-size: 0.8rem;
      color: #6b7280;
      margin: 0;
    }

    /* Setup guide */
    .setup-guide {
      background: #fff;
      border: 1px solid #e0e0e0;
      border-radius: 10px;
      padding: 1.5rem;
      margin-bottom: 1.5rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.04);
    }
    .setup-guide h2 {
      font-size: 1.1rem;
      font-weight: 600;
      margin-bottom: 0.75rem;
      color: #1a1a2e;
    }
    .setup-guide h3 {
      font-size: 0.95rem;
      font-weight: 600;
      margin: 1.25rem 0 0.5rem;
      color: #374151;
    }
    .setup-guide p {
      font-size: 0.9rem;
      margin-bottom: 0.5rem;
      color: #4b5563;
    }
    .setup-guide ol {
      padding-left: 1.5rem;
      margin-bottom: 0.75rem;
    }
    .setup-guide li {
      font-size: 0.9rem;
      color: #4b5563;
      margin-bottom: 0.5rem;
      line-height: 1.5;
    }
    .setup-guide code {
      background: #f3f4f6;
      padding: 0.15em 0.4em;
      border-radius: 3px;
      font-size: 0.85em;
      font-family: 'SF Mono', 'Fira Code', monospace;
    }
    .setup-guide pre {
      background: #1f2937;
      color: #e5e7eb;
      padding: 0.75rem 1rem;
      border-radius: 6px;
      font-size: 0.82rem;
      font-family: 'SF Mono', 'Fira Code', monospace;
      overflow-x: auto;
      margin: 0.5rem 0 0.75rem;
    }
    .setup-guide .tip {
      background: #fffbeb;
      border: 1px solid #fde68a;
      border-radius: 6px;
      padding: 0.75rem 1rem;
      font-size: 0.85rem;
      color: #92400e;
      margin: 0.75rem 0;
    }
    details summary {
      cursor: pointer;
      font-weight: 600;
      font-size: 0.95rem;
      color: #374151;
      padding: 0.25rem 0;
    }
    details summary:hover { color: #4361ee; }

    footer {
      text-align: center;
      margin-top: 2rem;
      padding-top: 1.5rem;
      border-top: 1px solid #e0e0e0;
      font-size: 0.85rem;
      color: #888;
    }
    footer a { color: #4361ee; text-decoration: none; }
    footer a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Sasha Meeting Room API</h1>
      <p>
        This demo shows how to integrate with the
        <a href="https://sasha-studio.context-is-everything.com/" target="_blank">Sasha Studio</a>
        Meeting Room API. Enter your credentials, join an existing meeting, and watch
        live transcription events arrive via callbacks.
      </p>
    </header>

    <div class="info-box">
      <strong>How this works:</strong>
      Your browser submits API calls to Sasha to join and leave meetings.
      Sasha then POSTs real-time events (transcription segments, participant changes,
      coaching insights) back to this server's <code>/events</code> endpoint.
      Those events are streamed to your browser via Server-Sent Events so you can
      see them as they happen. Every event includes an HMAC signature for verification.
    </div>

    <!-- Connection & Meeting Configuration -->
    <div class="card">
      <h2>1. Connect to Sasha</h2>
      <div class="form-row">
        <div class="form-group">
          <label for="sasha-url">Sasha Studio URL</label>
          <input type="url" id="sasha-url" placeholder="https://your-instance.sliplane.app">
          <div class="hint">Your Sasha Studio deployment URL</div>
        </div>
        <div class="form-group">
          <label for="api-key">API Key</label>
          <input type="password" id="api-key" placeholder="sk_...">
          <div class="hint">From My Account &gt; API Tokens</div>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label for="signing-secret">Signing Secret <span style="font-weight:400;text-transform:none">(optional)</span></label>
          <input type="password" id="signing-secret" placeholder="ss_...">
          <div class="hint">For HMAC signature verification on callbacks</div>
        </div>
        <div class="form-group">
          <label for="callback-url">Callback URL <span style="font-weight:400;text-transform:none">(optional)</span></label>
          <input type="url" id="callback-url" placeholder="https://your-name.ngrok-free.app/events">
          <div class="hint">Leave empty for local development</div>
        </div>
      </div>
    </div>

    <!-- Join Meeting -->
    <div class="card">
      <h2>2. Join a Meeting</h2>
      <p style="margin:-0.25rem 0 1rem;color:#64748b;font-size:0.9rem;">Paste the link to an existing Teams or Google Meet call. Sasha will join as a bot participant and transcribe the conversation.</p>
      <div class="form-row">
        <div class="form-group" style="flex:2">
          <label for="meeting-url">Meeting URL</label>
          <input type="url" id="meeting-url" placeholder="https://teams.live.com/meet/abc123">
        </div>
        <div class="form-group">
          <label for="meeting-title">Title <span style="font-weight:400;text-transform:none">(optional)</span></label>
          <input type="text" id="meeting-title" placeholder="Daily Standup">
        </div>
      </div>
      <div class="btn-row">
        <button class="btn-start" id="btn-start" onclick="startMeeting()">Join Meeting</button>
        <button class="btn-stop" id="btn-stop" onclick="stopMeeting()" disabled>Leave Meeting</button>
        <button class="btn-secondary" id="btn-status" onclick="checkStatus()">Check Status</button>
        <button class="btn-secondary" id="btn-clear" onclick="clearFeed()">Clear Events</button>
      </div>
      <div class="status-bar">
        <span class="status-dot" id="status-dot"></span>
        <span id="status-text">Not connected</span>
      </div>
    </div>

    <!-- Last API Call -->
    <div class="card" id="api-card" style="display:none">
      <h2>API Request</h2>
      <div class="api-call" id="api-call-display"></div>
    </div>

    <!-- Event Feed -->
    <div class="card">
      <h2>3. Live Event Feed</h2>
      <div id="event-feed">
        <div class="empty-state" id="empty-state">
          <p>No events yet</p>
          <p>Join a meeting above and events will appear here in real time</p>
        </div>
      </div>
    </div>

    <!-- Setup Guides -->
    <div class="setup-guide">
      <h2>Setup Guide</h2>

      <div class="ai-setup">
        <div class="ai-setup-header">
          <h3>Instant setup with AI</h3>
          <span class="ai-setup-badge">Recommended</span>
        </div>
        <p>
          Copy the prompt below and paste it into
          <a href="https://claude.ai/code" target="_blank" style="color:#4361ee;font-weight:600">Claude Code</a>,
          <a href="https://cursor.com" target="_blank" style="color:#4361ee;font-weight:600">Cursor</a>,
          or any AI coding assistant. It will clone this project, install everything, and walk you through
          connecting to Sasha — no manual setup required.
        </p>
        <div class="ai-prompt-box" id="ai-prompt">
          <button class="copy-btn" onclick="copyPrompt()">Copy</button>
Clone the Sasha Meeting Room API reference client and set it up so I can test live meeting transcription callbacks.

Here's what to do:

1. Clone: git clone https://github.com/context-is-everything/sasha-meeting-api-client.git
2. cd into the directory and run: npm install
3. Create a .env file from .env.example
4. Ask me for my Sasha Studio URL and API key (I'll get these from My Account > API Tokens in Sasha Studio)
5. Help me set up ngrok so Sasha can send callbacks to my machine:
   - Install ngrok if I don't have it (brew install ngrok on macOS)
   - Help me authenticate ngrok with my auth token
   - Help me claim a free static domain from the ngrok dashboard
   - Start the tunnel pointing to port 4000 (must match the server port)
   - IMPORTANT: The ngrok port number MUST be 4000 to match the demo server
6. Update .env with my Sasha URL, API key, signing secret, and ngrok callback URL
7. Start the server with: node index.js
8. Open http://localhost:4000 in my browser
9. Walk me through joining a meeting and verifying that live transcription events appear

The repo is at: https://github.com/context-is-everything/sasha-meeting-api-client</div>
        <p class="footnote">Works with Claude Code, Cursor, Windsurf, Copilot, or any AI coding assistant that can run terminal commands.</p>
      </div>

      <details>
        <summary>Need a callback URL? Set up ngrok (5 steps)</summary>
        <div style="padding-top:0.5rem">
          <p>
            <strong>What is ngrok?</strong> When Sasha runs on a remote server, it needs a way
            to send live events back to your computer. ngrok creates a public URL that
            forwards traffic through a secure tunnel to a program running on your machine.
          </p>
          <p>
            In this case, ngrok forwards Sasha's callback events to <em>this demo server</em>
            running on your computer.
          </p>

          <h3>Step 1: Install ngrok</h3>
          <p>On macOS:</p>
          <pre>brew install ngrok</pre>
          <p>On Windows or Linux, download from <a href="https://ngrok.com/download" target="_blank" style="color:#4361ee">ngrok.com/download</a>.</p>

          <h3>Step 2: Create a free account</h3>
          <p>
            Sign up at <a href="https://dashboard.ngrok.com/signup" target="_blank" style="color:#4361ee">dashboard.ngrok.com</a>.
            On the dashboard, copy your <strong>auth token</strong> and run:
          </p>
          <pre>ngrok config add-authtoken YOUR_TOKEN_HERE</pre>

          <h3>Step 3: Claim a free static domain</h3>
          <p>
            In the ngrok dashboard, go to <strong>Cloud Edge &gt; Domains</strong> and claim a
            free static domain (e.g. <code>your-name.ngrok-free.app</code>).
            This domain stays the same forever, so you only need to do this once.
          </p>

          <h3>Step 4: Start the tunnel</h3>
          <pre>ngrok http --domain your-name.ngrok-free.app 4000</pre>
          <p>Replace <code>your-name.ngrok-free.app</code> with the domain you claimed.</p>
          <div class="tip" style="margin-top:0.5rem">
            <strong>Important — the port number must match!</strong>
            The number at the end (<code>4000</code>) tells ngrok which program on your
            computer should receive the traffic. This demo server listens on port
            <strong>4000</strong> by default, so ngrok must forward to <strong>4000</strong>.
            <br><br>
            If they don't match, you'll see events fail with <strong>502 Bad Gateway</strong>
            because ngrok is sending traffic to a port where nothing is listening.
            <br><br>
            <strong>How to check:</strong> When this demo server starts, it prints
            <code>Web UI: http://localhost:4000</code> — the number after <code>localhost:</code>
            is the port ngrok needs. If you changed the port using the <code>CALLBACK_PORT</code>
            environment variable, use that same number in the ngrok command.
          </div>

          <h3>Step 5: Enter the callback URL above</h3>
          <p>
            In the <strong>Callback URL</strong> field on this page, enter your ngrok domain
            with <code>/events</code> on the end:
          </p>
          <pre>https://your-name.ngrok-free.app/events</pre>
          <p>
            That's it. Sasha will now POST events to your ngrok URL, ngrok will forward
            them to this server, and you'll see them appear in the Live Event Feed above.
          </p>
        </div>
      </details>

      <details style="margin-top:0.75rem">
        <summary>Where do I find my API key and signing secret?</summary>
        <div style="padding-top:0.5rem">
          <ol>
            <li>Log in to <a href="https://sasha-studio.context-is-everything.com/" target="_blank" style="color:#4361ee">Sasha Studio</a></li>
            <li>Click your profile icon and go to <strong>My Account</strong></li>
            <li>Select the <strong>API Tokens</strong> tab</li>
            <li>Click <strong>Create Token</strong> and give it a name</li>
            <li>Copy the <strong>API Key</strong> (starts with <code>sk_</code>) and the <strong>Signing Secret</strong> (starts with <code>ss_</code>)</li>
          </ol>
          <div class="tip">
            <strong>Important:</strong> The API key and signing secret are only shown once
            when you create the token. Copy them somewhere safe. If you lose them,
            you'll need to create a new token.
          </div>
        </div>
      </details>

      <details style="margin-top:0.75rem">
        <summary>Common errors and how to fix them</summary>
        <div style="padding-top:0.5rem">
          <table style="width:100%;font-size:0.85rem;border-collapse:collapse">
            <tr style="border-bottom:1px solid #e5e7eb">
              <td style="padding:0.5rem 0.75rem 0.5rem 0;font-weight:600;white-space:nowrap;vertical-align:top">Could not connect</td>
              <td style="padding:0.5rem 0">Check that the Sasha URL is correct and the server is running. Try opening the URL in a new browser tab.</td>
            </tr>
            <tr style="border-bottom:1px solid #e5e7eb">
              <td style="padding:0.5rem 0.75rem 0.5rem 0;font-weight:600;white-space:nowrap;vertical-align:top">401 Invalid API key</td>
              <td style="padding:0.5rem 0">Your API key may be incorrect or revoked. Create a new one in Sasha Studio (My Account &gt; API Tokens).</td>
            </tr>
            <tr style="border-bottom:1px solid #e5e7eb">
              <td style="padding:0.5rem 0.75rem 0.5rem 0;font-weight:600;white-space:nowrap;vertical-align:top">HMAC FAIL</td>
              <td style="padding:0.5rem 0">The signing secret doesn't match. Use the exact secret shown when you created the API token.</td>
            </tr>
            <tr style="border-bottom:1px solid #e5e7eb">
              <td style="padding:0.5rem 0.75rem 0.5rem 0;font-weight:600;white-space:nowrap;vertical-align:top">No events arriving</td>
              <td style="padding:0.5rem 0">Sasha can't reach your callback URL. Check: <strong>(1)</strong> Is ngrok running? <strong>(2)</strong> Is the ngrok port set to <strong>4000</strong> (or whatever port this server is using)? <strong>(3)</strong> Did you enter the full callback URL including <code>/events</code> at the end?</td>
            </tr>
            <tr style="border-bottom:1px solid #e5e7eb">
              <td style="padding:0.5rem 0.75rem 0.5rem 0;font-weight:600;white-space:nowrap;vertical-align:top">502 Bad Gateway</td>
              <td style="padding:0.5rem 0">ngrok is running but forwarding to the wrong port. The port in your ngrok command must match this server's port (default: 4000). Restart ngrok with: <code>ngrok http --domain your-domain 4000</code></td>
            </tr>
            <tr>
              <td style="padding:0.5rem 0.75rem 0.5rem 0;font-weight:600;white-space:nowrap;vertical-align:top">Events show "no secret"</td>
              <td style="padding:0.5rem 0">Not an error — it just means you haven't entered a signing secret, so HMAC verification is skipped. Add your signing secret to enable it.</td>
            </tr>
          </table>
        </div>
      </details>
    </div>

    <footer>
      <a href="https://sasha-studio.context-is-everything.com/" target="_blank">Sasha Studio</a>
      &middot;
      <a href="https://github.com/context-is-everything/sasha-meeting-api-client" target="_blank">Source on GitHub</a>
      &middot;
      <a href="https://contextiseverything.co.uk" target="_blank">Context is Everything</a>
    </footer>
  </div>

  <script>
    // ── State ──────────────────────────────────────────────────────────────

    let activeMeetingId = null;
    let eventSource = null;

    // Pre-fill from server-side .env values (if any)
    const envDefaults = {
      sashaUrl: '${config.sashaUrl}',
      apiKey: '${config.apiKey}',
      signingSecret: '${config.signingSecret}',
      callbackUrl: '${config.callbackUrl}',
    };

    window.addEventListener('DOMContentLoaded', () => {
      if (envDefaults.sashaUrl) document.getElementById('sasha-url').value = envDefaults.sashaUrl;
      if (envDefaults.apiKey) document.getElementById('api-key').value = envDefaults.apiKey;
      if (envDefaults.signingSecret) document.getElementById('signing-secret').value = envDefaults.signingSecret;
      if (envDefaults.callbackUrl) document.getElementById('callback-url').value = envDefaults.callbackUrl;
      connectSSE();
    });

    // ── SSE Connection ────────────────────────────────────────────────────

    function connectSSE() {
      eventSource = new EventSource('/sse');

      eventSource.onopen = () => {
        setStatus('connected', 'Connected — waiting for events');
      };

      eventSource.onmessage = (e) => {
        const data = JSON.parse(e.data);
        if (data.type === 'connected') return;
        if (data.type === 'api_response') {
          showApiResponse(data);
          return;
        }
        addEvent(data);
      };

      eventSource.onerror = () => {
        setStatus('error', 'SSE disconnected — reconnecting...');
      };
    }

    // ── API Actions ───────────────────────────────────────────────────────

    async function startMeeting() {
      const sashaUrl = document.getElementById('sasha-url').value.trim();
      const apiKey = document.getElementById('api-key').value.trim();
      const meetingUrl = document.getElementById('meeting-url').value.trim();
      const title = document.getElementById('meeting-title').value.trim();
      const callbackUrl = document.getElementById('callback-url').value.trim();
      const signingSecret = document.getElementById('signing-secret').value.trim();

      if (!sashaUrl) {
        addErrorEvent('Please enter your Sasha Studio URL (e.g. https://your-instance.sliplane.app).');
        document.getElementById('sasha-url').focus();
        return;
      }
      if (!apiKey) {
        addErrorEvent('Please enter your API key. You can create one in Sasha Studio under My Account > API Tokens.');
        document.getElementById('api-key').focus();
        return;
      }
      if (!meetingUrl) {
        addErrorEvent('Please enter a meeting URL (e.g. https://teams.live.com/meet/abc123).');
        document.getElementById('meeting-url').focus();
        return;
      }

      showApiCall('POST', sashaUrl + '/api/v1/meetings/start', {
        url: meetingUrl,
        title: title || 'API Meeting',
        callbackUrl: callbackUrl || 'http://localhost:${PORT}/events',
      });

      document.getElementById('btn-start').disabled = true;
      setStatus('active', 'Joining meeting...');

      try {
        const res = await fetch('/proxy/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sashaUrl, apiKey, meetingUrl, title, callbackUrl, signingSecret }),
        });

        const data = await res.json();

        if (!res.ok) {
          setStatus('error', 'Error: ' + (data.error || res.statusText));
          document.getElementById('btn-start').disabled = false;
          addErrorEvent('Join failed: ' + (data.error || res.statusText));
          return;
        }

        activeMeetingId = data.meetingId;
        setStatus('active', 'Meeting active: ' + data.meetingId + ' (' + data.platform + ')');
        document.getElementById('btn-stop').disabled = false;
        document.getElementById('btn-start').disabled = false;

        addEvent({
          type: 'api_response',
          payload: { action: 'Joining meeting', meetingId: data.meetingId, platform: data.platform },
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        setStatus('error', 'Network error: ' + err.message);
        document.getElementById('btn-start').disabled = false;
        addErrorEvent('Network error: ' + err.message);
      }
    }

    async function stopMeeting() {
      if (!activeMeetingId) return;

      const sashaUrl = document.getElementById('sasha-url').value.trim();

      showApiCall('POST', sashaUrl + '/api/v1/meetings/stop', {
        meetingId: activeMeetingId,
      });

      document.getElementById('btn-stop').disabled = true;

      try {
        const res = await fetch('/proxy/stop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ meetingId: activeMeetingId }),
        });

        const data = await res.json();

        if (!res.ok) {
          addErrorEvent('Stop failed: ' + (data.error || res.statusText));
          document.getElementById('btn-stop').disabled = false;
          return;
        }

        addEvent({
          type: 'api_response',
          payload: { action: 'Meeting stopping', meetingId: activeMeetingId },
          timestamp: new Date().toISOString(),
        });

        activeMeetingId = null;
        setStatus('connected', 'Meeting stopped — waiting for events');
      } catch (err) {
        addErrorEvent('Network error: ' + err.message);
        document.getElementById('btn-stop').disabled = false;
      }
    }

    async function checkStatus() {
      const sashaUrl = document.getElementById('sasha-url').value.trim();
      showApiCall('GET', sashaUrl + '/api/v1/meetings/status');

      try {
        const res = await fetch('/proxy/status');
        const data = await res.json();

        addEvent({
          type: 'api_response',
          payload: {
            action: 'Status check',
            meetings: data.meetings ? data.meetings.length + ' active' : '0 active',
            details: data.meetings,
          },
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        addErrorEvent('Status check failed: ' + err.message);
      }
    }

    // ── UI Helpers ────────────────────────────────────────────────────────

    function setStatus(state, text) {
      const dot = document.getElementById('status-dot');
      dot.className = 'status-dot ' + state;
      document.getElementById('status-text').textContent = text;
    }

    function showApiCall(method, url, body) {
      const card = document.getElementById('api-card');
      const display = document.getElementById('api-call-display');
      card.style.display = 'block';

      let html = '<span class="method">' + escapeHtml(method) + '</span> '
               + '<span class="url">' + escapeHtml(url) + '</span>';
      if (body) {
        html += '<br><span style="color:#888">Body:</span> '
              + escapeHtml(JSON.stringify(body, null, 2));
      }
      display.innerHTML = html;
    }

    function showApiResponse(data) {
      // API responses from SSE are shown as regular events
    }

    function addEvent(data) {
      const feed = document.getElementById('event-feed');
      const empty = document.getElementById('empty-state');
      if (empty) empty.remove();

      const item = document.createElement('div');
      item.className = 'event-item';

      const time = document.createElement('span');
      time.className = 'event-time';
      const ts = data.timestamp ? new Date(data.timestamp) : new Date();
      time.textContent = ts.toLocaleTimeString();

      const badge = document.createElement('span');
      badge.className = 'event-badge ' + getBadgeClass(data.type);
      badge.textContent = formatEventType(data.type);

      const content = document.createElement('span');
      content.className = 'event-content';
      content.textContent = formatPayload(data);

      item.appendChild(time);
      item.appendChild(badge);
      item.appendChild(content);

      if (data.hmac) {
        const hmac = document.createElement('span');
        hmac.className = 'event-hmac ' + (data.hmac === 'ok' ? 'hmac-ok' : data.hmac === 'fail' ? 'hmac-fail' : 'hmac-none');
        hmac.textContent = data.hmac === 'ok' ? 'HMAC OK' : data.hmac === 'fail' ? 'HMAC FAIL' : 'no secret';
        item.appendChild(hmac);
      }

      feed.appendChild(item);
      feed.scrollTop = feed.scrollHeight;
    }

    function addErrorEvent(message) {
      const feed = document.getElementById('event-feed');
      const empty = document.getElementById('empty-state');
      if (empty) empty.remove();

      const item = document.createElement('div');
      item.className = 'event-item error-item';

      const time = document.createElement('span');
      time.className = 'event-time';
      time.textContent = new Date().toLocaleTimeString();

      const badge = document.createElement('span');
      badge.className = 'event-badge error';
      badge.textContent = 'Error';

      const content = document.createElement('span');
      content.className = 'event-content';
      content.textContent = message;

      item.appendChild(time);
      item.appendChild(badge);
      item.appendChild(content);
      feed.appendChild(item);
      feed.scrollTop = feed.scrollHeight;
    }

    function copyPrompt() {
      const box = document.getElementById('ai-prompt');
      // Get text content, excluding the Copy button text
      const text = box.textContent.replace(/^Copy\n?/, '').trim();
      navigator.clipboard.writeText(text).then(() => {
        const btn = box.querySelector('.copy-btn');
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
      });
    }

    function clearFeed() {
      const feed = document.getElementById('event-feed');
      while (feed.firstChild) feed.removeChild(feed.firstChild);
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.id = 'empty-state';
      const p1 = document.createElement('p');
      p1.textContent = 'No events yet';
      const p2 = document.createElement('p');
      p2.textContent = 'Join a meeting above and events will appear here in real time';
      empty.appendChild(p1);
      empty.appendChild(p2);
      feed.appendChild(empty);
    }

    function getBadgeClass(type) {
      const map = {
        meeting_status: 'status',
        segment_finalized: 'segment',
        caption_partial: 'caption',
        coach_insight: 'insight',
        participant_joined: 'participant',
        participant_left: 'participant',
        api_response: 'api',
        error: 'error',
      };
      return map[type] || 'status';
    }

    function formatEventType(type) {
      const map = {
        meeting_status: 'Status',
        segment_finalized: 'Transcript',
        caption_partial: 'Caption',
        coach_insight: 'Insight',
        participant_joined: 'Joined',
        participant_left: 'Left',
        api_response: 'API',
        error: 'Error',
      };
      return map[type] || type;
    }

    function formatPayload(data) {
      const p = data.payload;
      if (!p) return JSON.stringify(data);

      switch (data.type) {
        case 'meeting_status':
          return 'Meeting ' + (data.meetingId || '') + ' → ' + (p.status || '') + (p.message ? ' — ' + p.message : '');
        case 'segment_finalized':
          return (p.speaker || 'Unknown') + ': ' + (p.text || '');
        case 'caption_partial':
          return (p.speaker || '') + ': ' + (p.text || '');
        case 'coach_insight':
          return (p.category || 'insight') + ': ' + (p.text || '');
        case 'participant_joined':
          return (p.name || 'Someone') + ' joined the meeting';
        case 'participant_left':
          return (p.name || 'Someone') + ' left the meeting';
        case 'api_response':
          return Object.entries(p).map(([k, v]) =>
            k + ': ' + (typeof v === 'object' ? JSON.stringify(v) : v)
          ).join(' | ');
        case 'error':
          return p.message || JSON.stringify(p);
        default:
          return JSON.stringify(p);
      }
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.appendChild(document.createTextNode(text));
      return div.innerHTML;
    }
  </script>
</body>
</html>`;

// ── Start Server ────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n  Sasha Meeting Room API — Reference Client`);
  console.log(`  ──────────────────────────────────────────`);
  console.log(`  Web UI:    http://localhost:${PORT}`);
  console.log(`  Callbacks: http://localhost:${PORT}/events`);
  console.log(`  Health:    http://localhost:${PORT}/health`);
  if (config.sashaUrl) {
    console.log(`  Sasha:     ${config.sashaUrl}`);
  }
  console.log();
});
