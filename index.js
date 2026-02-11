#!/usr/bin/env node

/**
 * Sasha Meeting Room API — Reference Client & Test Harness
 *
 * This app does three things:
 *   1. Starts an Express server to receive callback events from Sasha
 *   2. Provides an interactive CLI to start/stop meetings and query status
 *   3. Demonstrates correct HMAC signature verification
 *
 * Usage:
 *   cp .env.example .env   # Edit with your values
 *   npm install
 *   node index.js
 */

import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import readline from 'readline';
import chalk from 'chalk';

// ── Configuration ───────────────────────────────────────────────────────────

const SASHA_URL = process.env.SASHA_URL || 'http://localhost:3005';
const API_KEY = process.env.API_KEY || '';
const SIGNING_SECRET = process.env.SIGNING_SECRET || '';
const CALLBACK_PORT = parseInt(process.env.CALLBACK_PORT || '4000', 10);
const CALLBACK_URL = process.env.CALLBACK_URL || '';

if (!API_KEY || API_KEY === 'sk_your_api_key_here') {
  console.error(chalk.red('\n  Missing API_KEY. Copy .env.example to .env and add your key.\n'));
  process.exit(1);
}

// ── State ───────────────────────────────────────────────────────────────────

let currentMeetingId = null;
let eventCount = 0;

// ── HMAC Signature Verification ─────────────────────────────────────────────

/**
 * Verify the HMAC-SHA256 signature on an incoming callback event.
 *
 * @param {string} body     - Raw JSON body string
 * @param {string} signature - Value of the X-Sasha-Signature header (e.g., "sha256=abc123...")
 * @param {string} secret   - Your signing secret from the API key creation
 * @returns {boolean}
 */
