#!/usr/bin/env node
/*
 * Zero-dependency server for the Bible Family Tree Explorer.
 *
 * people.json is re-read on every /api/people request so that data entry is
 * "edit the file, refresh the browser" — no restart, no build step.
 * mentions.json (optional repeated-name overrides) is served the same way
 * from /api/mentions; a missing file means "no overrides" ({}).
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

// 8095 is reserved for this app; neighbouring ports belong to other projects.
// PORT exists only so the test suite can bind an OS-chosen free port (PORT=0)
// instead of colliding with a dev server that's already running.
const PORT = process.env.PORT !== undefined ? Number(process.env.PORT) : 8095;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'people.json');
const MENTIONS_FILE = process.env.MENTIONS_FILE || path.join(__dirname, 'data', 'mentions.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': MIME['.json'],
    // Data edits must show up on refresh, so never let the browser cache it.
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

function handleApiPeople(res) {
  fs.readFile(DATA_FILE, 'utf8', (err, raw) => {
    if (err) {
      return sendJson(res, 500, { error: `Could not read data file: ${err.code || err.message}` });
    }
    let people;
    try {
      people = JSON.parse(raw);
    } catch (e) {
      // Surface the parser's message (it includes the position) so whoever
      // hand-edited the file can find the stray comma quickly.
      return sendJson(res, 500, { error: `data/people.json is not valid JSON: ${e.message}` });
    }
    if (!Array.isArray(people)) {
      return sendJson(res, 500, { error: 'data/people.json must be a JSON array of people' });
    }
    sendJson(res, 200, people);
  });
}

// POST /api/people: the edit-mode auto-save. The browser sends the FULL
// people array; it is validated with the same family.js rules the UI and the
// tests use, and only a clean array is written. The write is atomic (temp
// file + rename) so a crash mid-write can never leave a half-written file.
const MAX_BODY = 2000000;

function handleApiPeoplePost(req, res) {
  const chunks = [];
  let size = 0;
  let tooBig = false;
  req.on('data', (c) => {
    if (tooBig) return;
    size += c.length;
    if (size > MAX_BODY) {
      tooBig = true;
      sendJson(res, 413, { error: 'Request body too large (limit ' + MAX_BODY + ' bytes)' });
      return;
    }
    chunks.push(c);
  });
  req.on('error', () => {
    if (!res.headersSent) sendJson(res, 400, { error: 'Could not read request body' });
  });
  req.on('end', () => {
    if (tooBig) return;
    try {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (e) {
        return sendJson(res, 400, { error: 'Body is not valid JSON: ' + e.message });
      }
      if (!Array.isArray(body)) {
        return sendJson(res, 400, { error: 'Body must be a JSON array of people', problems: ['Body must be a JSON array of people'] });
      }
      const notObject = body.findIndex((p) => !p || typeof p !== 'object' || Array.isArray(p));
      if (notObject !== -1) {
        const msg = 'Entry #' + notObject + ' is not an object';
        return sendJson(res, 400, { error: msg, problems: [msg] });
      }
      const problems = require('./public/family.js').validate(body);
      if (problems.length) return sendJson(res, 400, { problems });
      const tmp = DATA_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', 'utf8');
      fs.renameSync(tmp, DATA_FILE);
      sendJson(res, 200, { ok: true, count: body.length });
    } catch (e) {
      console.error('Saving people failed:', e);
      if (!res.headersSent) sendJson(res, 500, { error: 'Could not save data file: ' + (e.code || e.message) });
    }
  });
}

// mentions.json is optional (repeated-name overrides), so a missing file is
// simply "no overrides": 200 with {}. Re-read per request, like people.json.
function handleApiMentions(res) {
  fs.readFile(MENTIONS_FILE, 'utf8', (err, raw) => {
    if (err) {
      if (err.code === 'ENOENT') return sendJson(res, 200, {});
      return sendJson(res, 500, { error: `Could not read mentions file: ${err.code || err.message}` });
    }
    let mentions;
    try {
      mentions = JSON.parse(raw);
    } catch (e) {
      return sendJson(res, 500, { error: `data/mentions.json is not valid JSON: ${e.message}` });
    }
    if (!mentions || typeof mentions !== 'object' || Array.isArray(mentions)) {
      return sendJson(res, 500, { error: 'data/mentions.json must be a JSON object keyed by verse ("Book C:V")' });
    }
    sendJson(res, 200, mentions);
  });
}

function serveStatic(urlPath, res) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    res.writeHead(400);
    return res.end('Bad request');
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  // Block ../ escapes so only files under public/ are ever served.
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  try {
    if (req.method === 'POST' && new URL(req.url, 'http://localhost').pathname === '/api/people') {
      return handleApiPeoplePost(req, res);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      return res.end('Method not allowed');
    }
    const urlPath = new URL(req.url, 'http://localhost').pathname;
    if (urlPath === '/api/people') return handleApiPeople(res);
    if (urlPath === '/api/mentions') return handleApiMentions(res);
    serveStatic(urlPath, res);
  } catch (e) {
    // Last-resort guard: one bad request must never take the server down.
    console.error('Request failed:', e);
    if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' });
    else res.end();
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Is the explorer already running?`);
  } else {
    console.error('Server error:', err);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`Bible Family Tree Explorer listening on http://localhost:${server.address().port}`);
});
