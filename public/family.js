/*
 * Shared family logic: derives children/siblings from people.json and turns
 * scripture references into links.
 *
 * Loaded by the browser (as window.Family) AND required by the Node tests, so
 * the tests exercise the exact same derivation the UI renders — a bug can't
 * hide in a test-only copy of the logic.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Family = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // All 66 Protestant canon book names as BibleGateway accepts them. Kept
  // here so ref validation (tests) and inline ref linking (UI) agree on what
  // counts as a real reference.
  var BOOKS = [
    'Genesis', 'Exodus', 'Leviticus', 'Numbers', 'Deuteronomy', 'Joshua', 'Judges', 'Ruth',
    '1 Samuel', '2 Samuel', '1 Kings', '2 Kings', '1 Chronicles', '2 Chronicles', 'Ezra',
    'Nehemiah', 'Esther', 'Job', 'Psalms', 'Psalm', 'Proverbs', 'Ecclesiastes', 'Song of Solomon',
    'Isaiah', 'Jeremiah', 'Lamentations', 'Ezekiel', 'Daniel', 'Hosea', 'Joel', 'Amos',
    'Obadiah', 'Jonah', 'Micah', 'Nahum', 'Habakkuk', 'Zephaniah', 'Haggai', 'Zechariah',
    'Malachi', 'Matthew', 'Mark', 'Luke', 'John', 'Acts', 'Romans', '1 Corinthians',
    '2 Corinthians', 'Galatians', 'Ephesians', 'Philippians', 'Colossians', '1 Thessalonians',
    '2 Thessalonians', '1 Timothy', '2 Timothy', 'Titus', 'Philemon', 'Hebrews', 'James',
    '1 Peter', '2 Peter', '1 John', '2 John', '3 John', 'Jude', 'Revelation'
  ];

  // Longest names first so "1 John" wins over "John" and "Psalms" over "Psalm".
  var bookAlt = BOOKS.slice()
    .sort(function (a, b) { return b.length - a.length; })
    .map(function (b) { return b.replace(/ /g, '\\s'); })
    .join('|');
  // Chapter, optional :verse, optional -verse or -chapter:verse range.
  var REF_BODY = '(?:' + bookAlt + ')\\s\\d{1,3}(?::\\d{1,3}(?:[-–]\\d{1,3}(?::\\d{1,3})?)?)?';
  var REF_EXACT = new RegExp('^' + REF_BODY + '$');

  function isValidRef(ref) {
    return typeof ref === 'string' && REF_EXACT.test(ref.trim());
  }

  function bibleUrl(ref) {
    return 'https://www.biblegateway.com/passage/?search=' +
      encodeURIComponent(ref.trim()) + '&version=KJV';
  }

  /**
   * Split free text into plain-text and reference segments so the UI can
   * linkify refs without ever building HTML from data (no injection surface).
   */
  function splitRefs(text) {
    var re = new RegExp('\\b' + REF_BODY + '\\b', 'g');
    var out = [];
    var last = 0;
    var m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) out.push({ type: 'text', value: text.slice(last, m.index) });
      out.push({ type: 'ref', value: m[0] });
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push({ type: 'text', value: text.slice(last) });
    return out;
  }

  /**
   * Build lookup indexes from the flat people array.
   *
   * Children and siblings are derived here rather than stored in the JSON so
   * that a data editor only ever records "who are my parents" — one fact in
   * one place, which can't drift out of sync with a second copy.
   *
   * Never throws on bad data: problems are collected so the UI can show a
   * warning and the tests can fail with a precise message.
   */
  function buildIndex(people) {
    var problems = [];
    var byId = new Map();
    var childrenOf = new Map();
    var list = Array.isArray(people) ? people : [];
    if (!Array.isArray(people)) problems.push('people.json must contain a JSON array');

    list.forEach(function (p, i) {
      if (!p || typeof p !== 'object') { problems.push('Entry #' + i + ' is not an object'); return; }
      if (typeof p.id !== 'string' || !p.id) { problems.push('Entry #' + i + ' has no string id'); return; }
      if (byId.has(p.id)) { problems.push('Duplicate id "' + p.id + '"'); return; }
      byId.set(p.id, p);
      childrenOf.set(p.id, []);
    });

    byId.forEach(function (p) {
      ['mom', 'dad'].forEach(function (role) {
        var pid = p[role];
        if (pid === null || pid === undefined) return;
        if (!byId.has(pid)) {
          problems.push(p.id + '.' + role + ' points to unknown id "' + pid + '"');
        } else if (pid === p.id) {
          problems.push(p.id + ' lists themself as ' + role);
        } else {
          childrenOf.get(pid).push(p.id);
        }
      });
    });

    function parentsOf(p) {
      return {
        mom: p.mom && byId.has(p.mom) ? p.mom : null,
        dad: p.dad && byId.has(p.dad) ? p.dad : null
      };
    }

    // Siblings = anyone sharing at least one known parent. Recording *which*
    // parent is shared lets the UI tell full siblings from half-siblings,
    // which matters a lot once real genealogies (multiple wives) arrive.
    var siblingsOf = new Map();
    byId.forEach(function (p) {
      var mine = parentsOf(p);
      var seen = new Map();
      [mine.mom, mine.dad].forEach(function (pid) {
        if (!pid) return;
        childrenOf.get(pid).forEach(function (cid) {
          if (cid === p.id || seen.has(cid)) return;
          var theirs = parentsOf(byId.get(cid));
          var sameMom = !!mine.mom && mine.mom === theirs.mom;
          var sameDad = !!mine.dad && mine.dad === theirs.dad;
          var kind;
          if (sameMom && sameDad) kind = 'full';
          // Only call it "half" when both other parents are known and differ;
          // if either is unrecorded we genuinely don't know.
          else if (sameMom) kind = mine.dad && theirs.dad ? 'half-maternal' : 'maternal';
          else kind = mine.mom && theirs.mom ? 'half-paternal' : 'paternal';
          seen.set(cid, kind);
        });
      });
      siblingsOf.set(p.id, Array.from(seen, function (e) { return { id: e[0], kind: e[1] }; }));
    });

    return { byId: byId, childrenOf: childrenOf, siblingsOf: siblingsOf, problems: problems };
  }

  function isPositiveInt(n) {
    return typeof n === 'number' && Number.isInteger(n) && n > 0;
  }

  /**
   * Field-level checks on top of buildIndex's structural ones. Returns a list
   * of human-readable problems; the UI shows them as a warning (and still
   * renders whatever it can), the tests fail on any of them.
   */
  function validate(people, index) {
    index = index || buildIndex(people);
    var problems = index.problems.slice();
    index.byId.forEach(function (p) {
      var who = '"' + p.id + '"';
      if (typeof p.name !== 'string' || !p.name.trim()) problems.push(who + ' has no name');
      if (p.gender !== 'male' && p.gender !== 'female') problems.push(who + ' gender must be "male" or "female"');
      if (!isPositiveInt(p.generation)) problems.push(who + ' generation must be a positive integer');
      if (p.age !== null && p.age !== undefined && !(typeof p.age === 'number' && isFinite(p.age) && p.age >= 0)) {
        problems.push(who + ' age must be a non-negative number or null');
      }
      [['mom', 'female'], ['dad', 'male']].forEach(function (pair) {
        var parent = p[pair[0]] ? index.byId.get(p[pair[0]]) : null;
        if (!parent) return;
        if (parent.gender !== pair[1]) problems.push(who + ' ' + pair[0] + ' "' + parent.id + '" is not ' + pair[1]);
        // A parent must sit in an earlier generation; this also rules out
        // ancestry loops, which would otherwise hang any tree walk.
        if (isPositiveInt(parent.generation) && isPositiveInt(p.generation) && parent.generation >= p.generation) {
          problems.push(who + ' is generation ' + p.generation + ' but ' + pair[0] + ' "' + parent.id +
            '" is generation ' + parent.generation + ' (parents must be in an earlier generation)');
        }
      });
      if (p.notes === undefined) return;
      if (!Array.isArray(p.notes)) { problems.push(who + ' notes must be an array'); return; }
      p.notes.forEach(function (n, i) {
        var where = who + ' note #' + (i + 1);
        if (!n || typeof n.text !== 'string' || !n.text.trim()) problems.push(where + ' has no text');
        if (!n || !Array.isArray(n.refs) || n.refs.length === 0) {
          problems.push(where + ' must cite at least one ref');
          return;
        }
        n.refs.forEach(function (r) {
          if (!isValidRef(r)) problems.push(where + ' has unrecognised ref "' + r + '"');
        });
        if (n.quotes === undefined) return;
        if (!Array.isArray(n.quotes)) { problems.push(where + ' quotes must be an array'); return; }
        n.quotes.forEach(function (q) {
          if (!q || typeof q.text !== 'string' || !q.text.trim()) problems.push(where + ' has a quote with no text');
          // Every quoted verse must also be listed in refs, so refs stays the
          // single complete "where did this come from" list for the note.
          if (!q || n.refs.indexOf(q.ref) === -1) problems.push(where + ' quotes "' + (q && q.ref) + '" which is not in its refs');
        });
      });
    });
    return problems;
  }

  return {
    BOOKS: BOOKS,
    isValidRef: isValidRef,
    isPositiveInt: isPositiveInt,
    bibleUrl: bibleUrl,
    splitRefs: splitRefs,
    buildIndex: buildIndex,
    validate: validate
  };
});
