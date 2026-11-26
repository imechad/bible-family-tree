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
  // An EMPTY array is valid during the verse-by-verse walk: Genesis 1 names no
  // people, so the file stays [] until the first named person (Genesis 2).
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
    assert(['male', 'female', 'unknown'].includes(p.gender), `${p.id}: gender must be male|female|unknown, got ${JSON.stringify(p.gender)}`);
    assert((Number.isInteger(p.generation) && p.generation > 0) || p.generation === 'unknown', `${p.id}: generation must be a positive int or "unknown", got ${JSON.stringify(p.generation)}`);
    assert(p.age === null || p.age === "unknown" || (typeof p.age === 'number' && p.age >= 0), `${p.id}: age must be null, "unknown", or a non-negative number`);
    assert('mom' in p && 'dad' in p, `${p.id}: mom and dad keys are required (use "unknown" or "none" when appropriate)`);
    assert(Array.isArray(p.notes), `${p.id}: notes must be an array (use [] for none)`);
    assert(Array.isArray(p.spouses), `${p.id}: spouses must be an array of ids (use [] for none)`);
    for (const k of ['children', 'siblings']) {
      assert(!(k in p), `${p.id}: "${k}" must not be stored — it is derived from mom/dad`);
    }
  }
});

test('mom/dad references point to existing people of the right gender', () => {
  const byId = new Map(people.map((p) => [p.id, p]));
  for (const p of people) {
    for (const [role, gender] of [['mom', 'female'], ['dad', 'male']]) {
      if (p[role] === null || p[role] === "unknown" || p[role] === "none") continue;
      const parent = byId.get(p[role]);
      assert(parent, `${p.id}.${role} -> "${p[role]}" does not exist`);
      assert.notStrictEqual(parent.id, p.id, `${p.id} is their own ${role}`);
      if (parent.gender !== 'unknown') {
        assert.strictEqual(parent.gender, gender, `${p.id}.${role} -> "${parent.id}" should be ${gender}`);
      }
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
      // "none"/"unknown" are absent-parent markers, not person ids — skip them
      if (p[role] && p[role] !== 'none' && p[role] !== 'unknown')
        assert(idx.childrenOf.get(p[role]).includes(p.id), `${p.id} missing from ${p[role]}'s children`);
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
      const share = ((a.mom && a.mom !== "unknown" && a.mom !== "none" && a.mom === b.mom) || 
                   (a.dad && a.dad !== "unknown" && a.dad !== "none" && a.dad === b.dad));
      const listed = idx.siblingsOf.get(a.id).some((s) => s.id === b.id);
      assert.strictEqual(!!share, listed, `${a.id}/${b.id}: share parent=${!!share} but listed=${listed}`);
    }
  }
});

test('spouse links exist, are mutual, and pair a female with a male', () => {
  const byId = new Map(people.map((p) => [p.id, p]));
  for (const p of people) {
    assert.strictEqual(new Set(p.spouses).size, p.spouses.length, `${p.id}: duplicate spouse id`);
    for (const sid of p.spouses) {
      const s = byId.get(sid);
      assert(s, `${p.id}.spouses -> "${sid}" does not exist`);
      assert.notStrictEqual(sid, p.id, `${p.id} is their own spouse`);
      assert(s.spouses.includes(p.id), `${p.id} lists ${sid} as spouse but ${sid} does not list ${p.id}`);
      if (s.gender !== 'unknown' && p.gender !== 'unknown') {
        assert.notStrictEqual(s.gender, p.gender, `${p.id} and ${sid} are both ${p.gender}`);
      }
    }
  }
});

test('empty data is valid: an empty array flows through validate, index and unions', () => {
  assert.deepStrictEqual(Family.validate([]), []);
  const idx = Family.buildIndex([]);
  assert.strictEqual(idx.byId.size, 0, 'byId empty');
  assert.strictEqual(idx.byName.size, 0, 'byName empty');
  assert.deepStrictEqual(Family.deriveUnions(idx).unions, [], 'no unions');
  // The real data file held zero people through Genesis 1; from Genesis 2 on it
  // holds walked people (Adam first). Whatever it holds, it must validate clean:
  // Family.validate returns [] when there are no problems, and the server smoke
  // test below proves /api/people serves the file as-is.
  assert.deepStrictEqual(Family.validate(people), [], 'live people.json validates clean');
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
    'unrecognised ref "Hezekiah 1:1"', 'not in its refs', '"g" has no name', 'gender must be', 'positive integer or "unknown"']) {
    assert(problems.includes(needle), `expected a problem mentioning "${needle}" in:\n${problems}`);
  }
});

test('validate enforces spouse symmetry, existence, and gender pairing', () => {
  const base = (id, gender, spouses) => ({ id, name: id, gender, generation: 1, age: null, mom: null, dad: null, spouses, notes: [], firstMention: 'Genesis 4:17' });
  const ok = [base('a', 'male', ['b']), base('b', 'female', ['a'])];
  assert.deepStrictEqual(Family.validate(ok), []);
  // No spouses key at all is tolerated by the UI validator (the data test
  // above is what insists the key is present in the real file).
  assert.deepStrictEqual(Family.validate([base('solo', 'male', undefined)]), []);

  const problems = Family.validate([
    base('h', 'male', ['w', 'ghost', 'h']), // w doesn't list h back; ghost unknown; self
    base('w', 'female', []),
    base('m1', 'male', ['m2']), base('m2', 'male', ['m1']), // same gender
    base('d', 'female', ['m3', 'm3']), base('m3', 'male', ['d']), // duplicate
    base('n', 'female', 'm3') // not an array
  ]).join('\n');
  for (const needle of ['"h" lists spouse "w" but "w" does not list "h" back', 'h.spouses points to unknown id "ghost"',
    'h lists themself as a spouse', 'both male', 'lists spouse "m3" twice', '"n" spouses must be an array']) {
    assert(problems.includes(needle), `expected a problem mentioning "${needle}" in:\n${problems}`);
  }
  // The index still treats a one-sided marriage as a marriage, so the UI
  // shows it while the warning banner flags it.
  const idx = Family.buildIndex([base('h', 'male', ['w']), base('w', 'female', [])]);
  assert.deepStrictEqual(idx.spousesOf.get('w'), ['h']);
});

test('unions: couple, single parent, childless couple, remarriage', () => {
  const P = (id, gender, extra) => Object.assign({ id, name: id, gender, generation: 1, mom: null, dad: null, spouses: [], notes: [] }, extra);
  const people = [
    P('dad', 'male', { spouses: ['wife1', 'wife2'] }),
    P('wife1', 'female', { spouses: ['dad'] }),
    P('wife2', 'female', { spouses: ['dad'] }),
    P('k1', 'female', { generation: 2, mom: 'wife1', dad: 'dad' }),
    P('k2', 'male', { generation: 2, mom: 'wife1', dad: 'dad' }),
    P('k3', 'male', { generation: 2, mom: 'wife2', dad: 'dad', spouses: ['bride'] }),
    P('bride', 'female', { generation: 2, spouses: ['k3'] }),
    P('k4', 'female', { generation: 2, mom: 'wife2', dad: null }),
    P('g1', 'male', { generation: 3, mom: 'k4', dad: null })
  ];
  const idx = Family.buildIndex(people);
  const fb = Family.deriveUnions(idx);
  const view = fb.unions.map((b) => `${b.mom}+${b.dad}:${b.children.join(',')}`);
  assert.deepStrictEqual(view, [
    'wife1+dad:k1,k2', // spousal unions first, in the order dad lists them...
    'wife2+dad:k3',
    'bride+k3:', //       ...a married couple with no children is still a union (junction, no child lines)
    'wife2+null:k4', //   wife2 also had a child with no recorded father: her own single-parent union
    'k4+null:g1' //       single parent
  ]);
  // The remarried father is in two unions (two junctions), always in the dad (right) slot.
  assert.deepStrictEqual(fb.unionsOf.get('dad').map((b) => b.key), ['wife1|dad', 'wife2|dad']);
  assert(fb.unionsOf.get('dad').every((b) => b.dad === 'dad'));
  assert.deepStrictEqual(fb.unionsOf.get('wife2').map((b) => b.key), ['wife2|dad', 'wife2|']);
  // Each child descends from exactly one union (one junction).
  for (const p of people) {
    const owners = fb.unions.filter((b) => b.children.includes(p.id));
    assert.strictEqual(owners.length, p.mom || p.dad ? 1 : 0, `${p.id} should hang from exactly one union`);
  }
  // Excluding a parent (e.g. no usable generation) turns them into "unrecorded".
  const noDad = Family.deriveUnions(idx, (id) => id !== 'dad');
  assert(noDad.byKey.has('wife1|') && noDad.byKey.get('wife1|').children.join() === 'k1,k2');
  assert(!noDad.unionsOf.has('dad'));
});

test('unions over the real data: mom is female, dad is male, every child has one union', () => {
  const idx = Family.buildIndex(people);
  const fb = Family.deriveUnions(idx);
  for (const b of fb.unions) {
    if (b.mom) assert.strictEqual(idx.byId.get(b.mom).gender, 'female', `${b.key}: mom slot holds a non-female`);
    if (b.dad) assert.strictEqual(idx.byId.get(b.dad).gender, 'male', `${b.key}: dad slot holds a non-male`);
  }
  for (const p of people) {
    const n = fb.unions.filter((b) => b.children.includes(p.id)).length;
    const hasParents = (p.mom && p.mom !== 'none' && p.mom !== 'unknown') ||
                       (p.dad && p.dad !== 'none' && p.dad !== 'unknown');
    assert.strictEqual(n, hasParents ? 1 : 0, `${p.id} hangs from ${n} unions`);
  }
  // Every recorded marriage shows up as a union.
  for (const p of people) {
    for (const sid of p.spouses) {
      const [mom, dad] = p.gender === 'female' ? [p.id, sid] : [sid, p.id];
      assert(fb.byKey.has(`${mom}|${dad}`), `marriage ${p.id}+${sid} has no union`);
    }
  }
});

