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

## Quick Start with AI (Recommended)

If you use [Claude Code](https://claude.ai/code), [Cursor](https://cursor.com), or any AI coding assistant, copy and paste this prompt — it will set up everything for you:

> Clone the Sasha Meeting Room API reference client and set it up so I can test live meeting transcription callbacks.
>
> Here's what to do:
>
> 1. Clone: `git clone https://github.com/context-is-everything/sasha-meeting-api-client.git`
> 2. cd into the directory and run: `npm install`
> 3. Create a `.env` file from `.env.example`
> 4. Ask me for my Sasha Studio URL and API key (I'll get these from My Account > API Tokens in Sasha Studio)
> 5. Help me set up ngrok so Sasha can send callbacks to my machine:
>    - Install ngrok if I don't have it (`brew install ngrok` on macOS)
>    - Help me authenticate ngrok with my auth token
>    - Help me claim a free static domain from the ngrok dashboard
>    - Start the tunnel pointing to port 4000 (must match the server port)
>    - IMPORTANT: The ngrok port number MUST be 4000 to match the demo server
> 6. Update `.env` with my Sasha URL, API key, signing secret, and ngrok callback URL
> 7. Start the server with: `node index.js`
> 8. Open http://localhost:4000 in my browser
> 9. Walk me through joining a meeting and verifying that live transcription events appear
>
> The repo is at: https://github.com/context-is-everything/sasha-meeting-api-client

## Quick Start (Manual)

```bash
git clone https://github.com/context-is-everything/sasha-meeting-api-client.git
cd sasha-meeting-api-client
npm install
cp .env.example .env    # Optional — you can enter credentials in the web UI
node index.js
```

Open **http://localhost:4000** in your browser. You'll see a form to enter your Sasha URL, API key, and a meeting URL. Click **Join Meeting** and watch events appear in the live feed as the meeting progresses.

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

## Building a Real Application

This demo displays events in a browser — a real application would persist them to a database. Here's how that architecture looks:

```
┌──────────────────┐         ┌──────────────────────────┐       ┌──────────────────┐
│  Sasha Server    │         │  Your Application        │       │  Database        │
│                  │  HTTP   │                          │       │                  │
│  Meeting bot ────────POST──►  POST /webhook           │       │  meetings        │
│  transcribes     │  events │    ├─ Verify HMAC ──────────INSERT─►  meeting_id    │
│  live audio      │  (with  │    ├─ Parse event        │       │    title         │
│                  │  HMAC)  │    └─ Save to database ─────INSERT─►  status, ...   │
│                  │         │                          │       │                  │
│                  │         │  Your frontend / API     │       │  segments        │
│                  │         │    ├─ GET /meetings ◄────────SELECT─  speaker        │
│                  │         │    ├─ GET /search   ◄────────SEARCH─  text           │
│                  │         │    └─ GET /transcript◄───────SELECT─  timestamp      │
└──────────────────┘         └──────────────────────────┘       └──────────────────┘
```

### Suggested Database Schema

Two tables cover most use cases — one for meetings, one for transcript segments:

```sql
-- Track each meeting Sasha joins
CREATE TABLE meetings (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id      TEXT UNIQUE NOT NULL,   -- from Sasha (e.g. "meeting_17234...")
    title           TEXT,
    platform        TEXT,                   -- "teams" or "google_meet"
    status          TEXT DEFAULT 'joining',
    callback_url    TEXT,
    started_at      DATETIME,
    ended_at        DATETIME,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Store every finalized transcript segment
CREATE TABLE segments (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id      TEXT NOT NULL REFERENCES meetings(meeting_id),
    speaker         TEXT,
    text            TEXT NOT NULL,
    timestamp       DATETIME,
    sequence        INTEGER,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Index for fast lookups
CREATE INDEX idx_segments_meeting ON segments(meeting_id, sequence);
```

You can extend this with tables for `participants`, `insights`, or `callback_deliveries` as needed.

### Example: Persisting Events in Your Callback Handler

Replace the event display logic with database writes:

```javascript
import Database from 'better-sqlite3';  // or any DB library

const db = new Database('meetings.db');

// In your callback handler:
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const rawBody = req.body.toString('utf8');
  const sig = req.headers['x-sasha-signature'];

  // 1. Verify the HMAC signature
  if (!verifySignature(rawBody, sig, process.env.SIGNING_SECRET)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const event = JSON.parse(rawBody);

  // 2. Persist based on event type
  switch (event.type) {
    case 'meeting_status':
      db.prepare(`
        INSERT INTO meetings (meeting_id, status, platform, title, started_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(meeting_id) DO UPDATE SET status = ?, ended_at = CASE WHEN ? IN ('ended','error') THEN CURRENT_TIMESTAMP ELSE ended_at END
      `).run(
        event.meetingId, event.payload.status, event.payload.platform,
        event.payload.title, event.timestamp,
        event.payload.status, event.payload.status
      );
      break;

    case 'segment_finalized':
      db.prepare(`
        INSERT INTO segments (meeting_id, speaker, text, timestamp, sequence)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        event.meetingId, event.payload.speaker,
        event.payload.text, event.payload.timestamp, event.sequence
      );
      break;
  }

  // 3. Always acknowledge quickly — Sasha retries on timeout
  res.json({ received: true });
});
```

### What to Build on Top

Once transcripts are in your database, you can:

- **Search across meetings** — full-text search over all transcript segments
- **Generate summaries** — feed transcripts to an LLM for meeting notes and action items
- **Track action items** — extract and assign follow-ups from coaching insights
- **Build dashboards** — meeting frequency, talk-time per participant, topic trends
- **Integrate with CRM** — link meeting transcripts to customer records
- **Trigger workflows** — automatically notify stakeholders when key topics are mentioned

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