function verifySignature(body, signature, secret) {
  if (!secret || !signature) return false;

  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ── Callback Event Receiver (Express Server) ────────────────────────────────

const app = express();

// We need the raw body for HMAC verification, so parse manually
app.use('/events', express.raw({ type: 'application/json' }));

/**
 * POST /events — receives callback events from Sasha
 *
 * Headers sent by Sasha:
 *   X-Sasha-Signature:   sha256=<HMAC-SHA256 of body>
 *   X-Sasha-Event:       <event type>
 *   X-Sasha-Meeting-Id:  <meeting ID>
 *   X-Sasha-Delivery-Id: <unique UUID>
 */
app.post('/events', (req, res) => {
  const rawBody = req.body.toString('utf8');
  const signature = req.headers['x-sasha-signature'] || '';
  const eventType = req.headers['x-sasha-event'] || 'unknown';
  const deliveryId = req.headers['x-sasha-delivery-id'] || '';

  // Verify HMAC signature
  let sigValid = false;
  if (SIGNING_SECRET) {
    sigValid = verifySignature(rawBody, signature, SIGNING_SECRET);
    if (!sigValid) {
      console.log(chalk.red(`  [HMAC FAIL] Delivery ${deliveryId} — signature mismatch`));
    }
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    console.log(chalk.red('  [ERROR] Invalid JSON in callback'));
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  eventCount++;
  const sigLabel = SIGNING_SECRET
    ? (sigValid ? chalk.green('HMAC OK') : chalk.red('HMAC FAIL'))
    : chalk.yellow('no secret');
  const seq = chalk.gray(`#${event.sequence || '?'}`);

  // Color-coded output by event type
  switch (eventType) {
    case 'meeting_status':
      console.log(chalk.green(`  [STATUS] ${seq} Meeting ${event.meetingId} -> ${event.payload?.status} ${sigLabel}`));
      if (event.payload?.message) {
        console.log(chalk.green(`           ${event.payload.message}`));
      }
      break;

    case 'caption_partial':
      // Partial captions are high-frequency; show condensed
      process.stdout.write(chalk.blue(`  [CAPTION] ${event.payload?.speaker}: ${event.payload?.text}\r`));
      break;

    case 'segment_finalized':
      console.log(chalk.cyan(`  [SEGMENT] ${seq} ${event.payload?.speaker}: ${event.payload?.text} ${sigLabel}`));
      break;

    case 'coach_insight':
      console.log(chalk.yellow(`  [INSIGHT] ${seq} ${event.payload?.category}: ${event.payload?.text} ${sigLabel}`));
      break;

    case 'participant_joined':
      console.log(chalk.magenta(`  [PARTICIPANT] ${seq} ${event.payload?.name} joined ${sigLabel}`));
      break;

    case 'participant_left':
      console.log(chalk.magenta(`  [PARTICIPANT] ${seq} ${event.payload?.name} left ${sigLabel}`));
      break;

    default:
      console.log(chalk.gray(`  [${eventType.toUpperCase()}] ${seq} ${JSON.stringify(event.payload).slice(0, 100)} ${sigLabel}`));
  }

  res.status(200).json({ received: true });
});

// Health check
app.get('/health', (req, res) => res.json({ ok: true, events: eventCount }));

// ── API Client Functions ────────────────────────────────────────────────────

/**
 * Make an authenticated request to the Sasha API.
 *
 * @param {string} method - HTTP method
 * @param {string} path   - API path (e.g., "/api/v1/meetings/start")
 * @param {object} [body] - Request body (for POST/PUT)
 * @returns {Promise<object>} - Parsed JSON response
 */
async function sashaApi(method, path, body) {
  const url = `${SASHA_URL}${path}`;
  const headers = {
    'X-API-Key': API_KEY,
    'Content-Type': 'application/json'
  };

  const options = { method, headers };
  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }

  return data;
}

/**
 * Start a meeting transcription.
 *
 * POST /api/v1/meetings/start
 * Body: { url, title?, callbackUrl? }
 * Returns: { meetingId, status, platform }
 */
async function startMeeting(meetingUrl, title) {
  const callbackUrl = CALLBACK_URL || `http://localhost:${CALLBACK_PORT}/events`;

  console.log(chalk.gray(`\n  Starting meeting...`));
  console.log(chalk.gray(`  URL: ${meetingUrl}`));
  console.log(chalk.gray(`  Callback: ${callbackUrl}\n`));

  const result = await sashaApi('POST', '/api/v1/meetings/start', {
    url: meetingUrl,
    title: title || 'API Meeting',
    callbackUrl
  });

  currentMeetingId = result.meetingId;
  console.log(chalk.green(`  Meeting started: ${result.meetingId} (${result.platform})`));
  return result;
}

/**
 * Stop a meeting transcription.
 *
 * POST /api/v1/meetings/stop
 * Body: { meetingId }
 * Returns: { status }
 */
async function stopMeeting(meetingId) {
  const id = meetingId || currentMeetingId;
  if (!id) {
    console.log(chalk.red('  No active meeting. Provide a meetingId or start one first.'));
    return;
  }

  const result = await sashaApi('POST', '/api/v1/meetings/stop', { meetingId: id });
  console.log(chalk.green(`  Meeting ${id} -> ${result.status}`));
  if (id === currentMeetingId) currentMeetingId = null;
  return result;
}

/**
 * Get status of all active meetings.
 *
 * GET /api/v1/meetings/status
 * Returns: { meetings: [...] }
 */
async function getStatus() {
  const result = await sashaApi('GET', '/api/v1/meetings/status');

  if (result.meetings.length === 0) {
    console.log(chalk.gray('  No active meetings'));
  } else {
    for (const m of result.meetings) {
      console.log(chalk.cyan(`  ${m.meetingId} | ${m.status} | ${m.platform} | ${m.title || 'Untitled'} | ${m.participantCount} participants | ${m.segmentCount} segments`));
    }
  }
  return result;
}

/**
 * Get transcript for a meeting.
 *
 * GET /api/v1/meetings/:meetingId/transcript
 * Returns: { meetingId, segments: [...] }
 */
async function getTranscript(meetingId) {
  const id = meetingId || currentMeetingId;
  if (!id) {
    console.log(chalk.red('  No active meeting. Provide a meetingId or start one first.'));
    return;
  }

  const result = await sashaApi('GET', `/api/v1/meetings/${id}/transcript`);

  if (!result.segments || result.segments.length === 0) {
    console.log(chalk.gray('  No transcript segments yet'));
  } else {
    console.log(chalk.cyan(`\n  Transcript (${result.segments.length} segments):\n`));
    for (const seg of result.segments) {
      const ts = seg.timestamp ? new Date(seg.timestamp).toLocaleTimeString() : '';
      console.log(chalk.cyan(`  ${ts} ${seg.speaker}: ${seg.text}`));
    }
  }
  return result;
}

// ── Interactive CLI ─────────────────────────────────────────────────────────

function showHelp() {
  console.log(`
  ${chalk.bold('Available commands:')}

    ${chalk.cyan('start <url> [title]')}    Start a meeting transcription
    ${chalk.cyan('stop [meetingId]')}        Stop transcription (uses current if no ID)
    ${chalk.cyan('status')}                  List active meetings
    ${chalk.cyan('transcript [meetingId]')}  Get transcript (uses current if no ID)
    ${chalk.cyan('events')}                  Show callback event count
    ${chalk.cyan('help')}                    Show this help
    ${chalk.cyan('quit')}                    Exit
  `);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // Start callback server
  const server = app.listen(CALLBACK_PORT, () => {
    console.log(chalk.bold(`\n  Sasha Meeting API Client\n`));
    console.log(chalk.gray(`  Sasha URL:      ${SASHA_URL}`));
    console.log(chalk.gray(`  API Key:        ${API_KEY.slice(0, 6)}...${API_KEY.slice(-4)}`));
    console.log(chalk.gray(`  Callback:       http://localhost:${CALLBACK_PORT}/events`));
    if (CALLBACK_URL) {
      console.log(chalk.gray(`  Public URL:     ${CALLBACK_URL}`));
    }
    console.log(chalk.gray(`  HMAC verify:    ${SIGNING_SECRET ? 'enabled' : 'disabled (no SIGNING_SECRET)'}`));
    console.log();
    showHelp();
  });

  // Interactive prompt
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.blue('> ')
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const parts = line.trim().split(/\s+/);
    const cmd = parts[0]?.toLowerCase();

    try {
      switch (cmd) {
        case 'start': {
          const url = parts[1];
          if (!url) {
            console.log(chalk.red('  Usage: start <meeting-url> [title]'));
            break;
          }
          const title = parts.slice(2).join(' ') || undefined;
          await startMeeting(url, title);
          break;
        }

        case 'stop':
          await stopMeeting(parts[1]);
          break;

        case 'status':
          await getStatus();
          break;

        case 'transcript':
          await getTranscript(parts[1]);
          break;

        case 'events':
          console.log(chalk.gray(`  ${eventCount} events received`));
          break;

        case 'help':
          showHelp();
          break;

        case 'quit':
        case 'exit':
        case 'q':
          console.log(chalk.gray('\n  Goodbye!\n'));
          server.close();
          process.exit(0);
          break;

        case '':
          break;

        default:
          console.log(chalk.red(`  Unknown command: ${cmd}. Type 'help' for available commands.`));
      }
    } catch (err) {
      console.log(chalk.red(`  Error: ${err.message}`));
    }

    rl.prompt();
  });

  rl.on('close', () => {
    server.close();
    process.exit(0);
  });
}

main();