test('junction geometry: gender-tagged parent lines meet one pill, children fan out from it', () => {
  const opts = { drop: 50, pillW: 14, pillH: 30 };
  // Couple with four kids (the reference drawing): mom left, dad right.
  const g = Family.junctionGeometry(
    { mom: { x: 100, y: 62 }, dad: { x: 400, y: 62 } },
    [{ id: 'a', x: 0, y: 212 }, { id: 'b', x: 150, y: 212 }, { id: 'c', x: 350, y: 212 }, { id: 'd', x: 500, y: 212 }],
    opts);
  assert.deepStrictEqual(g.junction, { x: 243, y: 112, w: 14, h: 30, cx: 250 }, 'pill sits midway between the parents, below them');
  assert.deepStrictEqual(g.lines.map((l) => l.kind), ['mom', 'dad', 'child', 'child', 'child', 'child']);
  const mom = g.lines[0], dad = g.lines[1];
  assert.deepStrictEqual([mom.x1, mom.y1, dad.x1, dad.y1], [100, 62, 400, 62], 'parent lines start at the bottom of each card');
  assert(mom.x2 === 250 && dad.x2 === 250 && mom.y2 === dad.y2, 'both parent lines end at the same point on the pill');
  const kids = g.lines.filter((l) => l.kind === 'child');
  assert(kids.every((l) => l.x1 === 250 && l.y1 === kids[0].y1 && l.y1 > mom.y2), 'every child line leaves the same pill, from below the parent lines');
  assert.deepStrictEqual(kids.map((l) => [l.id, l.x2, l.y2]), [['a', 0, 212], ['b', 150, 212], ['c', 350, 212], ['d', 500, 212]]);

  // Single parent: the pill sits straight below them, with one coloured line.
  const single = Family.junctionGeometry({ mom: null, dad: { x: 90, y: 62 } }, [{ id: 'k', x: 90, y: 212 }], opts);
  assert.strictEqual(single.junction.cx, 90);
  assert.deepStrictEqual(single.lines.map((l) => l.kind), ['dad', 'child']);

  // Childless couple: the pill (the marriage) stays, but no child lines.
  const childless = Family.junctionGeometry({ mom: { x: 90, y: 62 }, dad: { x: 314, y: 62 } }, [], opts);
  assert(childless.junction, 'a married couple without children still gets a junction');
  assert.deepStrictEqual(childless.lines.map((l) => l.kind), ['mom', 'dad']);

  // No placeable parent: nothing to draw.
  assert.strictEqual(Family.junctionGeometry({ mom: null, dad: null }, [], opts), null);
});

test('search finds parents by a kid\'s name, kids by a parent\'s name, and says why', () => {
  const idx = Family.buildIndex(DEMO);
  const names = (q) => Family.search(DEMO, idx, q).map((r) => r.person.id);
  const why = (q, id) => Family.search(DEMO, idx, q).find((r) => r.person.id === id).reasons.map((r) => r.label);

  // "Who's got the kid named Briar?" -> Pim, tagged with why.
  assert.deepStrictEqual(names('kid:Briar'), ['pim-vell']);
  assert.deepStrictEqual(why('kid:Briar', 'pim-vell'), ['kid: Briar Vell']);
  // Free text: Lisska herself first, then her parents, siblings, and kids.
  const lisska = names('lisska');
  assert.strictEqual(lisska[0], 'lisska-arlo');
  for (const id of ['wrenna-vell', 'fenwick-arlo', 'dovrin-arlo', 'hale-arlo', 'kestrel-arlo', 'thistle-arlo']) {
    assert(lisska.includes(id), `"lisska" should find ${id}`);
  }
  assert(why('lisska', 'fenwick-arlo').includes('kid: Lisska Arlo'));
  assert(why('lisska', 'kestrel-arlo').includes('mom: Lisska Arlo'));
  assert(why('lisska', 'dovrin-arlo').includes('sibling: Lisska Arlo'));
  assert.deepStrictEqual(why('lisska', 'lisska-arlo'), ['name']);
  // Reverse direction via prefixes.
  assert.deepStrictEqual(names('mom:Lisska'), ['kestrel-arlo', 'thistle-arlo']);
  assert.deepStrictEqual(names('dad:pim'), ['briar-vell']);
  assert.deepStrictEqual(names('spouse:taddeo').sort(), ['cassia-holloway', 'odile-fairbairn']);
  assert(names('sibling:sorrel').includes('brisk-vell'));
});

test('search: comma lists match ANY term; prefixes carry over; attributes and notes', () => {
  const idx = Family.buildIndex(DEMO);
  const names = (q) => Family.search(DEMO, idx, q).map((r) => r.person.id);

  // A list after one prefix stays in that role.
  assert.deepStrictEqual(names('kid:Briar, Wick').sort(), ['pim-vell', 'thistle-arlo']);
  assert.deepStrictEqual(Family.parseQuery('kid:Briar, Wick, mom: Lisska, Genesis 4:25,'), [
    { field: 'kid', raw: 'Briar', value: 'briar' }, { field: 'kid', raw: 'Wick', value: 'wick' },
    { field: 'mom', raw: 'Lisska', value: 'lisska' }, { field: 'mom', raw: 'Genesis 4:25', value: 'genesis 4:25' }
  ]);
  // Unknown words before a colon are not prefixes (scripture refs stay free text).
  assert.deepStrictEqual(Family.parseQuery('Genesis 4:25'), [{ field: 'any', raw: 'Genesis 4:25', value: 'genesis 4:25' }]);

  // Free-text list: every listed name and its relatives; own-name hits first.
  const list = Family.search(DEMO, idx, 'Briar, Wick');
  assert.deepStrictEqual(list.slice(0, 2).map((r) => r.person.id).sort(), ['briar-vell', 'wick-arlo']);
  assert(list.some((r) => r.person.id === 'pim-vell' && r.reasons.some((x) => x.label === 'kid: Briar Vell' && x.term === 'Briar')));
  // "wick" inside "Fenwick" still finds Fenwick by name (substring, as before)
  // but ranks after real hits and does NOT drag in all of Fenwick's relatives.
  const wick = names('wick');
  assert.deepStrictEqual(wick, ['wick-arlo', 'thistle-arlo', 'fenwick-arlo']);

  // Attributes.
  assert(names('gen:3').every((id) => idx.byId.get(id).generation === 3));
  assert(names('3').every((id) => idx.byId.get(id).generation === 3 || idx.byId.get(id).age === 3));
  assert(names('gender:f').length && names('gender:f').every((id) => idx.byId.get(id).gender === 'female'));
  assert(names('male').every((id) => idx.byId.get(id).gender === 'male'), '"male" must not match "female"');
  assert.deepStrictEqual(names('age:96'), ['garrow-vell']);
  assert(names('age:60-70').every((id) => idx.byId.get(id).age >= 60 && idx.byId.get(id).age <= 70));
  // Notes text (word-start), with a snippet in the reason.
  const orchard = Family.search(DEMO, idx, 'orchard');
  assert(orchard.some((r) => r.person.id === 'garrow-vell'));
  assert(orchard.every((r) => r.reasons[0].field === 'notes' && r.reasons[0].label.includes('orchard')));

  // Empty query: everyone, no reasons, generation order.
  const all = Family.search(DEMO, idx, '  , ');
  assert.strictEqual(all.length, DEMO.length);
  const rank = (r) => Family.generationRank(r.person.generation);
  assert(all.every((r, i) => !r.reasons.length && (i === 0 || rank(all[i - 1]) <= rank(r))));
  assert.strictEqual(all[all.length - 1].person.id, 'unknown-cousin', 'unknown generation sorts last');
});

test('filters: age range bounds, blank = unbounded, unknown ages excluded, bounds applied as typed', () => {
  const idx = Family.buildIndex(DEMO);
  const ids = (f) => Family.filterSearch(DEMO, idx, '', Object.assign(Family.emptyFilters(), f)).map((r) => r.person.id);
  const age = (id) => idx.byId.get(id).age;

  // No filters: everyone, including DEMO with no recorded age.
  assert.strictEqual(ids({}).length, DEMO.length);
  // Both ends inclusive.
  const range = ids({ ageMin: '60', ageMax: '70' });
  assert(range.length && range.every((id) => age(id) >= 60 && age(id) <= 70));
  assert(range.includes('tessaly-vell') && range.includes('ebbet-vell') === false, '70 is in, 71 is out');
  assert(range.includes('lisska-arlo') && range.includes('dovrin-arlo'));
  // One end only.
  // Adam (930) and Seth (912) are the real Genesis seed DEMO.
  assert.deepStrictEqual(ids({ ageMin: '90' }).sort(), ['adam', 'garrow-vell', 'isoline-ashby', 'seth']);
  assert.deepStrictEqual(ids({ ageMax: '9' }).sort(), ['briar-vell', 'wick-arlo']);
  // Numbers work as well as the strings an <input> yields.
  assert.deepStrictEqual(ids({ ageMin: 90 }).sort(), ['adam', 'garrow-vell', 'isoline-ashby', 'seth']);
  assert.deepStrictEqual(ids({ ageMin: '90', ageMax: '100' }).sort(), ['garrow-vell', 'isoline-ashby']);
  // Unknown age can't be shown to be in range.
  assert(!ids({ ageMin: '0' }).includes('pell-vell') && !ids({ ageMin: '0' }).includes('hale-arlo'));
  assert.strictEqual(ids({ ageMin: '0' }).length, DEMO.filter((p) => typeof p.age === 'number').length);
  // Bounds are applied as typed (min above max matches nobody, not a swapped range).
  assert.deepStrictEqual(ids({ ageMin: '70', ageMax: '60' }), []);
  // Junk / half-typed input counts as no bound.
  assert.strictEqual(ids({ ageMin: '-', ageMax: '' }).length, DEMO.length);
  // A range nobody is in yields nothing (the UI shows its empty state).
  assert.deepStrictEqual(ids({ ageMin: '1000' }), []);
});

test('filters: has notes / has children / has spouse match the derived data', () => {
  const idx = Family.buildIndex(DEMO);
  const ids = (f) => Family.filterSearch(DEMO, idx, '', Object.assign(Family.emptyFilters(), f)).map((r) => r.person.id).sort();
  const expect = (pred) => DEMO.filter(pred).map((p) => p.id).sort();

  assert.deepStrictEqual(ids({ hasNotes: true }), expect((p) => Family.noteViews(p).length > 0));
  assert(ids({ hasNotes: true }).includes('taddeo-vell') && !ids({ hasNotes: true }).includes('maelis-dunhart'));

  // Children are derived (never stored), so the filter must use the index.
  assert.deepStrictEqual(ids({ hasChildren: true }), expect((p) => idx.childrenOf.get(p.id).length > 0));
  assert(ids({ hasChildren: true }).includes('pell-vell'), 'a single parent has children');
  assert(!ids({ hasChildren: true }).includes('corwin-vell'), 'the childless couple has none');

  assert.deepStrictEqual(ids({ hasSpouse: true }), expect((p) => idx.spousesOf.get(p.id).length > 0));
  assert(ids({ hasSpouse: true }).includes('corwin-vell') && !ids({ hasSpouse: true }).includes('pell-vell'));

  // A spouse recorded on only one side still counts for both (as the tree draws it).
  const oneSided = [
    { id: 'a', name: 'A', gender: 'female', generation: 1, age: null, mom: null, dad: null, spouses: ['b'], notes: [] },
    { id: 'b', name: 'B', gender: 'male', generation: 1, age: null, mom: null, dad: null, spouses: [], notes: [{ text: 'x', refs: ['Genesis 1:1'] }] }
  ];
  const oIdx = Family.buildIndex(oneSided);
  assert.deepStrictEqual(Family.filterSearch(oneSided, oIdx, '', { hasSpouse: true }).map((r) => r.person.id), ['a', 'b']);
  assert.deepStrictEqual(Family.filterSearch(oneSided, oIdx, '', { hasNotes: true }).map((r) => r.person.id), ['b']);
});

