# Sasha Meeting Room API — Reference Client

Official reference implementation for the [Sasha Studio](https://github.com/context-is-everything/sasha-ai-knowledge-management) Meeting Room API. Start meetings, receive live transcription events, and verify webhook signatures.

```
┌──────────────────┐         ┌──────────────────────┐
│  This Client     │         │  Sasha Server        │
│                  │         │                      │
│  CLI commands ──────POST──►  /api/v1/meetings/*   │
│                  │         │                      │
│  Express :4000 ◄──POST─────  Callback events      │
│  /events         │  HMAC   │  (signed with HMAC)  │
└──────────────────┘         └──────────────────────┘
```

## Quick Start

```bash
git clone https://github.com/context-is-everything/sasha-meeting-api-client.git
cd sasha-meeting-api-client
npm install
cp .env.example .env    # Edit with your SASHA_URL, API_KEY, SIGNING_SECRET
node index.js
```

Then use the interactive prompt:

```
> start https://teams.live.com/meet/abc123 "Daily Standup"
  Meeting started: meeting_17234... (teams)
  [STATUS] #1 Meeting meeting_17234... -> joining HMAC OK
  [STATUS] #2 Meeting meeting_17234... -> live HMAC OK
  [SEGMENT] #3 Alice: So about the roadmap for Q2... HMAC OK
  [INSIGHT] #7 coverage_gap: No one has mentioned the budget yet HMAC OK
  [PARTICIPANT] #8 Bob joined HMAC OK
> stop
  Meeting meeting_17234... -> stopping
  [STATUS] #12 Meeting meeting_17234... -> ended HMAC OK
```

## Configuration

Create a `.env` file (see `.env.example`):

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SASHA_URL` | Yes | `http://localhost:3005` | Your Sasha Studio URL |
| `API_KEY` | Yes | — | API key from My Account > API Tokens |
| `SIGNING_SECRET` | No | — | For HMAC signature verification |
| `CALLBACK_PORT` | No | `4000` | Local port for receiving events |
| `CALLBACK_URL` | No | `http://localhost:{port}/events` | Override callback URL (for ngrok) |

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
curl -H "X-API-Key: sk_your_key" https://sasha.example.com/api/v1/meetings/status

# Via Authorization header
curl -H "Authorization: Bearer sk_your_key" https://sasha.example.com/api/v1/meetings/status
```

Create API keys in Sasha Studio: **My Account > API Tokens**.

## Callback Events

When you provide a `callbackUrl`, Sasha POSTs events as they happen.

### Event Format

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

Every callback includes an `X-Sasha-Signature` header. Verify it to ensure the event came from Sasha.

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

## Local Development with ngrok

When Sasha runs remotely (e.g., on Sliplane), your callback URL needs to be publicly reachable.

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

4. **Set your `.env`:**
   ```bash
   CALLBACK_URL=https://your-name.ngrok-free.app/events
   ```

5. **Start the client:**
   ```bash
   node index.js
   ```

Events from Sasha flow through ngrok to your local machine.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `Missing API_KEY` | Copy `.env.example` to `.env` and add your key |
| `401 Invalid API key` | Check the key hasn't been revoked in Sasha Studio |
| `HMAC FAIL` on events | Ensure `SIGNING_SECRET` matches the secret shown when creating the API key |
| No events arriving | Check your `CALLBACK_URL` is reachable from Sasha's network |
| `ECONNREFUSED` | Verify `SASHA_URL` is correct and Sasha is running |
| Events arrive but HMAC shows `no secret` | Set `SIGNING_SECRET` in `.env` |

## Links

- [Sasha Studio](https://github.com/context-is-everything/sasha-ai-knowledge-management) — the AI knowledge management platform
- [Context is Everything](https://contextiseverything.co.uk) — the company behind Sasha
