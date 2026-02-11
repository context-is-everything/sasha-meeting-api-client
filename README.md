# Sasha Meeting Room API — Reference Client

This is the official reference implementation for the [Sasha Studio](https://sasha-studio.context-is-everything.com/) Meeting Room API.

## What This Demo Shows

The Sasha Meeting Room API lets external applications start and stop live meeting transcriptions via simple REST calls. When a meeting is active, Sasha sends real-time events to your application's callback URL — transcription segments, participant changes, coaching insights, and status updates.

This reference client demonstrates the full integration flow:

1. **Making API calls** — Authenticate with your API key and call `POST /api/v1/meetings/start` to begin transcribing a meeting
2. **Receiving callbacks** — Sasha POSTs events to your registered callback URL as they happen during the meeting
3. **Verifying signatures** — Every callback includes an HMAC-SHA256 signature so you can confirm it came from Sasha
4. **Handling event types** — Different event types (transcript segments, status changes, insights) are displayed with appropriate formatting

The demo runs as a web application. You fill in your credentials, paste a meeting URL, and click Start. Events stream in live as the meeting progresses.

```
┌──────────────────────┐         ┌──────────────────────┐
│  This Client         │         │  Sasha Server        │
│                      │         │                      │
│  Browser form ──────────POST──►  /api/v1/meetings/*   │
│                      │         │                      │
│  Express :4000  ◄──────POST────  Callback events      │
│  /events        SSE   │  HMAC  │  (signed with HMAC)  │
│       ↓              │         │                      │
│  Browser event feed  │         │                      │
└──────────────────────┘         └──────────────────────┘
```

## Quick Start

```bash
git clone https://github.com/context-is-everything/sasha-meeting-api-client.git
cd sasha-meeting-api-client
npm install
cp .env.example .env    # Optional — you can enter credentials in the web UI
node index.js
```

Open **http://localhost:4000** in your browser. You'll see a form to enter your Sasha URL, API key, and a meeting URL. Click **Start Meeting** and watch events appear in the live feed as the meeting progresses.

## How It Works

The application is a small Express server (`index.js`, ~300 lines) that does three things:

1. **Serves a web UI** at `http://localhost:4000` — form inputs for your credentials and meeting URL, with a live event feed below

2. **Receives callbacks** at `POST /events` — this is the URL you register with Sasha when starting a meeting. Sasha sends HTTP POST requests here for every event (transcript segments, status changes, participant updates, coaching insights)

3. **Streams events to the browser** via Server-Sent Events (SSE) — every callback received from Sasha is immediately forwarded to the browser so you can see events arrive in real time

The browser never talks directly to the Sasha API. Instead, it calls local proxy endpoints (`/proxy/start`, `/proxy/stop`, `/proxy/status`) which forward requests to Sasha with the API key. This avoids CORS issues and keeps your API key out of the browser.

## Configuration

You can configure the client either through `.env` (see `.env.example`) or by filling in the form fields in the web UI. Form values take priority.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SASHA_URL` | Yes | — | Your Sasha Studio URL |
| `API_KEY` | Yes | — | API key from My Account > API Tokens |
| `SIGNING_SECRET` | No | — | For HMAC signature verification |
| `CALLBACK_PORT` | No | `4000` | Local port for the web UI and callback receiver |
| `CALLBACK_URL` | No | `http://localhost:{port}/events` | Override callback URL (for ngrok, see below) |

## API Reference

All endpoints require authentication via the `X-API-Key` header.

### Start a Meeting

```http
POST /api/v1/meetings/start
X-API-Key: sk_your_key
Content-Type: application/json

{
  "url": "https://teams.live.com/meet/abc123",
  "title": "Daily Standup",
  "callbackUrl": "https://your-app.com/events"
}
```

**Response (201):**
```json
{
  "meetingId": "meeting_1707234567890_abc123def",
  "status": "joining",
  "platform": "teams"
}
```

### Stop a Meeting

```http
POST /api/v1/meetings/stop
X-API-Key: sk_your_key
Content-Type: application/json

{
  "meetingId": "meeting_1707234567890_abc123def"
}
```

**Response (200):**
```json
{
  "meetingId": "meeting_1707234567890_abc123def",
  "status": "stopping"
}
```

### List Active Meetings

```http
GET /api/v1/meetings/status
X-API-Key: sk_your_key
```

**Response (200):**
```json
{
  "meetings": [
    {
      "meetingId": "meeting_1707234567890_abc123def",
      "status": "live",
      "platform": "teams",
      "title": "Daily Standup",
      "startedAt": "2026-02-10T14:00:00Z",
      "participantCount": 5,
      "segmentCount": 42
    }
  ]
}
```

### Get Transcript

```http
GET /api/v1/meetings/{meetingId}/transcript
X-API-Key: sk_your_key
```

**Response (200):**
```json
{
  "meetingId": "meeting_1707234567890_abc123def",
  "status": "live",
  "segments": [
    {
      "speaker": "Alice",
      "text": "So about the roadmap for Q2...",
      "timestamp": "2026-02-10T14:29:58.123Z"
    }
  ]
}
```

## Authentication

Every request to `/api/v1/*` must include your API key:

```bash
# Via X-API-Key header (recommended)
curl -H "X-API-Key: sk_your_key" https://your-sasha.example.com/api/v1/meetings/status

# Via Authorization header
curl -H "Authorization: Bearer sk_your_key" https://your-sasha.example.com/api/v1/meetings/status
```

Create API keys in Sasha Studio: **My Account > API Tokens**.

## Callback Events

When you provide a `callbackUrl`, Sasha POSTs events as they happen during the meeting. This is the core of the integration — your application receives live data without polling.

### Event Format

Every callback is an HTTP POST with a JSON body:

```json
{
  "type": "segment_finalized",
  "meetingId": "meeting_17234...",
  "sequence": 42,
  "timestamp": "2026-02-10T14:30:00.000Z",
  "payload": {
    "speaker": "Alice",
    "text": "So about the roadmap for Q2...",
    "timestamp": "2026-02-10T14:29:58.123Z"
  }
}
```

### Headers

| Header | Description |
|--------|-------------|
| `X-Sasha-Signature` | `sha256=<HMAC-SHA256>` for verification |
| `X-Sasha-Event` | Event type (e.g., `segment_finalized`) |
| `X-Sasha-Meeting-Id` | Meeting ID |
| `X-Sasha-Delivery-Id` | Unique ID per delivery attempt |

### Event Types

| Type | Description |
|------|-------------|
| `meeting_status` | Status changes: `joining`, `lobby`, `live`, `leaving`, `ended`, `error` |
| `caption_partial` | Live evolving caption (high frequency) |
| `segment_finalized` | Clean finalized transcript segment |
| `coach_insight` | AI coaching insight with category |
| `participant_joined` | Someone joined the meeting |
| `participant_left` | Someone left the meeting |

## HMAC Signature Verification

Every callback includes an `X-Sasha-Signature` header. Verify it to ensure the event came from Sasha and hasn't been tampered with.

### Node.js

```javascript
import crypto from 'crypto';

function verifySignature(body, signature, secret) {
  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected)
  );
}

// In your Express handler:
app.post('/events', express.raw({ type: 'application/json' }), (req, res) => {
  const rawBody = req.body.toString('utf8');
  const sig = req.headers['x-sasha-signature'];

  if (!verifySignature(rawBody, sig, process.env.SIGNING_SECRET)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const event = JSON.parse(rawBody);
  // Process event...
  res.json({ received: true });
});
```

### Python

```python
import hmac
import hashlib

def verify_signature(body: bytes, signature: str, secret: str) -> bool:
    expected = 'sha256=' + hmac.new(
        secret.encode(), body, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(signature, expected)
```

## Connecting to a Remote Sasha Instance

When Sasha runs remotely (e.g., on Sliplane), callback events need a way to reach your local machine. Use [ngrok](https://ngrok.com/) to create a public tunnel.

### Setup

1. **Install ngrok** and authenticate:
   ```bash
   # macOS
   brew install ngrok

   # Then authenticate
   ngrok config add-authtoken <your-token>
   ```

2. **Claim a free static domain** (ngrok dashboard > Cloud Edge > Domains).
   A static domain stays the same across restarts — no reconfiguration needed.

3. **Start the tunnel:**
   ```bash
   ngrok http --domain your-name.ngrok-free.app 4000
   ```

4. **Set your `.env`** or enter in the web UI:
   ```bash
   CALLBACK_URL=https://your-name.ngrok-free.app/events
   ```

5. **Start the client:**
   ```bash
   node index.js
   ```

Events from Sasha flow through ngrok to your local machine and appear in the browser's live event feed.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `401 Invalid API key` | Check the key hasn't been revoked in Sasha Studio |
| `HMAC FAIL` on events | Ensure `SIGNING_SECRET` matches the secret shown when creating the API key |
| No events arriving | Check your `CALLBACK_URL` is reachable from Sasha's network |
| `ECONNREFUSED` | Verify `SASHA_URL` is correct and Sasha is running |
| Events arrive but show `no secret` | Set `SIGNING_SECRET` in `.env` or the web UI |

## Links

- [Sasha Studio](https://sasha-studio.context-is-everything.com/) — the AI knowledge management platform
- [Context is Everything](https://contextiseverything.co.uk) — the company behind Sasha