test('filters combine with each other (AND) and with text search; badge count', () => {
  const idx = Family.buildIndex(DEMO);
  const F = (f) => Object.assign(Family.emptyFilters(), f);
  const ids = (q, f) => Family.filterSearch(DEMO, idx, q, F(f)).map((r) => r.person.id);

  // Every filter at once: gen 4 women aged 70+ with notes, children and a spouse.
  assert.deepStrictEqual(ids('', { gen: '4', gender: 'female', ageMin: '70', hasNotes: true, hasChildren: true, hasSpouse: true }), ['wrenna-vell']);
  // Gen + gender, exactly as the old dropdowns behaved.
  const g4f = ids('', { gen: '4', gender: 'female' });
  assert(g4f.length && g4f.every((id) => idx.byId.get(id).generation === 4 && idx.byId.get(id).gender === 'female'));
  // AND, not OR: adding a filter can only shrink the set.
  const kids = ids('', { hasChildren: true });
  const kidsAndSpouse = ids('', { hasChildren: true, hasSpouse: true });
  assert(kidsAndSpouse.length < kids.length && kidsAndSpouse.every((id) => kids.includes(id)));
  assert(!kidsAndSpouse.includes('pell-vell') && !kidsAndSpouse.includes('corwin-vell'));

  // Search keeps its order and match reasons; filters only drop DEMO.
  const plain = Family.search(DEMO, idx, 'Briar, Wick');
  const filtered = Family.filterSearch(DEMO, idx, 'Briar, Wick', F({ hasNotes: true }));
  assert.deepStrictEqual(filtered.map((r) => r.person.id), plain.filter((r) => Family.noteViews(r.person).length).map((r) => r.person.id));
  assert(filtered.find((r) => r.person.id === 'briar-vell').reasons.some((x) => x.field === 'name'));
  // A prefix search narrowed by a filter: Briar's parents who are male.
  assert.deepStrictEqual(ids('kid:Briar', { gender: 'male' }), ['pim-vell']);
  assert.deepStrictEqual(ids('kid:Briar', { gender: 'female' }), []);

  // Badge: one per active filter; the age range counts once.
  assert.strictEqual(Family.activeFilterCount(Family.emptyFilters()), 0);
  assert.strictEqual(Family.activeFilterCount(F({ gen: '3' })), 1);
  assert.strictEqual(Family.activeFilterCount(F({ ageMin: '10', ageMax: '20' })), 1);
  assert.strictEqual(Family.activeFilterCount(F({ ageMax: '20' })), 1);
  assert.strictEqual(Family.activeFilterCount(F({ ageMin: '-' })), 0, 'junk age is not an active filter');
  assert.strictEqual(Family.activeFilterCount(F({ gen: '2', gender: 'male', ageMin: '1', hasNotes: true, hasChildren: true, hasSpouse: true })), 6);
});

