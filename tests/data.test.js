#!/usr/bin/env node
/*
 * Data integrity + server smoke tests. Zero dependencies: run with
 *   node tests/data.test.js
 *
 * The integrity checks are written out directly here (not only via
 * Family.validate) so that a bug in the shared validator can't silently
 * make the real data look clean.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DATA_FILE = path.join(ROOT, 'data', 'people.json');
const Family = require(path.join(ROOT, 'public', 'family.js'));

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ------------------------------------------------------------------ data file

let people;
test('people.json parses as a JSON array', () => {
  people = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  assert(Array.isArray(people), 'top level must be an array');
  assert(people.length > 0, 'array must not be empty');
});

test('ids are unique non-empty strings', () => {
  const seen = new Set();
  for (const p of people) {
    assert.strictEqual(typeof p.id, 'string', `id must be a string: ${JSON.stringify(p.id)}`);
    assert(p.id.length > 0, 'id must not be empty');
    assert(!seen.has(p.id), `duplicate id "${p.id}"`);
    seen.add(p.id);
  }
});

test('every person has the required fields with the right types', () => {
  for (const p of people) {
    assert(typeof p.name === 'string' && p.name.trim(), `${p.id}: name required`);
    assert(['male', 'female'].includes(p.gender), `${p.id}: gender must be male|female, got ${JSON.stringify(p.gender)}`);
    assert(Number.isInteger(p.generation) && p.generation > 0, `${p.id}: generation must be a positive int, got ${JSON.stringify(p.generation)}`);
    assert(p.age === null || (typeof p.age === 'number' && p.age >= 0), `${p.id}: age must be null or a non-negative number`);
    assert('mom' in p && 'dad' in p, `${p.id}: mom and dad keys are required (use null when unknown)`);
    assert(Array.isArray(p.notes), `${p.id}: notes must be an array (use [] for none)`);
    for (const k of ['children', 'siblings']) {
      assert(!(k in p), `${p.id}: "${k}" must not be stored — it is derived from mom/dad`);
    }
  }
});

test('mom/dad references point to existing people of the right gender', () => {
  const byId = new Map(people.map((p) => [p.id, p]));
  for (const p of people) {
    for (const [role, gender] of [['mom', 'female'], ['dad', 'male']]) {
      if (p[role] === null) continue;
      const parent = byId.get(p[role]);
      assert(parent, `${p.id}.${role} -> "${p[role]}" does not exist`);
      assert.notStrictEqual(parent.id, p.id, `${p.id} is their own ${role}`);
      assert.strictEqual(parent.gender, gender, `${p.id}.${role} -> "${parent.id}" should be ${gender}`);
      assert(parent.generation < p.generation, `${p.id} (gen ${p.generation}) has ${role} "${parent.id}" in gen ${parent.generation}`);
    }
  }
});

test('derived children point back to their parent and resolve to real people', () => {
  const idx = Family.buildIndex(people);
  assert.deepStrictEqual(idx.problems, []);
  for (const [parentId, kids] of idx.childrenOf) {
    for (const kid of kids) {
      const child = idx.byId.get(kid);
      assert(child, `child id "${kid}" of ${parentId} does not exist`);
      assert(child.mom === parentId || child.dad === parentId, `${kid} listed as child of ${parentId} but neither parent matches`);
    }
  }
  // And the reverse: every recorded parent link shows up as a derived child.
  for (const p of people) {
    for (const role of ['mom', 'dad']) {
      if (p[role]) assert(idx.childrenOf.get(p[role]).includes(p.id), `${p.id} missing from ${p[role]}'s children`);
    }
  }
});

test('sibling sets are mutually consistent with parent linkage', () => {
  const idx = Family.buildIndex(people);
  const byId = idx.byId;
  for (const [id, sibs] of idx.siblingsOf) {
    const me = byId.get(id);
    for (const { id: sid, kind } of sibs) {
      const sib = byId.get(sid);
      assert(sib, `${id} has unknown sibling "${sid}"`);
      assert.notStrictEqual(sid, id, `${id} is listed as their own sibling`);
      const sameMom = me.mom !== null && me.mom === sib.mom;
      const sameDad = me.dad !== null && me.dad === sib.dad;
      assert(sameMom || sameDad, `${id} and ${sid} are siblings but share no parent`);
      // Symmetry: if X lists Y, Y must list X with the same relationship.
      const back = idx.siblingsOf.get(sid).find((s) => s.id === id);
      assert(back, `${id} lists ${sid} as sibling but not vice versa`);
      assert.strictEqual(back.kind, kind, `${id}<->${sid} sibling kind disagrees (${kind} vs ${back.kind})`);
      if (kind === 'full') assert(sameMom && sameDad, `${id}<->${sid} marked full siblings without both parents shared`);
    }
  }
  // Completeness: anyone sharing a known parent must be listed.
  for (const a of people) {
    for (const b of people) {
      if (a.id === b.id) continue;
      const share = (a.mom && a.mom === b.mom) || (a.dad && a.dad === b.dad);
      const listed = idx.siblingsOf.get(a.id).some((s) => s.id === b.id);
      assert.strictEqual(!!share, listed, `${a.id}/${b.id}: share parent=${!!share} but listed=${listed}`);
    }
  }
});

test('every note has text and at least one valid scripture ref', () => {
  for (const p of people) {
    p.notes.forEach((n, i) => {
      const where = `${p.id} note #${i + 1}`;
      assert(typeof n.text === 'string' && n.text.trim(), `${where}: text required`);
      assert(Array.isArray(n.refs) && n.refs.length > 0, `${where}: needs at least one ref`);
      for (const r of n.refs) assert(Family.isValidRef(r), `${where}: "${r}" is not a recognised reference`);
      for (const q of n.quotes || []) {
        assert(typeof q.text === 'string' && q.text.trim(), `${where}: quote text required`);
        assert(n.refs.includes(q.ref), `${where}: quoted ${q.ref} must also be listed in refs`);
      }
    });
  }
});

test('shared validator agrees the data is clean', () => {
  assert.deepStrictEqual(Family.validate(people), []);
});

// ------------------------------------------------------------------ logic units

test('buildIndex derives half-siblings and reports dangling refs without throwing', () => {
  const idx = Family.buildIndex([
    { id: 'm1', gender: 'female' }, { id: 'm2', gender: 'female' }, { id: 'd', gender: 'male' },
    { id: 'a', mom: 'm1', dad: 'd' }, { id: 'b', mom: 'm1', dad: 'd' },
    { id: 'c', mom: 'm2', dad: 'd' }, { id: 'e', mom: null, dad: 'd' },
    { id: 'x', mom: 'ghost', dad: null }, { id: 'a' }
  ]);
  const kinds = Object.fromEntries(idx.siblingsOf.get('a').map((s) => [s.id, s.kind]));
  assert.deepStrictEqual(kinds, { b: 'full', c: 'half-paternal', e: 'paternal' });
  assert.deepStrictEqual(idx.childrenOf.get('d'), ['a', 'b', 'c', 'e']);
  assert(idx.problems.some((p) => p.includes('ghost')), 'dangling ref should be reported');
  assert(idx.problems.some((p) => p.includes('Duplicate id "a"')), 'duplicate id should be reported');
  assert.deepStrictEqual(Family.buildIndex({ not: 'an array' }).problems, ['people.json must contain a JSON array']);
});

test('validate catches the mistakes a hand editor is likely to make', () => {
  const bad = [
    { id: 'p', name: 'P', gender: 'male', generation: 2, age: null, mom: null, dad: null, notes: [] },
    { id: 'k', name: 'K', gender: 'female', generation: 1, age: -3, mom: 'p', dad: null,
      notes: [{ text: 'x', refs: [] }, { text: 'y', refs: ['Hezekiah 1:1'], quotes: [{ ref: 'Genesis 1:1', text: 'z' }] }] },
    { id: 'g', name: '', gender: 'other', generation: 0, age: 1, mom: null, dad: null, notes: [] }
  ];
  const problems = Family.validate(bad).join('\n');
  for (const needle of ['is not female', 'earlier generation', 'age must be', 'at least one ref',
    'unrecognised ref "Hezekiah 1:1"', 'not in its refs', '"g" has no name', 'gender must be', 'positive integer']) {
    assert(problems.includes(needle), `expected a problem mentioning "${needle}" in:\n${problems}`);
  }
});

test('scripture refs validate and build BibleGateway KJV URLs', () => {
  for (const ok of ['Genesis 4:25', 'Genesis 2:18-25', '1 Samuel 3:4', 'Song of Solomon 2:1', 'Psalm 23', 'Genesis 1:1-2:3']) {
    assert(Family.isValidRef(ok), `${ok} should be valid`);
  }
  for (const bad of ['Genesis', 'Gen 4:25', 'genesis 4:25', '4:25', 'Hezekiah 1:1', '']) {
    assert(!Family.isValidRef(bad), `${bad} should be invalid`);
  }
  assert.strictEqual(Family.bibleUrl('Genesis 4:25'),
    'https://www.biblegateway.com/passage/?search=Genesis%204%3A25&version=KJV');
  assert.deepStrictEqual(Family.splitRefs('see Genesis 1:3 and 1 John 2:1.'), [
    { type: 'text', value: 'see ' }, { type: 'ref', value: 'Genesis 1:3' },
    { type: 'text', value: ' and ' }, { type: 'ref', value: '1 John 2:1' }, { type: 'text', value: '.' }
  ]);
});

// ------------------------------------------------------------------ server smoke

function startServer(env) {
  return new Promise((resolve, reject) => {
    // PORT=0 lets the OS pick a free port, so tests never fight a running
    // dev server on 8095 or any other project's port.
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: { ...process.env, PORT: '0', HOST: '127.0.0.1', ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('server did not start:\n' + out)); }, 5000);
    const onData = (d) => {
      out += d;
      const m = /localhost:(\d+)/.exec(out);
      if (m) { clearTimeout(timer); resolve({ child, port: Number(m[1]) }); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}):\n${out}`)); });
  });
}

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
    }).on('error', reject);
  });
}

async function withServer(env, fn) {
  const { child, port } = await startServer(env);
  child.removeAllListeners('exit');
  try { await fn(port, child); } finally { child.kill(); }
}

test('server boots, serves the page, and /api/people returns the array', () => withServer({}, async (port) => {
  const api = await get(port, '/api/people');
  assert.strictEqual(api.status, 200);
  assert.match(api.type, /application\/json/);
  const list = JSON.parse(api.body);
  assert(Array.isArray(list));
  assert.strictEqual(list.length, people.length);

  const page = await get(port, '/');
  assert.strictEqual(page.status, 200);
  assert.match(page.body, /MOCK DATA/);
  assert.strictEqual((await get(port, '/family.js')).status, 200);
  assert.strictEqual((await get(port, '/nope.txt')).status, 404);
  const escape = await get(port, '/..%2fdata%2fpeople.json');
  assert([403, 404].includes(escape.status), `path traversal should be blocked, got ${escape.status}`);
}));

test('malformed people.json yields a JSON error, and the server stays up', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bft-'));
  const badFile = path.join(tmp, 'people.json');
  fs.writeFileSync(badFile, '[ { "id": "oops", } ');
  try {
    await withServer({ DATA_FILE: badFile }, async (port, child) => {
      const res = await get(port, '/api/people');
      assert.strictEqual(res.status, 500);
      assert.match(JSON.parse(res.body).error, /not valid JSON/);
      // Fixing the file must work without a restart.
      fs.writeFileSync(badFile, '[]');
      const fixed = await get(port, '/api/people');
      assert.strictEqual(fixed.status, 200);
      assert.strictEqual(child.exitCode, null, 'server must still be running');
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ runner

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ok    ${t.name}`);
    } catch (e) {
      failed++;
      console.log(`  FAIL  ${t.name}\n        ${String(e.message).split('\n').join('\n        ')}`);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
