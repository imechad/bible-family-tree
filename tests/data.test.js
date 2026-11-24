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

test('spouse links exist, are mutual, and pair a female with a male', () => {
  const byId = new Map(people.map((p) => [p.id, p]));
  for (const p of people) {
    assert.strictEqual(new Set(p.spouses).size, p.spouses.length, `${p.id}: duplicate spouse id`);
    for (const sid of p.spouses) {
      const s = byId.get(sid);
      assert(s, `${p.id}.spouses -> "${sid}" does not exist`);
      assert.notStrictEqual(sid, p.id, `${p.id} is their own spouse`);
      assert(s.spouses.includes(p.id), `${p.id} lists ${sid} as spouse but ${sid} does not list ${p.id}`);
      assert.notStrictEqual(s.gender, p.gender, `${p.id} and ${sid} are both ${p.gender}`);
    }
  }
});

test('demo data exercises remarriage, a childless couple, and multi-note people', () => {
  const idx = Family.buildIndex(people);
  const fb = Family.deriveUnions(idx);
  // Remarriage: someone with 2+ spouses who has children in 2+ of those unions.
  const remarried = people.filter((p) => p.spouses.length >= 2 &&
    (fb.unionsOf.get(p.id) || []).filter((b) => b.mom && b.dad && b.children.length).length >= 2);
  assert(remarried.length >= 1, 'need at least one remarried person with children by two spouses');
  assert(fb.unions.some((b) => b.mom && b.dad && b.children.length === 0), 'need a married couple with no children');
  assert(fb.unions.some((b) => !(b.mom && b.dad) && b.children.length), 'need a single-parent family');
  assert(people.filter((p) => p.notes.length >= 2).length >= 3, 'need at least three people with 2+ notes');
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

test('validate enforces spouse symmetry, existence, and gender pairing', () => {
  const base = (id, gender, spouses) => ({ id, name: id, gender, generation: 1, age: null, mom: null, dad: null, spouses, notes: [] });
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
    assert.strictEqual(n, p.mom || p.dad ? 1 : 0, `${p.id} hangs from ${n} unions`);
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
  const idx = Family.buildIndex(people);
  const names = (q) => Family.search(people, idx, q).map((r) => r.person.id);
  const why = (q, id) => Family.search(people, idx, q).find((r) => r.person.id === id).reasons.map((r) => r.label);

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
  const idx = Family.buildIndex(people);
  const names = (q) => Family.search(people, idx, q).map((r) => r.person.id);

  // A list after one prefix stays in that role.
  assert.deepStrictEqual(names('kid:Briar, Wick').sort(), ['pim-vell', 'thistle-arlo']);
  assert.deepStrictEqual(Family.parseQuery('kid:Briar, Wick, mom: Lisska, Genesis 4:25,'), [
    { field: 'kid', raw: 'Briar', value: 'briar' }, { field: 'kid', raw: 'Wick', value: 'wick' },
    { field: 'mom', raw: 'Lisska', value: 'lisska' }, { field: 'mom', raw: 'Genesis 4:25', value: 'genesis 4:25' }
  ]);
  // Unknown words before a colon are not prefixes (scripture refs stay free text).
  assert.deepStrictEqual(Family.parseQuery('Genesis 4:25'), [{ field: 'any', raw: 'Genesis 4:25', value: 'genesis 4:25' }]);

  // Free-text list: every listed name and its relatives; own-name hits first.
  const list = Family.search(people, idx, 'Briar, Wick');
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
  const orchard = Family.search(people, idx, 'orchard');
  assert(orchard.some((r) => r.person.id === 'garrow-vell'));
  assert(orchard.every((r) => r.reasons[0].field === 'notes' && r.reasons[0].label.includes('orchard')));

  // Empty query: everyone, no reasons, generation order.
  const all = Family.search(people, idx, '  , ');
  assert.strictEqual(all.length, people.length);
  assert(all.every((r, i) => !r.reasons.length && (i === 0 || all[i - 1].person.generation <= r.person.generation)));
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

  // And in the real data, a multi-note person gets one view per stored note.
  const taddeo = people.find((p) => p.id === 'taddeo-vell');
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
  assert.match(page.body, /kid:/, 'search hint documenting the prefixes should be on the page');
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