test('multi-note people: each note keeps its own text, quotes, and linked refs', () => {
  const views = Family.noteViews({
    notes: [
      { text: 'First, see Genesis 1:1.', quotes: [{ ref: 'Genesis 1:1', text: 'In the beginning…' }], refs: ['Genesis 1:1'] },
      null, // malformed entries are skipped rather than breaking the panel
      { text: 'Second.', refs: ['Genesis 2:15', 'Genesis 8:22'] },
      { text: 'Third.', quotes: [{ ref: 'Genesis 9:13', text: 'I do set my bow…' }], refs: ['Genesis 9:13'] }
    ]
  });
  assert.deepStrictEqual(views.map((v) => `${v.number}/${v.total}`), ['1/3', '2/3', '3/3']);
  assert.deepStrictEqual(views.map((v) => v.refs.map((r) => r.ref)), [['Genesis 1:1'], ['Genesis 2:15', 'Genesis 8:22'], ['Genesis 9:13']]);
  assert.deepStrictEqual(views.map((v) => v.quotes.map((q) => q.ref)), [['Genesis 1:1'], [], ['Genesis 9:13']]);
  assert.strictEqual(views[2].quotes[0].url, Family.bibleUrl('Genesis 9:13'));
  assert.strictEqual(views[1].refs[1].url, 'https://www.biblegateway.com/passage/?search=Genesis%208%3A22&version=KJV');
  // Inline refs in the commentary are linked per note.
  assert.deepStrictEqual(views[0].segments.filter((s) => s.type === 'ref').map((s) => s.url), [Family.bibleUrl('Genesis 1:1')]);
  assert.deepStrictEqual(Family.noteViews({ notes: [] }), []);
  assert.deepStrictEqual(Family.noteViews({}), []);

  // And in the retired demo family, a multi-note person gets one view per stored note.
  const taddeo = DEMO.find((p) => p.id === 'taddeo-vell');
  assert.strictEqual(Family.noteViews(taddeo).length, taddeo.notes.length);
  assert(taddeo.notes.length >= 2);
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


// ------------------------------------------------------------------ new explicit state tests

test('new explicit unknown/none states are accepted', () => {
  for (const p of people) {
    // Check mom/dad states
    assert(['string', 'null'].includes(typeof p.mom) || p.mom === undefined, `${p.id}: mom must be string, null, or undefined`);
    assert(['string', 'null'].includes(typeof p.dad) || p.dad === undefined, `${p.id}: dad must be string, null, or undefined`);
    if (typeof p.mom === 'string') {
      assert(['unknown', 'none'].includes(p.mom) || people.some(op => op.id === p.mom), 
             `${p.id}: mom "${p.mom}" must be "unknown", "none", or a valid person id`);
    }
    if (typeof p.dad === 'string') {
      assert(['unknown', 'none'].includes(p.dad) || people.some(op => op.id === p.dad), 
             `${p.id}: dad "${p.dad}" must be "unknown", "none", or a valid person id`);
    }
    
    // Check age state
    assert(p.age === null || p.age === "unknown" || (typeof p.age === 'number' && p.age >= 0), 
           `${p.id}: age must be null, "unknown", or non-negative number`);
    
    // Check gender state
    assert(['male', 'female', 'unknown'].includes(p.gender), 
           `${p.id}: gender must be "male", "female", or "unknown"`);
    
    // Check list states
    // Absent = "known" (the validator's documented default); the Genesis
    // seed only writes the states scripture leaves open.
    assert(p.childrenState === undefined || ['known', 'none', 'unknown'].includes(p.childrenState), 
           `${p.id}: childrenState must be "known", "none", or "unknown"`);
    // Absent = "known" (the validator's documented default); the Genesis
    // seed only writes the states scripture leaves open.
    assert(p.spousesState === undefined || ['known', 'none', 'unknown'].includes(p.spousesState), 
           `${p.id}: spousesState must be "known", "none", or "unknown"`);
    // Absent = "known" (the validator's documented default); the Genesis
    // seed only writes the states scripture leaves open.
    assert(p.siblingsState === undefined || ['known', 'none', 'unknown'].includes(p.siblingsState), 
           `${p.id}: siblingsState must be "known", "none", or "unknown"`);
  }
});

test('Family.validate accepts the new states', () => {
  const problems = Family.validate(people);
  assert.deepStrictEqual(problems, [], `Family.validate should pass but found: ${JSON.stringify(problems)}`);
});

test('buildIndex handles unknown/none states correctly', () => {
  const idx = Family.buildIndex(people);
  assert.deepStrictEqual(idx.problems, [], `buildIndex problems: ${JSON.stringify(idx.problems)}`);
  
  // Check that people with "none" parents don't create child relationships
  // Absent-parent markers are never person ids: they must not appear as
  // childrenOf keys or as derived child ids anywhere in the graph.
  for (const marker of ["none", "unknown"]) {
    assert.strictEqual(idx.childrenOf.has(marker), false, `"${marker}" must not be a childrenOf key`);
    for (const kids of idx.childrenOf.values()) {
      assert(!kids.includes(marker), `"${marker}" must not appear as a derived child id`);
    }
  }
});

// Test invalid combinations that should be rejected
test('invalid state combinations are rejected', () => {
  // Create a test person with invalid state
  const testPerson = {
    id: "test-invalid",
    name: "Test Invalid",
    gender: "male",
    generation: 10,
    age: 30,
    mom: "none",
    dad: "unknown",
    spouses: [],
    notes: [],
    childrenState: "none",
    spousesState: "known",
    siblingsState: "known"
  };
  
  // Add a child that points to this person (should conflict with childrenState="none")
  const testChild = {
    id: "test-child",
    name: "Test Child", 
    gender: "male",
    generation: 11,
    age: 5,
    mom: "test-invalid",
    dad: "unknown",
    spouses: [],
    notes: [],
    childrenState: "known",
    spousesState: "known",
    siblingsState: "known"
  };
  
  const testPeople = [...people, testPerson, testChild];
  const problems = Family.validate(testPeople);
  
  // Should detect the inconsistency
  assert(problems.some(p => p.includes('childrenState="none" but is listed as a parent')), 
         'Should detect childrenState="none" inconsistency');
  
  // Should detect invalid list state values
  const invalidStatePerson = {
    id: "test-invalid-state",
    name: "Test Invalid State",
    gender: "male", 
    generation: 10,
    age: 30,
    mom: "unknown",
    dad: "unknown",
    spouses: [],
    notes: [],
    childrenState: "invalid",
    spousesState: "known",
    siblingsState: "known"
  };
  
  const problems2 = Family.validate([...people, invalidStatePerson]);
  assert(problems2.some(p => p.includes('childrenState must be "known", "none", or "unknown"')), 
         'Should detect invalid list state value');
});

// DEMO: the retired phase-1 family (34 Vells + the Genesis seed), recovered from git
// history so the search/filter ENGINE tests keep running against the exact data
// they were written for. data/people.json itself stays empty during the walk.
const DEMO = [{"id":"garrow-vell","name":"Garrow Vell","firstMention":"Genesis 4:17","gender":"male","generation":1,"age":96,"mom":"none","dad":"none","spouses":["isoline-ashby"],"notes":[{"text":"DEMO NOTE: In this invented family saga, Garrow is the founder of the Vell house and is said to have planted the first orchard on the hill farm. The verse below is attached only to show how a quoted citation renders.","quotes":[{"ref":"Genesis 1:11","text":"And God said, Let the earth bring forth grass, the herb yielding seed, and the fruit tree yielding fruit after his kind, whose seed is in itself, upon the earth: and it was so."}],"refs":["Genesis 1:11"]},{"text":"DEMO NOTE: A second note with two references and no quote, to show a note can cite several passages (compare Genesis 2:15 with Genesis 8:22).","refs":["Genesis 2:15","Genesis 8:22"]}],"childrenState":"known","spousesState":"known","siblingsState":"known"},{"id":"isoline-ashby","name":"Isoline Ashby","firstMention":"Genesis 4:18","gender":"female","generation":1,"age":91,"mom":"none","dad":"none","spouses":["garrow-vell"],"notes":[{"text":"DEMO NOTE: Fictional matriarch of the demo family. The made-up story says she kept the household ledger and named every grandchild.","quotes":[{"ref":"Genesis 1:28","text":"And God blessed them, and God said unto them, Be fruitful, and multiply, and replenish the earth, and subdue it: and have dominion over the fish of the sea, and over the fowl of the air, and over every living thing that moveth upon the earth."}],"refs":["Genesis 1:28"]}],"childrenState":"known","spousesState":"known","siblingsState":"known"},{"id":"bram-vell","name":"Bram Vell","firstMention":"Genesis 4:19","gender":"male","generation":2,"age":78,"mom":"isoline-ashby","dad":"garrow-vell","spouses":["maelis-dunhart"],"notes":[{"text":"DEMO NOTE: Eldest son in the mock dynasty. This note shows a verse range citation.","quotes":[{"ref":"Genesis 2:24","text":"Therefore shall a man leave his father and his mother, and shall cleave unto his wife: and they shall be one flesh."}],"refs":["Genesis 2:24","Genesis 2:18-25"]}],"childrenState":"known","spousesState":"known","siblingsState":"known"},{"id":"maelis-dunhart","name":"Maelis Dunhart","firstMention":"Genesis 4:20","gender":"female","generation":2,"age":82,"mom":"unknown","dad":"unknown","spouses":["bram-vell"],"notes":[],"childrenState":"known","spousesState":"known","siblingsState":"known"},{"id":"tessaly-vell","name":"Tessaly Vell","firstMention":"Genesis 4:21","gender":"female","generation":2,"age":70,"mom":"isoline-ashby","dad":"garrow-vell","spouses":[],"notes":[{"text":"DEMO NOTE: In the invented story Tessaly raised her daughter alone after leaving for the coast. The father is deliberately left unrecorded to demo an empty Dad field.","refs":["Genesis 1:3"]}],"childrenState":"known","spousesState":"none","siblingsState":"known"},{"id":"corwin-vell","name":"Corwin Vell","firstMention":"Genesis 4:22","gender":"male","generation":2,"age":66,"mom":"isoline-ashby","dad":"garrow-vell","spouses":["liesl-thorne"],"notes":[{"text":"DEMO NOTE: Married to Liesl Thorne but childless in the demo data, to show an empty Children field and a couple block with no child lines. The made-up tale says he spent his life mapping the night sky.","quotes":[{"ref":"Genesis 1:16","text":"And God made two great lights; the greater light to rule the day, and the lesser light to rule the night: he made the stars also."}],"refs":["Genesis 1:16"]}],"childrenState":"none","spousesState":"known","siblingsState":"known"},{"id":"liesl-thorne","name":"Liesl Thorne","firstMention":"Genesis 4:23","gender":"female","generation":2,"age":64,"mom":"unknown","dad":"unknown","spouses":["corwin-vell"],"notes":[{"text":"DEMO NOTE: Married into the mock family and childless, so her block with Corwin shows a marriage with no child lines.","quotes":[{"ref":"Genesis 2:18","text":"And the LORD God said, It is not good that the man should be alone; I will make him an help meet for him."}],"refs":["Genesis 2:18"]}],"childrenState":"unknown","spousesState":"known","siblingsState":"known"},{"id":"ebbet-vell","name":"Ebbet Vell","firstMention":"Genesis 5:3","gender":"male","generation":3,"age":71,"mom":"maelis-dunhart","dad":"bram-vell","spouses":["ysolde-marrick"],"notes":[],"childrenState":"known","spousesState":"known","siblingsState":"known"},{"id":"ysolde-marrick","name":"Ysolde Marrick","firstMention":"Genesis 5:6","gender":"female","generation":3,"age":69,"mom":"unknown","dad":"unknown","spouses":["ebbet-vell"],"notes":[],"childrenState":"known","spousesState":"known","siblingsState":"known"},{"id":"nyra-vell","name":"Nyra Vell","firstMention":"Genesis 5:9","gender":"female","generation":3,"age":64,"mom":"maelis-dunhart","dad":"bram-vell","spouses":[],"notes":[],"childrenState":"known","spousesState":"unknown","siblingsState":"known"},{"id":"pell-vell","name":"Pell Vell","firstMention":"Genesis 5:12","gender":"male","generation":3,"age":"unknown","mom":"maelis-dunhart","dad":"bram-vell","spouses":[],"notes":[],"childrenState":"known","spousesState":"known","siblingsState":"known"},{"id":"quillon-vell","name":"Quillon Vell","firstMention":"Genesis 5:15","gender":"male","generation":3,"age":39,"mom":"maelis-dunhart","dad":"bram-vell","spouses":[],"notes":[],"childrenState":"known","spousesState":"known","siblingsState":"known"},{"id":"rowen-vell","name":"Rowen Vell","firstMention":"Genesis 5:18","gender":"female","generation":3,"age":58,"mom":"tessaly-vell","dad":"unknown","spouses":[],"notes":[{"text":"DEMO NOTE: Only child of a single mother in the mock data. Her son is also listed with no recorded father, so the pattern repeats two generations running.","refs":["Genesis 1:31"]}],"childrenState":"known","spousesState":"known","siblingsState":"known"},{"id":"taddeo-vell","name":"Taddeo Vell","firstMention":"Genesis 6:9","gender":"male","generation":4,"age":80,"mom":"ysolde-marrick","dad":"ebbet-vell","spouses":["cassia-holloway","odile-fairbairn"],"notes":[{"text":"DEMO NOTE: The invented story says Taddeo married Cassia Holloway young; Brisk and Sorrel are their children.","quotes":[{"ref":"Genesis 2:24","text":"Therefore shall a man leave his father and his mother, and shall cleave unto his wife: and they shall be one flesh."}],"refs":["Genesis 2:24"]},{"text":"DEMO NOTE: After Cassia, the mock tale has him marry Odile Fairbairn, mother of Tamsin. Compare the remarriage wording in Genesis 25:1.","quotes":[{"ref":"Genesis 25:1","text":"Then again Abraham took a wife, and her name was Keturah."}],"refs":["Genesis 25:1"]},{"text":"DEMO NOTE: A third note with no quote and two sources, to show each note keeps its own reference list.","refs":["Genesis 33:5","Genesis 48:9"]}],"childrenState":"known","spousesState":"known","siblingsState":"known"},{"id":"cassia-holloway","name":"Cassia Holloway","firstMention":"Genesis 6:10","gender":"female","generation":4,"age":75,"mom":"unknown","dad":"unknown","spouses":["taddeo-vell"],"notes":[],"childrenState":"known","spousesState":"known","siblingsState":"known"},{"id":"odile-fairbairn","name":"Odile Fairbairn","firstMention":"Genesis 7:1","gender":"female","generation":4,"age":68,"mom":"unknown","dad":"unknown","spouses":["taddeo-vell"],"notes":[{"text":"DEMO NOTE: Taddeo's second wife in the invented story. She exists to prove a remarried person renders in two family blocks.","refs":["Genesis 25:1"]}],"childrenState":"known","spousesState":"known","siblingsState":"known"},{"id":"wrenna-vell","name":"Wrenna Vell","firstMention":"Genesis 7:7","gender":"female","generation":4,"age":77,"mom":"ysolde-marrick","dad":"ebbet-vell","spouses":["fenwick-arlo"],"notes":[{"text":"DEMO NOTE: The invented story has Wrenna marry into the Arlo family, which is why her children carry a different surname. Cited verse is decorative, see Genesis 9:13.","quotes":[{"ref":"Genesis 9:13","text":"I do set my bow in the cloud, and it shall be for a token of a covenant between me and the earth."}],"refs":["Genesis 9:13"]},{"text":"DEMO NOTE: A second note for Wrenna. The fictional family remembers her as the one who kept the old orchard going for her children Lisska, Dovrin and Hale.","quotes":[{"ref":"Genesis 8:22","text":"While the earth remaineth, seedtime and harvest, and cold and heat, and summer and winter, and day and night shall not cease."}],"refs":["Genesis 8:22"]}],"childrenState":"known","spousesState":"known","siblingsState":"known"},{"id":"fenwick-arlo","name":"Fenwick Arlo","firstMention":"Genesis 7:13","gender":"male","generation":4,"age":72,"mom":"unknown","dad":"unknown","spouses":["wrenna-vell"],"notes":[],"childrenState":"known","spousesState":"known","siblingsState":"known"},{"id":"ozric-vell","name":"Ozric Vell","firstMention":"Genesis 8:1","gender":"unknown","generation":4,"age":55,"mom":"rowen-vell","dad":"unknown","spouses":[],"notes":[],"childrenState":"known","spousesState":"known","siblingsState":"known"},{"id":"merrit-vell","name":"Merrit Vell","firstMention":"Genesis 8:15","gender":"female","generation":4,"age":61,"mom":"unknown","dad":"pell-vell","spouses":[],"notes":[{"text":"DEMO NOTE: Raised by her father alone in the made-up saga, so her Mom field is empty. This is the mirror image of the single-mother case.","quotes":[{"ref":"Genesis 11:1","text":"And the whole earth was of one language, and of one speech."}],"refs":["Genesis 11:1"]}],"childrenState":"known","spousesState":"known","siblingsState":"known"},{"id":"brisk-vell","name":"Brisk Vell","firstMention":"Genesis 9:1","gender":"male","generation":5,"age":49,"mom":"cassia-holloway","dad":"taddeo-vell","spouses":[],"notes":[],"childrenState":"known","spousesState":"known","siblingsState":"known"},{"id":"sorrel-vell","name":"Sorrel Vell","firstMention":"Genesis 9:18","gender":"female","generation":5,"age":52,"mom":"cassia-holloway","dad":"taddeo-vell","spouses":[],"notes":[],"childrenState":"known","spousesState":"known","siblingsState":"known"},{"id":"tamsin-vell","name":"Tamsin Vell","firstMention":"Genesis 9:19","gender":"female","generation":5,"age":38,"mom":"odile-fairbairn","dad":"taddeo-vell","spouses":[],"notes":[],"childrenState":"known","spousesState":"known","siblingsState":"known"},{"id":"lisska-arlo","name":"Lisska Arlo","firstMention":"Genesis 9:20","gender":"female","generation":5,"age":68,"mom":"wrenna-vell","dad":"fenwick-arlo","spouses":[],"notes":[{"text":"DEMO NOTE: Eldest of three full siblings in the demo data. The fictional story says she dreamed of a staircase to the stars the night her daughter was born.","quotes":[{"ref":"Genesis 28:12","text":"And he dreamed, and behold a ladder set up on the earth, and the top of it reached to heaven: and behold the angels of God ascending and descending on it."}],"refs":["Genesis 28:12"]}],"childrenState":"known","spousesState":"known","siblingsState":"known"},{"id":"dovrin-arlo","name":"Dovrin Arlo","firstMention":"Genesis 9:28","gender":"male","generation":5,"age":63,"mom":"wrenna-vell","dad":"fenwick-arlo","spouses":[],"notes":[],"childrenState":"known","spousesState":"known","siblingsState":"known"},{"id":"hale-arlo","name":"Hale Arlo","firstMention":"Genesis 10:1","gender":"male","generation":5,"age":"unknown","mom":"wrenna-vell","dad":"fenwick-arlo","spouses":[],"notes":[],"childrenState":"known","spousesState":"known","siblingsState":"known"},{"id":"juniver-vell","name":"Juniver Vell","firstMention":"Genesis 10:2","gender":"female","generation":5,"age":40,"mom":"merrit-vell","dad":"unknown","spouses":[],"notes":[],"childrenState":"known","spousesState":"known","siblingsState":"known"},{"id":"kestrel-arlo","name":"Kestrel Arlo","firstMention":"Genesis 10:6","gender":"male","generation":6,"age":41,"mom":"lisska-arlo","dad":"unknown","spouses":[],"notes":[],"childrenState":"known","spousesState":"known","siblingsState":"known"},{"id":"thistle-arlo","name":"Thistle Arlo","firstMention":"Genesis 10:21","gender":"female","generation":6,"age":44,"mom":"lisska-arlo","dad":"unknown","spouses":[],"notes":[],"childrenState":"known","spousesState":"known","siblingsState":"known"},{"id":"pim-vell","name":"Pim Vell","firstMention":"Genesis 10:22","gender":"male","generation":6,"age":30,"mom":"unknown","dad":"brisk-vell","spouses":[],"notes":[],"childrenState":"known","spousesState":"known","siblingsState":"known"},{"id":"lark-vell","name":"Lark Vell","firstMention":"Genesis 10:25","gender":"female","generation":6,"age":28,"mom":"unknown","dad":"brisk-vell","spouses":[],"notes":[],"childrenState":"known","spousesState":"known","siblingsState":"known"},{"id":"wick-arlo","name":"Wick Arlo","firstMention":"Genesis 11:10","gender":"male","generation":7,"age":9,"mom":"thistle-arlo","dad":"unknown","spouses":[],"notes":[],"childrenState":"known","spousesState":"known","siblingsState":"none"},{"id":"briar-vell","name":"Briar Vell","firstMention":"Genesis 11:26","gender":"female","generation":7,"age":6,"mom":"unknown","dad":"pim-vell","spouses":[],"notes":[{"text":"DEMO NOTE: Youngest person in the mock tree (generation 7). Present only to prove the layout handles a deep family line.","quotes":[{"ref":"Genesis 1:1","text":"In the beginning God created the heaven and the earth."}],"refs":["Genesis 1:1"]},{"text":"DEMO NOTE: Second note for Briar, quoting a different verse than the first so each note's quote can be checked separately.","quotes":[{"ref":"Genesis 1:3","text":"And God said, Let there be light: and there was light."}],"refs":["Genesis 1:3"]}],"childrenState":"known","spousesState":"known","siblingsState":"known"},{"id":"unknown-cousin","name":"Unknown Cousin","firstMention":"Genesis 11:31","gender":"unknown","generation":"unknown","age":"unknown","mom":"unknown","dad":"unknown","spouses":[],"notes":[],"childrenState":"unknown","spousesState":"unknown","siblingsState":"unknown"},{"id":"adam","name":"Adam","gender":"male","generation":1,"age":930,"mom":"none","dad":"none","spouses":["eve"],"notes":[],"firstMention":"Genesis 2:19"},{"id":"eve","name":"Eve","gender":"female","generation":1,"age":"unknown","mom":"none","dad":"none","spouses":["adam"],"notes":[],"firstMention":"Genesis 3:20"},{"id":"cain","name":"Cain","gender":"male","generation":2,"age":"unknown","mom":"eve","dad":"adam","spouses":[],"spousesState":"unknown","childrenState":"unknown","notes":[],"firstMention":"Genesis 4:1"},{"id":"abel","name":"Abel","gender":"male","generation":2,"age":"unknown","mom":"eve","dad":"adam","spouses":[],"spousesState":"unknown","childrenState":"unknown","notes":[],"firstMention":"Genesis 4:2"},{"id":"seth","name":"Seth","gender":"male","generation":2,"age":912,"mom":"eve","dad":"adam","spouses":[],"spousesState":"unknown","childrenState":"unknown","notes":[],"firstMention":"Genesis 4:25"}];

// ------------------------------------------------------------------ filter builder rows

const rowIds = (rows) => {
  const idx = Family.buildIndex(DEMO);
  return Family.filterByRows(DEMO, idx, rows).map((p) => p.id);
};
const R = (field, operator, value, value2) => ({ field, operator: operator || null, value: value === undefined ? '' : value, value2: value2 === undefined ? '' : value2 });
const allIds = () => DEMO.map((p) => p.id);

test('generation accepts "unknown", rejects other junk; unknown-cousin is generation "unknown"', () => {
  const base = (id, generation) => ({ id, name: id, gender: 'male', generation, age: null, mom: null, dad: null, spouses: [], notes: [] });
  for (const ok of [1, 7, 'unknown']) {
    const problems = Family.validate([base('a', ok)]);
    assert(!problems.some((p) => /generation/.test(p)), `generation ${JSON.stringify(ok)} should be accepted: ${problems}`);
  }
  for (const bad of [0, -1, 2.5, '3', 'Unknown', 'unk', null, undefined, '']) {
    const problems = Family.validate([base('a', bad)]).join('\n');
    assert(problems.includes('generation must be a positive integer or "unknown"'), `generation ${JSON.stringify(bad)} should be rejected`);
  }
  // Unknown sorts after every numbered generation (tree band + search order).
  assert(Family.generationRank('unknown') > Family.generationRank(999));
});

test('filter rows: Name is a case-insensitive contains; blank is inert', () => {
  assert.deepStrictEqual(rowIds([R('name', null, 'ARLO')]).sort(),
    allIds().filter((id) => /arlo/i.test(DEMO.find((p) => p.id === id).name)).sort());
  assert.deepStrictEqual(rowIds([R('name', null, '  wick ')]).sort(), ['fenwick-arlo', 'wick-arlo']);
  assert.deepStrictEqual(rowIds([R('name', null, '')]), allIds());
  assert.deepStrictEqual(rowIds([R('name', null, '   ')]), allIds());
  assert.deepStrictEqual(rowIds([R('name', null, 'zzzz')]), []);
});

test('filter rows: Generation is / is between (inclusive, blank side unbounded) / is unknown', () => {
  const gen = (g) => DEMO.filter((p) => p.generation === g).map((p) => p.id);
  assert.deepStrictEqual(rowIds([R('generation', 'is', '3')]), gen(3));
  assert.deepStrictEqual(rowIds([R('generation', 'is', '')]), allIds(), 'blank "is" is inert');
  assert.deepStrictEqual(rowIds([R('generation', 'is', 'abc')]), [], 'junk "is" matches nothing');
  assert.deepStrictEqual(rowIds([R('generation', 'between', '2', '3')]), gen(2).concat(gen(3)).sort((a, b) => allIds().indexOf(a) - allIds().indexOf(b)));
  assert.deepStrictEqual(rowIds([R('generation', 'between', '6', '')]), gen(6).concat(gen(7)), 'blank max = unbounded');
  assert.deepStrictEqual(rowIds([R('generation', 'between', '', '1')]), gen(1), 'blank min = unbounded');
  assert.deepStrictEqual(rowIds([R('generation', 'between', '', '')]), allIds(), 'both blank = inert');
  assert(!rowIds([R('generation', 'between', '1', '99')]).includes('unknown-cousin'), 'unknown generation is never in a numeric range');
  assert.deepStrictEqual(rowIds([R('generation', 'isUnknown')]), ['unknown-cousin']);
});

test('filter rows: Gender dropdown (blank = any)', () => {
  for (const g of ['male', 'female', 'unknown']) {
    const got = rowIds([R('gender', null, g)]);
    assert(got.length && got.every((id) => DEMO.find((p) => p.id === id).gender === g), g);
    assert.strictEqual(got.length, DEMO.filter((p) => p.gender === g).length, g);
  }
  assert.deepStrictEqual(rowIds([R('gender', null, '')]), allIds());
  assert(rowIds([R('gender', null, 'unknown')]).includes('ozric-vell'));
});

test('filter rows: Age is / is between / is unknown; junk "is" matches nothing', () => {
  assert.deepStrictEqual(rowIds([R('age', 'is', '96')]), ['garrow-vell']);
  assert.deepStrictEqual(rowIds([R('age', 'is', ' 64 ')]).sort(), ['liesl-thorne', 'nyra-vell']);
  assert.deepStrictEqual(rowIds([R('age', 'is', '')]), allIds(), 'blank "is" is inert');
  assert.deepStrictEqual(rowIds([R('age', 'is', 'old')]), [], 'junk "is" matches nothing');
  const inRange = (lo, hi) => DEMO.filter((p) => typeof p.age === 'number' && p.age >= lo && p.age <= hi).map((p) => p.id);
  assert.deepStrictEqual(rowIds([R('age', 'between', '61', '64')]), inRange(61, 64), 'inclusive');
  assert(rowIds([R('age', 'between', '61', '64')]).includes('merrit-vell') && rowIds([R('age', 'between', '61', '64')]).includes('liesl-thorne'));
  assert.deepStrictEqual(rowIds([R('age', 'between', '90', '')]), ['garrow-vell', 'isoline-ashby', 'adam', 'seth'], 'blank max = unbounded');
  assert.deepStrictEqual(rowIds([R('age', 'between', '900', '')]), ['adam', 'seth'], 'the patriarchs\' ages filter like any other');
  assert.deepStrictEqual(rowIds([R('age', 'between', '', '9')]), ['wick-arlo', 'briar-vell'], 'blank min = unbounded');
  assert.deepStrictEqual(rowIds([R('age', 'between', '70', '60')]), [], 'bounds applied as typed, never swapped');
  assert.deepStrictEqual(rowIds([R('age', 'between', '', '')]), allIds(), 'both blank = inert');
  assert.deepStrictEqual(rowIds([R('age', 'isUnknown')]).sort(), ['abel', 'cain', 'eve', 'hale-arlo', 'pell-vell', 'unknown-cousin']);
});

test('filter rows: Mom / Dad contain-match the parent\'s name; unknown/none never match a query', () => {
  const idx = Family.buildIndex(DEMO);
  const kidsOf = (role, re) => DEMO.filter((p) => idx.byId.has(p[role]) && re.test(idx.byId.get(p[role]).name)).map((p) => p.id);
  assert.deepStrictEqual(rowIds([R('mom', null, 'wrenna')]), ['lisska-arlo', 'dovrin-arlo', 'hale-arlo']);
  assert.deepStrictEqual(rowIds([R('mom', null, 'VELL')]), kidsOf('mom', /vell/i));
  assert.deepStrictEqual(rowIds([R('dad', null, 'brisk')]), ['pim-vell', 'lark-vell']);
  assert.deepStrictEqual(rowIds([R('dad', null, 'arlo')]), kidsOf('dad', /arlo/i));
  // Unknown/none parents: a non-blank query never matches, even "unknown"/"none".
  for (const q of ['unknown', 'none', 'n']) {
    const got = rowIds([R('mom', null, q)]);
    assert(!got.includes('unknown-cousin') && !got.includes('garrow-vell') && !got.includes('pim-vell'), `mom "${q}"`);
  }
  assert(!rowIds([R('dad', null, 'unknown')]).includes('unknown-cousin'));
  assert.deepStrictEqual(rowIds([R('mom', null, '')]), allIds(), 'blank is inert');
  assert.deepStrictEqual(rowIds([R('dad', null, ' ')]), allIds(), 'blank is inert');
});

test('filter rows: Child / Sibling / Spouse amount, amount range, name', () => {
  const idx = Family.buildIndex(DEMO);
  const count = (map, pred) => DEMO.filter((p) => pred((idx[map].get(p.id) || []).length)).map((p) => p.id);
  // Child
  assert.deepStrictEqual(rowIds([R('child', 'amount', '4')]), ['bram-vell', 'maelis-dunhart']);
  assert.deepStrictEqual(rowIds([R('child', 'amount', '0')]), count('childrenOf', (n) => n === 0));
  assert.deepStrictEqual(rowIds([R('child', 'amount', '')]), allIds(), 'blank amount is inert');
  assert.deepStrictEqual(rowIds([R('child', 'amount', 'x')]), [], 'junk amount matches nothing');
  assert.deepStrictEqual(rowIds([R('child', 'amountRange', '2', '3')]), count('childrenOf', (n) => n >= 2 && n <= 3), 'inclusive');
  assert.deepStrictEqual(rowIds([R('child', 'amountRange', '3', '')]), count('childrenOf', (n) => n >= 3), 'blank max = unbounded');
  assert.deepStrictEqual(rowIds([R('child', 'amountRange', '', '')]), allIds());
  assert.deepStrictEqual(rowIds([R('child', 'name', 'briar')]), ['pim-vell']);
  assert.deepStrictEqual(rowIds([R('child', 'name', 'TADDEO')]), ['ebbet-vell', 'ysolde-marrick']);
  assert.deepStrictEqual(rowIds([R('child', 'name', '')]), allIds(), 'blank name is inert');
  // Sibling
  assert.deepStrictEqual(rowIds([R('sibling', 'name', 'lark')]), ['pim-vell']);
  assert.deepStrictEqual(rowIds([R('sibling', 'amount', '3')]), count('siblingsOf', (n) => n === 3));
  assert(rowIds([R('sibling', 'name', 'vell')]).every((id) => (idx.siblingsOf.get(id) || []).some((s) => /vell/i.test(idx.byId.get(s.id).name))));
  // Spouse
  assert.deepStrictEqual(rowIds([R('spouse', 'amount', '2')]), ['taddeo-vell']);
  assert.deepStrictEqual(rowIds([R('spouse', 'amountRange', '1', '1')]), count('spousesOf', (n) => n === 1));
  assert.deepStrictEqual(rowIds([R('spouse', 'name', 'taddeo')]), ['cassia-holloway', 'odile-fairbairn']);
});

test('filter rows: Notes has note / no note / note contains (blank inert)', () => {
  const withNotes = DEMO.filter((p) => Family.noteViews(p).length > 0).map((p) => p.id);
  assert(withNotes.length > 0 && withNotes.length < DEMO.length);
  assert.deepStrictEqual(rowIds([R('notes', 'hasNote')]), withNotes);
  assert.deepStrictEqual(rowIds([R('notes', 'noNote')]), allIds().filter((id) => !withNotes.includes(id)));
  const word = 'ORCHARD';
  const expected = DEMO.filter((p) => p.notes.some((n) => n.text.toLowerCase().includes('orchard'))).map((p) => p.id);
  assert(expected.includes('garrow-vell'));
  assert.deepStrictEqual(rowIds([R('notes', 'noteContains', word)]), expected, 'case-insensitive contains over note text');
  assert.deepStrictEqual(rowIds([R('notes', 'noteContains', 'zzqq')]), []);
  assert.deepStrictEqual(rowIds([R('notes', 'noteContains', '')]), allIds(), 'blank is inert');
});

test('filter rows AND together; blank rows inert; rowIsActive mirrors inertness', () => {
  assert.deepStrictEqual(rowIds([]), allIds());
  assert.deepStrictEqual(rowIds([R('name', null, 'vell'), R('gender', null, 'female'), R('generation', 'is', '3')]), ['nyra-vell', 'rowen-vell']);
  assert.deepStrictEqual(rowIds([R('mom', null, 'wrenna'), R('age', 'isUnknown')]), ['hale-arlo']);
  assert.deepStrictEqual(rowIds([R('name', null, 'vell'), R('name', null, 'arlo')]), [], 'contradictory rows match nobody');
  // A pile of blank rows changes nothing.
  const blanks = [R('name'), R('gender'), R('mom'), R('dad'), R('generation', 'is'), R('generation', 'between'),
    R('age', 'is'), R('age', 'between'), R('child', 'amount'), R('sibling', 'amountRange'), R('spouse', 'name'), R('notes', 'noteContains')];
  assert.deepStrictEqual(rowIds(blanks), allIds());
  assert(blanks.every((r) => !Family.rowIsActive(r)), 'blank rows are not counted as active');
  for (const r of [R('name', null, 'a'), R('gender', null, 'male'), R('generation', 'isUnknown'), R('age', 'between', '', '5'),
    R('child', 'amount', '0'), R('notes', 'hasNote'), R('notes', 'noNote'), R('dad', null, 'x'), R('age', 'is', 'junk')]) {
    assert(Family.rowIsActive(r), `should be active: ${JSON.stringify(r)}`);
  }
});

// ------------------------------------------------------------------ same-named DEMO

// Same-named DEMO are distinct individuals: every link is by id, never by name.
const SP = (id, name, gender, extra) => Object.assign(
  { id, name, gender, generation: 1, age: 40, mom: 'unknown', dad: 'unknown', spouses: [], notes: [], firstMention: 'Genesis 4:17' }, extra);
const sameNameRows = (list, rows) => Family.filterByRows(list, Family.buildIndex(list), rows).map((p) => p.id);

test('same name: byName is a multi-map holding every same-named person in data order', () => {
  const list = [SP('mary-a', 'Mary Vell', 'female'), SP('other', 'Other', 'male'), SP('mary-b', 'mary vell', 'female')];
  const idx = Family.buildIndex(list);
  const marys = idx.byName.get('mary vell');
  assert(Array.isArray(marys), 'byName values are arrays, not single people');
  assert.deepStrictEqual(marys.map((p) => p.id), ['mary-a', 'mary-b'], 'both kept, first to last in data order');
  assert(idx.byName.get('other').length === 1 && idx.byName.get('other')[0].id === 'other', 'unique names are length-1 arrays');
  assert(idx.byId.has('mary-a') && idx.byId.has('mary-b'));
  assert.deepStrictEqual(Object.keys(idx).sort(), ['byId', 'byName', 'childrenOf', 'problems', 'siblingsOf', 'spousesOf']);
  // Nameless synthetic fixtures are still skipped.
  assert.strictEqual(Family.buildIndex([{ id: 'x' }]).byName.size, 0);
});

test('same name: a married Mary with a child and a single Mary with a note stay separate', () => {
  const list = [
    SP('mary-a', 'Mary Vell', 'female', { spouses: ['john-a'] }),
    SP('john-a', 'John Vell', 'male', { spouses: ['mary-a'] }),
    SP('mary-b', 'Mary Vell', 'female', { notes: [{ text: 'The other Mary.', refs: ['John 19:25'] }] }),
    SP('kid-a', 'Kid Vell', 'male', { generation: 2, age: 10, mom: 'mary-a', dad: 'john-a' })
  ];
  assert.deepStrictEqual(Family.validate(list), [], 'duplicate names are allowed');
  const idx = Family.buildIndex(list);
  const fb = Family.deriveUnions(idx);
  assert.deepStrictEqual(fb.unions.map((u) => `${u.key}:${u.children.join(',')}`), ['mary-a|john-a:kid-a']);
  assert.deepStrictEqual(idx.childrenOf.get('mary-a'), ['kid-a']);
  assert.deepStrictEqual(idx.childrenOf.get('mary-b') || [], [], 'the single Mary has no children');
  assert.deepStrictEqual(idx.spousesOf.get('mary-a'), ['john-a']);
  assert.deepStrictEqual(idx.spousesOf.get('mary-b') || [], []);
  const found = Family.search(list, idx, 'mary').map((r) => r.person.id);
  assert(found.includes('mary-a') && found.includes('mary-b'), `search finds both Marys: ${found}`);
  assert.deepStrictEqual(sameNameRows(list, [R('name', null, 'mary')]), ['mary-a', 'mary-b']);
  assert.deepStrictEqual(sameNameRows(list, [R('mom', null, 'mary')]), ['kid-a'], 'mom resolves by id, not name');
  assert.deepStrictEqual(sameNameRows(list, [R('notes', 'hasNote')]), ['mary-b']);
  assert.deepStrictEqual(sameNameRows(list, [R('child', 'amount', '1'), R('name', null, 'mary')]), ['mary-a']);
});

test('same name: two same-named sisters (same mom, dad, generation) are two people', () => {
  const list = [
    SP('ma', 'Anna Vell', 'female', { spouses: ['pa'] }),
    SP('pa', 'Joachim Vell', 'male', { spouses: ['ma'] }),
    SP('mary-1', 'Mary Vell', 'female', { generation: 2, age: 20, mom: 'ma', dad: 'pa' }),
    SP('mary-2', 'Mary Vell', 'female', { generation: 2, age: 18, mom: 'ma', dad: 'pa' })
  ];
  assert.deepStrictEqual(Family.validate(list), [], 'same-named siblings are accepted');
  const idx = Family.buildIndex(list);
  const fb = Family.deriveUnions(idx);
  assert.deepStrictEqual(fb.byKey.get('ma|pa').children, ['mary-1', 'mary-2'], 'both children, in data order');
  assert.deepStrictEqual(idx.siblingsOf.get('mary-1'), [{ id: 'mary-2', kind: 'full' }]);
  assert.deepStrictEqual(idx.siblingsOf.get('mary-2'), [{ id: 'mary-1', kind: 'full' }]);
  assert.deepStrictEqual(idx.byName.get('mary vell').map((p) => p.id), ['mary-1', 'mary-2']);
  assert.deepStrictEqual(sameNameRows(list, [R('child', 'amount', '2')]), ['ma', 'pa'], 'both sisters count as children');
  assert.deepStrictEqual(sameNameRows(list, [R('child', 'name', 'mary')]), ['ma', 'pa'], 'child-name matches the parents');
  assert.deepStrictEqual(sameNameRows(list, [R('mom', null, 'anna')]), ['mary-1', 'mary-2']);
  assert.deepStrictEqual(sameNameRows(list, [R('dad', null, 'joachim')]), ['mary-1', 'mary-2']);
  assert.deepStrictEqual(sameNameRows(list, [R('sibling', 'name', 'mary')]), ['mary-1', 'mary-2'], 'each is the other\'s sibling');
  const found = Family.search(list, idx, 'mary').map((r) => r.person.id);
  assert(found.includes('mary-1') && found.includes('mary-2'));
});

// ------------------------------------------------------------------ KJV text

const KJV_DIR = path.join(ROOT, 'public', 'kjv');
const kjvBooks = new Map(); // slug -> parsed file, so each is read once
const kjv = (slug) => {
  if (!kjvBooks.has(slug)) kjvBooks.set(slug, JSON.parse(fs.readFileSync(path.join(KJV_DIR, `${slug}.json`), 'utf8')));
  return kjvBooks.get(slug);
};
/** Text of a single-verse ref, or undefined when the verse doesn't exist. */
const verseText = (ref) => {
  const r = Family.parseRef(ref);
  const ch = kjv(Family.bookSlug(r.book)).chapters[r.chapter - 1];
  return ch && ch[r.verse - 1];
};

test('KJV: index.json lists the 66 books in canonical order with slugs the app derives', () => {
  const index = JSON.parse(fs.readFileSync(path.join(KJV_DIR, 'index.json'), 'utf8'));
  assert.strictEqual(index.length, 66);
  // Same spellings as family.js's BOOKS (minus the "Psalm" alias), same order.
  assert.deepStrictEqual(index.map((b) => b.book), Family.BOOKS.filter((b) => b !== 'Psalm'));
  for (const b of index) assert.strictEqual(Family.bookSlug(b.book), b.slug, `${b.book} slug`);
  assert.strictEqual(Family.bookSlug('1 Samuel'), '1-samuel');
  assert.strictEqual(Family.bookSlug('Psalm'), 'psalms', 'the "Psalm" alias maps to the Psalms file');
  assert.strictEqual(Family.bookSlug('Song of Solomon'), 'song-of-solomon');
});

test('KJV: every index entry\'s file exists, parses, and has the listed chapter count', () => {
  const index = JSON.parse(fs.readFileSync(path.join(KJV_DIR, 'index.json'), 'utf8'));
  let verses = 0;
  for (const b of index) {
    const file = kjv(b.slug);
    assert.strictEqual(file.book, b.book, `${b.slug}.json names its book`);
    assert.strictEqual(file.chapters.length, b.chapters, `${b.book} chapter count`);
    for (const ch of file.chapters) {
      assert(Array.isArray(ch) && ch.length > 0, `${b.book}: every chapter has verses`);
      verses += ch.length;
    }
  }
  assert.strictEqual(verses, 31102, 'the whole KJV');
});

test('KJV: Genesis has 50 chapters, 31 verses in chapter 1; spot texts', () => {
  const gen = kjv('genesis');
  assert.strictEqual(gen.chapters.length, 50);
  assert.strictEqual(gen.chapters[0].length, 31);
  assert.strictEqual(verseText('Genesis 1:1'), 'In the beginning God created the heaven and the earth.');
  assert.match(verseText('John 3:16'), /^For God so loved the world, that he gave his only begotten Son/);
  assert.strictEqual(kjv('psalms').chapters[118].length, 176, 'Psalm 119');
  assert.strictEqual(verseText('Psalm 119:176'), verseText('Psalms 119:176'));
});

// ------------------------------------------------------------------ firstMention

test('refs: parseRef / verseKey / isSingleVerseRef', () => {
  assert.deepStrictEqual(Family.parseRef('Genesis 2'), { book: 'Genesis', chapter: 2, verse: null });
  assert.deepStrictEqual(Family.parseRef(' 1 Samuel 3:4 '), { book: '1 Samuel', chapter: 3, verse: 4 });
  assert.deepStrictEqual(Family.parseRef('Psalm 23:1'), { book: 'Psalms', chapter: 23, verse: 1 });
  for (const bad of ['Genesis 1:1-2', 'Genesis 1:1, 2:3', 'Hezekiah 1:1', 'Genesis', 'Genesis 0:1', 'Genesis 1:0', '', null, 7]) {
    assert.strictEqual(Family.parseRef(bad), null, `parseRef(${JSON.stringify(bad)})`);
  }
  assert.strictEqual(Family.verseKey('Psalm 23:1'), 'Psalms 23:1');
  assert.strictEqual(Family.verseKey('Genesis 2'), null, 'a chapter is not a verse');
  assert(Family.isSingleVerseRef('Song of Solomon 1:1'));
  assert(!Family.isSingleVerseRef('Genesis 2'));
});

test('firstMention: missing/empty, ranges, lists, bogus books and whole chapters are rejected', () => {
  const one = (firstMention) => Family.validate([{ id: 'x', name: 'X', gender: 'male', generation: 1, age: null,
    mom: 'none', dad: 'none', spouses: [], notes: [], firstMention }]);
  const expectProblem = (v, needle) => {
    const problems = one(v).join('\n');
    assert(problems.includes(needle), `firstMention ${JSON.stringify(v)} should give a problem mentioning "${needle}", got:\n${problems}`);
  };
  expectProblem(undefined, 'firstMention is required');
  expectProblem('', 'firstMention is required');
  expectProblem('   ', 'firstMention is required');
  expectProblem(42, 'firstMention is required');
  expectProblem('Genesis 1:1-2', 'single verse, not a range');
  expectProblem('Genesis 1:1–2', 'single verse, not a range');
  expectProblem('Genesis 1:1, 2:3', 'single verse, not a range or a list');
  expectProblem('Genesis 1:1; Exodus 2:1', 'single verse, not a range or a list');
  expectProblem('Hezekiah 1:1', 'not a recognised reference');
  expectProblem('genesis 1:1', 'not a recognised reference');
  expectProblem('Genesis 2', 'must name one verse');
  for (const ok of ['Genesis 2:19', '1 Samuel 3:4', 'Psalm 23:1', 'Psalms 23:1', 'Song of Solomon 1:1', 'Revelation 22:21']) {
    assert.deepStrictEqual(one(ok), [], `"${ok}" is a valid firstMention`);
    assert.strictEqual(Family.firstMentionProblem(ok), null);
  }
});

test('firstMention: every person in people.json has one, and the verse exists in the KJV', () => {
  for (const p of people) {
    assert.strictEqual(Family.firstMentionProblem(p.firstMention), null, `${p.id}: ${Family.firstMentionProblem(p.firstMention)}`);
    assert.strictEqual(typeof verseText(p.firstMention), 'string', `${p.id}: ${p.firstMention} is not a KJV verse`);
  }
  assert.deepStrictEqual(Family.validate(people), []);
});

// The demo-family/Genesis-seed data tests were removed when the walk restarted at
// Genesis 1 (no people named yet). Standing guards that survive: the every-person
// firstMention check above, and the synthetic same-name / resolution suites below.
// When real people are entered (Genesis 2 onward), re-add verse-fact tests for them.

// ------------------------------------------------------------------ name resolution

const NP = (id, name, firstMention) => ({ id, name, gender: 'female', generation: 1, age: null,
  mom: 'unknown', dad: 'unknown', spouses: [], notes: [], firstMention });
const occ = (text, list, ref, overrides) => Family.findNameOccurrences(text, Family.buildIndex(list), ref, overrides)
  .map((o) => [o.start, o.end, o.text, o.person.id]);

test('names: a unique name resolves; case-insensitive; possessive; word boundaries', () => {
  const list = [NP('adam', 'Adam', 'Genesis 2:19'), NP('eve', 'Eve', 'Genesis 3:20')];
  assert.deepStrictEqual(occ('And Adam knew Eve his wife', list, 'Genesis 4:1'),
    [[4, 8, 'Adam', 'adam'], [14, 17, 'Eve', 'eve']]);
  assert.deepStrictEqual(occ("ADAM's rib", list, 'Genesis 9:9'), [[0, 4, 'ADAM', 'adam']], 'case-insensitive, "Adam\'s"');
  assert.deepStrictEqual(occ('an adamant stone, even on the eve; madam', list, 'Ezekiel 3:9'), [[30, 33, 'eve', 'eve']],
    '"adamant", "even" and "madam" merely contain a name');
  assert.deepStrictEqual(occ('Adam1 Adam_x', list, 'Genesis 1:1'), [[6, 10, 'Adam', 'adam']], 'digits are word chars; "_" is not');
  // A hyphen joins a compound name: Tubal-cain is not Cain (Genesis 4:22).
  const cain = [NP('cain', 'Cain', 'Genesis 4:1'), NP('tc', 'Tubal-cain', 'Genesis 4:22')];
  assert.deepStrictEqual(occ('Tubal-cain, and the sister of Tubal-cain', [cain[0]], 'Genesis 4:22'), [], 'no Cain inside Tubal-cain');
  assert.deepStrictEqual(occ('cain-tubal', [cain[0]], 'Genesis 4:22'), [], 'nor at the front of a compound');
  assert.deepStrictEqual(occ('Tubal-cain and Cain - and Cain', cain, 'Genesis 4:22'),
    [[0, 10, 'Tubal-cain', 'tc'], [15, 19, 'Cain', 'cain'], [26, 30, 'Cain', 'cain']], 'a spaced dash is still a boundary');
  assert.deepStrictEqual(occ('', list, 'Genesis 1:1'), []);
  assert.deepStrictEqual(Family.findNameOccurrences('Adam', null, 'Genesis 1:1'), [], 'no index, no links');
});

test('names: the longest name wins on overlap; a multi-word name only as the adjacent phrase', () => {
  const list = [NP('gv', 'Garrow Vell', 'Genesis 4:17'), NP('g', 'Garrow', 'Genesis 4:18'), NP('v', 'Vell', 'Genesis 4:19')];
  assert.deepStrictEqual(occ('Garrow Vell spake unto Garrow', list, 'Genesis 9:9'),
    [[0, 11, 'Garrow Vell', 'gv'], [23, 29, 'Garrow', 'g']]);
  assert.deepStrictEqual(occ('Garrow\nVell', list, 'Genesis 9:9'), [[0, 11, 'Garrow\nVell', 'gv']], 'any whitespace between words');
  assert.deepStrictEqual(occ('Garrow, Vell', list, 'Genesis 9:9'), [[0, 6, 'Garrow', 'g'], [8, 12, 'Vell', 'v']],
    'not adjacent: each word on its own');
  assert.deepStrictEqual(occ('Garrow Vellum', list, 'Genesis 9:9'), [[0, 6, 'Garrow', 'g']], 'phrase must end on a boundary');
});

test('names: a repeated name anchors to the person whose firstMention is this verse', () => {
  const list = [NP('mary-a', 'Mary', 'Luke 1:27'), NP('mary-b', 'Mary', 'Matthew 27:56')];
  assert.deepStrictEqual(occ('the virgin\'s name was Mary', list, 'Luke 1:27'), [[22, 26, 'Mary', 'mary-a']]);
  assert.deepStrictEqual(occ('Among which was Mary', list, 'Matthew 27:56'), [[16, 20, 'Mary', 'mary-b']]);
  // Two people claiming the same first-mention verse settle nothing.
  const clash = [NP('m1', 'Mary', 'Luke 1:27'), NP('m2', 'Mary', 'Luke 1:27')];
  assert.deepStrictEqual(occ('Mary', clash, 'Luke 1:27'), []);
});

test('names: a repeated name in a later verse resolves through mentions overrides', () => {
  const list = [NP('mary-a', 'Mary', 'Luke 1:27'), NP('mary-b', 'Mary', 'Matthew 27:56'), NP('john', 'John', 'Matthew 3:1')];
  const overrides = { 'John 19:25': { Mary: 'mary-b' } };
  assert.deepStrictEqual(occ('his mother\'s sister, Mary', list, 'John 19:25', overrides), [[21, 25, 'Mary', 'mary-b']]);
  assert.deepStrictEqual(occ('MARY', list, 'John 19:25', { 'John 19:25': { mary: 'mary-a' } }), [[0, 4, 'MARY', 'mary-a']],
    'display-name keys match case-insensitively');
  assert.deepStrictEqual(occ('Mary', list, 'Psalms 23:1', { 'Psalm 23:1': { Mary: 'mary-a' } }), [[0, 4, 'Mary', 'mary-a']],
    'verse keys are compared canonically');
  // An override only picks among people who bear the name.
  assert.deepStrictEqual(occ('Mary', list, 'John 19:25', { 'John 19:25': { Mary: 'john' } }), []);
  assert.deepStrictEqual(occ('Mary', list, 'John 19:25', { 'John 19:25': { Mary: 'ghost' } }), []);
  // An override for another verse doesn't leak.
  assert.deepStrictEqual(occ('Mary', list, 'John 19:26', overrides), []);
});

test('names: a still-ambiguous repeated name is plain text — never a guess', () => {
  const list = [NP('mary-a', 'Mary', 'Luke 1:27'), NP('mary-b', 'Mary', 'Matthew 27:56'), NP('john', 'John', 'Matthew 3:1')];
  assert.deepStrictEqual(occ('Mary and John', list, 'John 19:25'), [[9, 13, 'John', 'john']], 'only the unique name links');
  assert.deepStrictEqual(occ('Mary and John', list, 'John 19:25', undefined), [[9, 13, 'John', 'john']]);
  assert.strictEqual(Family.resolveName('mary', Family.buildIndex(list), 'John 19:25', {}), null);
  // An ambiguous long name still owns its span: the shorter name inside it
  // must not be linked in its place.
  const nested = [NP('gv1', 'Garrow Vell', 'Genesis 4:17'), NP('gv2', 'Garrow Vell', 'Genesis 4:18'), NP('g', 'Garrow', 'Genesis 4:19')];
  assert.deepStrictEqual(occ('Garrow Vell', nested, 'Genesis 9:9'), []);
  assert.deepStrictEqual(occ('Garrow Vell', nested, 'Genesis 4:18'), [[0, 11, 'Garrow Vell', 'gv2']]);
});

test('mentions.json: validateMentions checks refs, ids and names; the real file (if any) is clean', () => {
  const list = [NP('mary-a', 'Mary', 'Luke 1:27'), NP('mary-b', 'Mary', 'Matthew 27:56'), NP('john', 'John', 'Matthew 3:1')];
  const idx = Family.buildIndex(list);
  assert.deepStrictEqual(Family.validateMentions({ 'John 19:25': { Mary: 'mary-b' }, 'Psalm 1:1': {} }, idx), []);
  const problems = Family.validateMentions({
    'John 19:25-26': { Mary: 'mary-b' },
    'John 19': { Mary: 'mary-b' },
    'Luke 2:5': { Mary: 'ghost' },
    'Luke 2:6': { Mary: 'john' },
    'Luke 2:7': 'mary-a'
  }, idx).join('\n');
  for (const needle of ['"John 19:25-26" is not a single verse', '"John 19" is not a single verse',
    'points to unknown id "ghost"', 'points to "john", whose name is "John"', '"Luke 2:7" must map display names']) {
    assert(problems.includes(needle), `expected "${needle}" in:\n${problems}`);
  }
  assert.deepStrictEqual(Family.validateMentions([], idx), ['mentions.json must be an object keyed by verse ("Book C:V")']);

  const file = path.join(ROOT, 'data', 'mentions.json');
  if (fs.existsSync(file)) {
    const real = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepStrictEqual(Family.validateMentions(real, Family.buildIndex(people)), []);
    for (const ref of Object.keys(real)) assert.strictEqual(typeof verseText(ref), 'string', `mentions.json: ${ref} is a KJV verse`);
  }
});

test('server boots, serves the page, and /api/people returns the array', () => withServer({}, async (port) => {
  const api = await get(port, '/api/people');
  assert.strictEqual(api.status, 200);
  assert.match(api.type, /application\/json/);
  const list = JSON.parse(api.body);
  assert(Array.isArray(list));
  assert.strictEqual(list.length, people.length);

  const page = await get(port, '/');
  assert.strictEqual(page.status, 200);
  assert.match(page.body, /GENESIS 1 READ/);
  assert.match(page.body, /no people are named in Genesis 1/, 'banner says why the tree is empty');
  assert.match(page.body, /first named person arrives in Genesis 2/, 'banner points at what comes next');
  for (const id of ['bible-btn', 'reader-panel', 'reader-backdrop', 'reader-book', 'reader-prev', 'reader-next', 'reader-where', 'reader-close', 'reader-body']) {
    assert(page.body.includes(`id="${id}"`), `page should contain #${id}`);
  }
  assert(page.body.includes('family.js?v=10') && page.body.includes('app.js?v=10'), 'both scripts cache-busted at v=10');
  const kjvIndex = await get(port, '/kjv/index.json');
  assert.strictEqual(kjvIndex.status, 200, 'KJV files are served statically');
  assert.match(kjvIndex.type, /application\/json/);
  assert.strictEqual((await get(port, '/kjv/1-samuel.json')).status, 200);
  // The prefix search was removed — its hint must be gone from the page too.
  assert(!/kid:/.test(page.body), 'prefix search hint should be gone along with the search box');
  // Generation/Gender live in the filter panel now, alongside the new filters.
  for (const id of ['filters-btn', 'filters-badge', 'filter-panel', 'add-filter-row', 'filter-rows',
    'filter-backdrop', 'filter-reset', 'filter-close', 'clear-filters', 'filter-count', 'results-count']) {
    assert(page.body.includes(`id="${id}"`), `page should contain #${id}`);
  }
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

test('GET /api/mentions: absent file yields {}, malformed yields 500, fixes need no restart', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bft-'));
  const file = path.join(tmp, 'mentions.json');
  try {
    await withServer({ MENTIONS_FILE: file }, async (port, child) => {
      const absent = await get(port, '/api/mentions');
      assert.strictEqual(absent.status, 200);
      assert.match(absent.type, /application\/json/);
      assert.deepStrictEqual(JSON.parse(absent.body), {});
      fs.writeFileSync(file, '{ "Genesis 4:1": ');
      const bad = await get(port, '/api/mentions');
      assert.strictEqual(bad.status, 500);
      assert.match(JSON.parse(bad.body).error, /mentions\.json is not valid JSON/);
      fs.writeFileSync(file, '{ "Genesis 4:1": { "Eve": "eve" } }');
      const ok = await get(port, '/api/mentions');
      assert.strictEqual(ok.status, 200);
      assert.deepStrictEqual(JSON.parse(ok.body), { 'Genesis 4:1': { Eve: 'eve' } });
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
