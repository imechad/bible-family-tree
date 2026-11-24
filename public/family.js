/*
 * Shared family logic: derives children/siblings/spouses and unions
 * from people.json, searches people by anything attached to them, and turns
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
        if (pid === null || pid === undefined || pid === "unknown" || pid === "none") return;
        if (!byId.has(pid)) {
          problems.push(p.id + '.' + role + ' points to unknown id "' + pid + '"');
        } else if (pid === p.id) {
          problems.push(p.id + ' lists themself as ' + role);
        } else {
          childrenOf.get(pid).push(p.id);
        }
      });
    });

    // Spouse lists are read from BOTH sides and merged, so a one-sided entry
    // still renders as a marriage; validate() is what flags the asymmetry.
    var spousesOf = new Map();
    byId.forEach(function (p) { spousesOf.set(p.id, []); });
    byId.forEach(function (p) {
      if (p.spouses === undefined || p.spouses === null) return;
      if (!Array.isArray(p.spouses)) return; // reported by validate()
      p.spouses.forEach(function (sid) {
        if (sid === p.id) { problems.push(p.id + ' lists themself as a spouse'); return; }
        if (!byId.has(sid)) { problems.push(p.id + '.spouses points to unknown id "' + sid + '"'); return; }
        if (spousesOf.get(p.id).indexOf(sid) === -1) spousesOf.get(p.id).push(sid);
        if (spousesOf.get(sid).indexOf(p.id) === -1) spousesOf.get(sid).push(p.id);
      });
    });

    function parentsOf(p) {
      return {
        mom: (p.mom && p.mom !== "unknown" && p.mom !== "none" && byId.has(p.mom)) ? p.mom : null,
        dad: (p.dad && p.dad !== "unknown" && p.dad !== "none" && byId.has(p.dad)) ? p.dad : null
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

    // Lowercased display name -> person, for the filter builder's name lookups
    // ("children includes Briar" resolves the name to a person first). First
    // occurrence wins if two people share a name.
    var byName = new Map();
    byId.forEach(function (p) {
      // Synthetic test fixtures may lack a name — skip them.
      if (typeof p.name !== 'string' || !p.name) return;
      var key = p.name.toLowerCase();
      if (!byName.has(key)) byName.set(key, p);
    });
    return { byId: byId, byName: byName, childrenOf: childrenOf, siblingsOf: siblingsOf, spousesOf: spousesOf, problems: problems };
  }

  function isPositiveInt(n) {
    return typeof n === 'number' && Number.isInteger(n) && n > 0;
  }

  /** A generation is a positive integer, or "unknown" when scripture doesn't
   *  place the person (they're drawn in a trailing "Gen ?" band). */
  function isValidGeneration(g) {
    return isPositiveInt(g) || g === 'unknown';
  }

  /** Sort key: numbered generations in order, unknown after all of them. */
  function generationRank(g) {
    return isPositiveInt(g) ? g : Infinity;
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
      if (p.gender !== 'male' && p.gender !== 'female' && p.gender !== 'unknown') problems.push(who + ' gender must be "male", "female", or "unknown"');
      if (!isValidGeneration(p.generation)) problems.push(who + ' generation must be a positive integer or "unknown"');
      if (p.age !== null && p.age !== undefined && p.age !== "unknown" && !(typeof p.age === 'number' && isFinite(p.age) && p.age >= 0)) {
        problems.push(who + ' age must be a non-negative number, "unknown", or null');
      }
      [['mom', 'female'], ['dad', 'male']].forEach(function (pair) {
        var parent = p[pair[0]] ? index.byId.get(p[pair[0]]) : null;
        if (!parent) return;
        if (parent.gender !== 'unknown' && parent.gender !== pair[1]) problems.push(who + ' ' + pair[0] + ' "' + parent.id + '" is not ' + pair[1]);
        // A parent must sit in an earlier generation; this also rules out
        // ancestry loops, which would otherwise hang any tree walk.
        if (isPositiveInt(parent.generation) && isPositiveInt(p.generation) && parent.generation >= p.generation) {
          problems.push(who + ' is generation ' + p.generation + ' but ' + pair[0] + ' "' + parent.id +
            '" is generation ' + parent.generation + ' (parents must be in an earlier generation)');
        }
      });
      if (p.spouses !== undefined && p.spouses !== null) {
        if (!Array.isArray(p.spouses)) {
          problems.push(who + ' spouses must be an array of ids (use [] for none)');
        } else {
          var seenSpouse = new Set();
          p.spouses.forEach(function (sid) {
            if (seenSpouse.has(sid)) problems.push(who + ' lists spouse "' + sid + '" twice');
            seenSpouse.add(sid);
            var s = index.byId.get(sid);
            if (!s || sid === p.id) return; // already reported by buildIndex
            // Marriages are stored on both people so either record can be
            // read on its own; a one-sided link means someone forgot half.
            if (!Array.isArray(s.spouses) || s.spouses.indexOf(p.id) === -1) {
              problems.push(who + ' lists spouse "' + sid + '" but "' + sid + '" does not list ' + who + ' back');
            }
            // The tree puts the mom on the left and the dad on the right of
            // their junction, so a union needs exactly one of each to be drawable.
            if ((p.gender === 'male' || p.gender === 'female') && s.gender === p.gender) {
              problems.push(who + ' and spouse "' + sid + '" are both ' + p.gender + ' (a union needs a mom and a dad)');
            }
          });
        }
      }
      if (p.notes === undefined) return;
      // Validate list states
      ['childrenState', 'spousesState', 'siblingsState'].forEach(function (field) {
        // Absent state field defaults to "known" (list is authoritative) —
        // only flag people who wrote an unrecognised value.
        if (p[field] !== undefined && !['known', 'none', 'unknown'].includes(p[field])) {
          problems.push(who + ' ' + field + ' must be "known", "none", or "unknown"');
        }
      });

      // Validate consistency between list states and actual relationships
      if (p.childrenState === 'none') {
        // If someone claims to have no children, they shouldn't be anyone's parent
        var hasChildren = false;
        index.byId.forEach(function (other) {
          if (other.mom === p.id || other.dad === p.id) {
            hasChildren = true;
          }
        });
        if (hasChildren) {
          problems.push(who + ' claims childrenState="none" but is listed as a parent');
        }
      }

      // NOTE: parent="none" (a first-of-line founder) is fully compatible with
      // having children — "none" describes THIS person's parents, not their kids.
      // No validation rule is needed here; the marker simply never resolves to
      // a person id during index building.
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

  // ------------------------------------------------------------ unions

  /**
   * Derive the "unions" the tree draws, each with its own junction marker:
   * one per distinct (mom, dad) pair that is married or has a child
   * together, plus one per single parent. A remarried person therefore
   * belongs to several unions (and is drawn once per union).
   *
   * Derived (never stored) for the same reason children are: the data only
   * records parents and spouses, so unions can't disagree with them.
   *
   * `include(id)` lets the UI leave out people it can't place on a row;
   * a parent who is excluded is treated as unrecorded.
   *
   * Union order is meaningful: a remarried person's FIRST union is where
   * their own parents' child line lands, so spousal unions are created first
   * (in data order, then the order of each `spouses` list) and child-only
   * unions after.
   */
  function deriveUnions(index, include) {
    var ok = function (id) {
      return typeof id === 'string' && index.byId.has(id) && (!include || include(id));
    };
    var unions = [];
    var byKey = new Map();
    var unionsOf = new Map();
    function unionOf(mom, dad) {
      var key = (mom || '') + '|' + (dad || '');
      var u = byKey.get(key);
      if (!u) {
        u = { key: key, mom: mom, dad: dad, children: [] };
        byKey.set(key, u);
        unions.push(u);
        [mom, dad].forEach(function (id) {
          if (!id) return;
          if (!unionsOf.has(id)) unionsOf.set(id, []);
          unionsOf.get(id).push(u);
        });
      }
      return u;
    }

    index.byId.forEach(function (p) {
      if (!ok(p.id)) return;
      (index.spousesOf.get(p.id) || []).forEach(function (sid) {
        if (!ok(sid)) return;
        var s = index.byId.get(sid);
        // Same-gender or unknown-gender pairs can't fill a mom/dad slot;
        // validate() reports them, the tree just doesn't draw the union.
        if (p.gender === 'female' && s.gender === 'male') unionOf(p.id, sid);
        else if (p.gender === 'male' && s.gender === 'female') unionOf(sid, p.id);
      });
    });

    index.byId.forEach(function (p) {
      if (!ok(p.id)) return;
      var mom = ok(p.mom) && p.mom !== p.id ? p.mom : null;
      var dad = ok(p.dad) && p.dad !== p.id ? p.dad : null;
      if (mom || dad) unionOf(mom, dad).children.push(p.id);
    });

    return { unions: unions, byKey: byKey, unionsOf: unionsOf };
  }

  /**
   * Where a union's junction pill sits and which lines meet it. Pure
   * geometry (no DOM) so the drawing rules are unit-testable:
   *   - each parent gets one line from the bottom-centre of their card down
   *     to the top of the pill, tagged 'mom' or 'dad' so it can be drawn in
   *     that parent's gender colour;
   *   - each child gets one neutral line from the bottom of the pill up to
   *     the top-centre of their card;
   *   - a childless couple still gets the pill (the marriage stays visible)
   *     but no child lines.
   *
   * parents: { mom: {x,y}|null, dad: {x,y}|null } — bottom-centre of cards.
   * kids:    [{ id, x, y }] — top-centre of each child's card.
   * opts:    { drop, pillW, pillH } — pill top sits `drop` px below the
   *          lower parent card; sizes in px.
   */
  function junctionGeometry(parents, kids, opts) {
    var ps = [['mom', parents.mom], ['dad', parents.dad]].filter(function (e) { return e[1]; });
    if (!ps.length) return null;
    // Midway between the parents, so neither looks like the "main" one;
    // a single parent's junction sits straight below them.
    var cx = ps.reduce(function (s, e) { return s + e[1].x; }, 0) / ps.length;
    var top = Math.max.apply(null, ps.map(function (e) { return e[1].y; })) + opts.drop;
    var j = { x: cx - opts.pillW / 2, y: top, w: opts.pillW, h: opts.pillH, cx: cx };
    var lines = ps.map(function (e) {
      return { kind: e[0], x1: e[1].x, y1: e[1].y, x2: cx, y2: top + 2 };
    });
    (kids || []).forEach(function (k) {
      lines.push({ kind: 'child', id: k.id, x1: cx, y1: top + opts.pillH - 2, x2: k.x, y2: k.y });
    });
    return { junction: j, lines: lines };
  }

  // ------------------------------------------------------------ notes

  /**
   * Turn a person's notes into plain view objects, one per note, each with
   * its own linkified text, quotes and refs. Kept out of the DOM code so the
   * "every note stands alone with its own sources" rule is unit-testable.
   */
  function noteViews(person) {
    var raw = person && Array.isArray(person.notes) ? person.notes : [];
    var notes = raw.filter(function (n) { return n && typeof n.text === 'string'; });
    return notes.map(function (n, i) {
      var refs = Array.isArray(n.refs) ? n.refs.filter(function (r) { return typeof r === 'string' && r.trim(); }) : [];
      var quotes = Array.isArray(n.quotes) ? n.quotes.filter(function (q) { return q && typeof q.text === 'string'; }) : [];
      return {
        number: i + 1,
        total: notes.length,
        segments: splitRefs(n.text).map(function (seg) {
          return seg.type === 'ref' ? { type: 'ref', value: seg.value, url: bibleUrl(seg.value) } : seg;
        }),
        quotes: quotes.map(function (q) {
          var ref = typeof q.ref === 'string' && q.ref ? q.ref : null;
          return { ref: ref, text: q.text, url: ref ? bibleUrl(ref) : null };
        }),
        refs: refs.map(function (r) { return { ref: r, url: bibleUrl(r) }; })
      };
    });
  }

  // ------------------------------------------------------------ search

  function fold(s) {
    // Accent-insensitive so "Ysolde" is found by "ysolde" and, later,
    // transliterated names match with or without diacritics.
    return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }

  // Aliases are generous because people type what they'd say out loud
  // ("child:", "wife:"); each maps to one canonical field.
  var PREFIXES = {
    kid: 'kid', kids: 'kid', child: 'kid', children: 'kid',
    mom: 'mom', mother: 'mom', dad: 'dad', father: 'dad',
    spouse: 'spouse', spouses: 'spouse', wife: 'spouse', husband: 'spouse',
    sibling: 'sibling', siblings: 'sibling', sib: 'sibling',
    gen: 'gen', generation: 'gen', gender: 'gender', sex: 'gender',
    age: 'age', name: 'name', note: 'notes', notes: 'notes'
  };

  /**
   * "kid:Briar, Wick, mom:Lisska" -> [{field:'kid',value:'briar'},
   * {field:'kid',value:'wick'}, {field:'mom',value:'lisska'}].
   * A prefix carries over to later unprefixed values, so a list after one
   * prefix stays in that role. Only known prefix words count, which keeps
   * free text like "Genesis 4:25" from being mistaken for a field.
   */
  function parseQuery(query) {
    var field = 'any';
    var terms = [];
    String(query || '').split(',').forEach(function (seg) {
      var raw = seg.trim();
      var m = /^([a-z]+)\s*:\s*(.*)$/i.exec(raw);
      if (m && PREFIXES[m[1].toLowerCase()]) {
        field = PREFIXES[m[1].toLowerCase()];
        raw = m[2].trim();
      }
      if (raw) terms.push({ field: field, raw: raw, value: fold(raw) });
    });
    return terms;
  }

  // Lower rank sorts first: someone whose own name matches is the most
  // likely target, a relative match next, then attributes, then note text.
  // A typed name that only appears mid-word ("wick" in "Fenwick") is a
  // weaker hit than one starting a word, so it sorts after relatives.
  var FIELD_RANK = { name: 0, kid: 1, mom: 1, dad: 1, spouse: 1, sibling: 1, namePart: 1.5, gen: 2, gender: 2, age: 2, notes: 3 };

  function numberMatches(n, v) {
    if (typeof n !== 'number') return false;
    var range = /^(\d+)\s*-\s*(\d+)$/.exec(v);
    if (range) return n >= Number(range[1]) && n <= Number(range[2]);
    return /^\d+$/.test(v) && n === Number(v);
  }

  /** Index of v in folded text, only at the start of a word. Used for
   *  relatives and notes, where plain substring matching snowballs: "male"
   *  would hit "female", and "wick" would pull in every relative of Fenwick. */
  function wordStart(foldedText, v) {
    var at = foldedText.indexOf(v);
    while (at !== -1) {
      if (at === 0 || !/[a-z0-9]/.test(foldedText.charAt(at - 1))) return at;
      at = foldedText.indexOf(v, at + 1);
    }
    return -1;
  }

  function snippet(text, at, len) {
    var start = Math.max(0, at - 18);
    var end = Math.min(text.length, at + len + 18);
    // Snap to word boundaries so the snippet doesn't start with "…: Sec".
    if (start > 0) { var sp = text.lastIndexOf(' ', at); start = sp >= start ? sp + 1 : at; }
    if (end < text.length) { var ep = text.indexOf(' ', end); end = ep === -1 ? text.length : ep; }
    return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
  }

  /**
   * Free-text / field search over everything attached to a person.
   * Returns [{ person, rank, reasons: [{ field, term, label, text? }] }],
   * where each reason says WHY the person matched (e.g. "kid: Lisska Arlo")
   * so a parent found through a child's name doesn't look like a name hit.
   * With an empty query everyone is returned with no reasons.
   */
  function search(people, index, query) {
    var terms = parseQuery(query);
    var nameOf = function (id) {
      var p = index.byId.get(id);
      return p && typeof p.name === 'string' && p.name.trim() ? p.name : id;
    };
    var order = new Map(people.map(function (p, i) { return [p.id, i]; }));
    var out = [];

    people.forEach(function (p) {
      var reasons = [];
      var seen = new Set();
      function add(field, term, label, text) {
        if (seen.has(label)) return;
        seen.add(label);
        reasons.push({ field: field, term: term.raw, label: label, text: text || null });
      }
      function relatives(field, ids, term) {
        ids.forEach(function (id) {
          if (!index.byId.has(id)) return;
          var n = nameOf(id);
          if (wordStart(fold(n), term.value) !== -1) add(field, term, field + ': ' + n, n);
        });
      }

      terms.forEach(function (t) {
        var v = t.value;
        var any = t.field === 'any';
        // A bare number is almost always a generation or age; matching it
        // against note text would hit every "Genesis 5:3" and drown them.
        var numeric = /^\d+(\s*-\s*\d+)?$/.test(v);
        if (any && numeric) {
          if (/^\d+$/.test(v) && numberMatches(p.generation, v)) add('gen', t, 'gen ' + p.generation);
          if (/^\d+$/.test(v) && numberMatches(p.age, v)) add('age', t, 'age ' + p.age);
          return;
        }
        if (any || t.field === 'name') {
          var own = nameOf(p.id);
          // Own name keeps plain substring matching (as the search always
          // has), but a mid-word hit ranks below a word-start one.
          if (wordStart(fold(own), v) !== -1) add('name', t, 'name', own);
          else if (fold(own).indexOf(v) !== -1) add('namePart', t, 'name', own);
        }
        if (t.field === 'gen' && numberMatches(p.generation, v)) add('gen', t, 'gen ' + p.generation);
        if (t.field === 'age' && numberMatches(p.age, v)) add('age', t, 'age ' + p.age);
        // Free text needs the whole word ("female"), the prefix accepts a
        // start ("gender:f") — otherwise every "f…" name query lists all women.
        if (typeof p.gender === 'string' &&
            ((any && v === p.gender) || (t.field === 'gender' && p.gender.indexOf(v) === 0))) {
          add('gender', t, 'gender: ' + p.gender);
        }
        if (any || t.field === 'mom') relatives('mom', [p.mom], t);
        if (any || t.field === 'dad') relatives('dad', [p.dad], t);
        if (any || t.field === 'kid') relatives('kid', index.childrenOf.get(p.id) || [], t);
        if (any || t.field === 'spouse') relatives('spouse', index.spousesOf.get(p.id) || [], t);
        if (any || t.field === 'sibling') {
          relatives('sibling', (index.siblingsOf.get(p.id) || []).map(function (s) { return s.id; }), t);
        }
        if (any || t.field === 'notes') {
          var found = false;
          var quote = null;
          (Array.isArray(p.notes) ? p.notes : []).some(function (n) {
            if (!n) return false;
            var texts = [n.text].concat((n.quotes || []).map(function (q) { return q && q.text; }), n.refs || []);
            return texts.some(function (tx) {
              if (typeof tx !== 'string') return false;
              var folded = fold(tx);
              var at = wordStart(folded, v);
              if (at === -1) return false;
              found = true;
              // fold() can change length for some scripts; only quote a
              // snippet when offsets still line up with the original.
              if (folded.length === tx.length) quote = snippet(tx, at, v.length);
              return true;
            });
          });
          if (found) add('notes', t, quote ? 'notes: “' + quote + '”' : 'notes');
        }
      });

      if (terms.length && !reasons.length) return;
      var rank = reasons.reduce(function (r, x) { return Math.min(r, FIELD_RANK[x.field]); }, 9);
      // Callers only care that it was a name hit, not how strong it was.
      reasons.forEach(function (x) { if (x.field === 'namePart') x.field = 'name'; });
      out.push({ person: p, reasons: reasons, rank: terms.length ? rank : 0 });
    });

    // Stable within a rank: by generation, then data order (= birth order).
    return out.sort(function (a, b) {
      var ga = generationRank(a.person.generation), gb = generationRank(b.person.generation);
      return a.rank - b.rank || (ga === gb ? 0 : ga - gb) ||
        order.get(a.person.id) - order.get(b.person.id);
    });
  }


  // ---------------------------------------------------------------- filter builder

  /*
   * Each row is { field, operator, value, value2 }. Field ids and operator ids
   * (the owner's spec; fields without modes ignore `operator`):
   *   name                      — contains over the person's name
   *   generation, age           — 'is' | 'between' | 'isUnknown'
   *   gender                    — value 'male' | 'female' | 'unknown' ('' = any)
   *   mom, dad                  — contains over the parent's name
   *   child, sibling, spouse    — 'amount' | 'amountRange' | 'name'
   *   notes                     — 'hasNote' | 'noNote' | 'noteContains'
   * Blank text / blank exact numbers make a row inert (matches everyone);
   * junk in an exact number box matches no one; a blank or junk range side is
   * unbounded. Bounds are inclusive and applied as typed (never swapped).
   */

  function personName(p) { return p && typeof p.name === 'string' && p.name.trim() ? p.name : (p && p.id) || ''; }

  function queryOf(v) { return v === null || v === undefined ? '' : String(v).trim().toLowerCase(); }

  function containsQuery(text, q) { return String(text || '').toLowerCase().indexOf(q) !== -1; }

  function isBlank(v) { return v === null || v === undefined || String(v).trim() === ''; }

  function isUnknownValue(v) { return v === 'unknown' || v === null || v === undefined; }

  /** Exact numeric test for an 'is' / 'amount' box: blank -> inert (null),
   *  junk -> matches nothing, otherwise strict equality. */
  function exactNumber(actual, v) {
    if (isBlank(v)) return true;
    var n = Number(String(v).trim());
    if (!isFinite(n)) return false;
    return typeof actual === 'number' && actual === n;
  }

  /** Inclusive range for 'between' / 'amountRange'; blank/junk side = unbounded. */
  function inRange(actual, lo, hi) {
    if (typeof actual !== 'number' || !isFinite(actual)) return false;
    var a = bound(lo), b = bound(hi);
    if (a === null && b === null) return true;
    if (a !== null && actual < a) return false;
    if (b !== null && actual > b) return false;
    return true;
  }

  var LIST_INDEX = { child: 'childrenOf', sibling: 'siblingsOf', spouse: 'spousesOf' };

  function matchName(person, value) {
    var q = queryOf(value);
    return !q || containsQuery(personName(person), q);
  }

  function matchGeneration(person, operator, value, value2) {
    var gen = person.generation;
    switch (operator) {
      case 'is': return exactNumber(isPositiveInt(gen) ? gen : null, value);
      case 'between':
        if (bound(value) === null && bound(value2) === null) return true;
        return isPositiveInt(gen) && inRange(gen, value, value2);
      case 'isUnknown': return gen === 'unknown';
      default: return true;
    }
  }

  function matchGender(person, value) {
    if (isBlank(value)) return true;
    return (person.gender || 'unknown') === value;
  }

  function matchAge(person, operator, value, value2) {
    var age = person.age;
    switch (operator) {
      case 'is': return exactNumber(age, value);
      case 'between':
        // Both sides blank = inert, so a fresh range row doesn't hide anyone.
        if (bound(value) === null && bound(value2) === null) return true;
        return inRange(age, value, value2);
      case 'isUnknown': return isUnknownValue(age);
      default: return true;
    }
  }

  function matchParent(person, index, role, value) {
    var q = queryOf(value);
    if (!q) return true;
    var id = person[role];
    if (typeof id !== 'string' || id === 'unknown' || id === 'none') return false;
    var parent = index.byId.get(id);
    return !!parent && containsQuery(personName(parent), q);
  }

  function matchList(person, index, field, operator, value, value2) {
    var ids = index[LIST_INDEX[field]].get(person.id) || [];
    switch (operator) {
      case 'amount': return exactNumber(ids.length, value);
      case 'amountRange': return inRange(ids.length, value, value2);
      case 'name':
        var q = queryOf(value);
        if (!q) return true;
        return ids.some(function (entry) {
          // siblingsOf holds { id, kind } entries; the other lists hold ids.
          var other = index.byId.get(entry && typeof entry === 'object' ? entry.id : entry);
          return !!other && containsQuery(personName(other), q);
        });
      default: return true;
    }
  }

  function matchNotes(person, operator, value) {
    switch (operator) {
      case 'hasNote': return noteViews(person).length > 0;
      case 'noNote': return noteViews(person).length === 0;
      case 'noteContains':
        var q = queryOf(value);
        if (!q) return true;
        var raw = person && Array.isArray(person.notes) ? person.notes : [];
        return raw.some(function (n) { return n && typeof n.text === 'string' && containsQuery(n.text, q); });
      default: return true;
    }
  }

  /** One row against one person. Unknown fields/operators match everyone. */
  function matchRow(person, index, row) {
    if (!row || !row.field) return true;
    switch (row.field) {
      case 'name': return matchName(person, row.value);
      case 'generation': return matchGeneration(person, row.operator, row.value, row.value2);
      case 'gender': return matchGender(person, row.value);
      case 'age': return matchAge(person, row.operator, row.value, row.value2);
      case 'mom':
      case 'dad': return matchParent(person, index, row.field, row.value);
      case 'child':
      case 'sibling':
      case 'spouse': return matchList(person, index, row.field, row.operator, row.value, row.value2);
      case 'notes': return matchNotes(person, row.operator, row.value);
      default: return true;
    }
  }

  /** True when a row narrows the list at all (drives the badge). Mirrors the
   *  inert rules above: blank boxes don't count, value-less modes always do. */
  function rowIsActive(row) {
    if (!row || !row.field) return false;
    switch (row.field) {
      case 'generation':
      case 'age':
        if (row.operator === 'isUnknown') return true;
        if (row.operator === 'between') return bound(row.value) !== null || bound(row.value2) !== null;
        return row.operator === 'is' && !isBlank(row.value);
      case 'child':
      case 'sibling':
      case 'spouse':
        if (row.operator === 'amountRange') return bound(row.value) !== null || bound(row.value2) !== null;
        return (row.operator === 'amount' || row.operator === 'name') && !isBlank(row.value);
      case 'notes':
        if (row.operator === 'hasNote' || row.operator === 'noNote') return true;
        return row.operator === 'noteContains' && !isBlank(row.value);
      case 'name':
      case 'gender':
      case 'mom':
      case 'dad':
        return !isBlank(row.value);
      default: return false;
    }
  }

  /** Filter by multiple condition rows. Each row must match (AND). */
  function filterByRows(people, index, rows) {
    if (!rows || rows.length === 0) return people;
    return people.filter(function (person) {
      return rows.every(function (row) { return matchRow(person, index, row); });
    });
  }

  // ---------------------------------------------------------------- filters

  /** Filter-panel state with nothing set. Blank strings (not null) for the
   *  number inputs so the UI can round-trip whatever the user typed. */
  function emptyFilters() {
    return { gen: '', gender: '', ageMin: '', ageMax: '', hasNotes: false, hasChildren: false, hasSpouse: false };
  }

  // Blank or junk in a number box means "no bound" rather than "match
  // nothing", so a half-typed "-" never empties the list.
  function bound(v) {
    if (v === '' || v === null || v === undefined) return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  /** How many filters are on. Age range counts once however many ends are
   *  set, because the badge answers "how many reasons is my list shorter". */
  function activeFilterCount(f) {
    if (!f) return 0;
    return (f.gen !== '' && f.gen !== null && f.gen !== undefined ? 1 : 0) +
      (f.gender ? 1 : 0) +
      (bound(f.ageMin) !== null || bound(f.ageMax) !== null ? 1 : 0) +
      (f.hasNotes ? 1 : 0) + (f.hasChildren ? 1 : 0) + (f.hasSpouse ? 1 : 0);
  }

  /** True when the person passes EVERY active filter (AND). */
  function matchesFilters(p, index, f) {
    if (!f) return true;
    if (f.gen !== '' && f.gen !== null && f.gen !== undefined && p.generation !== Number(f.gen)) return false;
    if (f.gender && p.gender !== f.gender) return false;
    var lo = bound(f.ageMin), hi = bound(f.ageMax);
    if (lo !== null || hi !== null) {
      // Someone whose age scripture doesn't give can't be shown to be in
      // range, so an age filter excludes them rather than guessing.
      if (typeof p.age !== 'number' || !isFinite(p.age)) return false;
      // Bounds apply as typed, never swapped: filtering is live, so swapping
      // would make the list jump around while a min is still being typed.
      if (lo !== null && p.age < lo) return false;
      if (hi !== null && p.age > hi) return false;
    }
    // Same rule noteViews() uses, so the filter and the ⓘ icon never disagree.
    if (f.hasNotes && !(Array.isArray(p.notes) && p.notes.some(function (n) { return n && typeof n.text === 'string'; }))) return false;
    if (f.hasChildren && !((index.childrenOf.get(p.id) || []).length)) return false;
    if (f.hasSpouse && !((index.spousesOf.get(p.id) || []).length)) return false;
    return true;
  }

  /** Text search narrowed by the filter panel; keeps search()'s order and
   *  match reasons untouched. */
  function filterSearch(people, index, query, filters) {
    return search(people, index, query).filter(function (m) { return matchesFilters(m.person, index, filters); });
  }

  return {
    BOOKS: BOOKS,
    isValidRef: isValidRef,
    isPositiveInt: isPositiveInt,
    bibleUrl: bibleUrl,
    splitRefs: splitRefs,
    buildIndex: buildIndex,
    validate: validate,
    deriveUnions: deriveUnions,
    junctionGeometry: junctionGeometry,
    noteViews: noteViews,
    fold: fold,
    parseQuery: parseQuery,
    search: search,
    emptyFilters: emptyFilters,
    activeFilterCount: activeFilterCount,
    matchesFilters: matchesFilters,
    filterByRows: filterByRows,
    rowIsActive: rowIsActive,
    isValidGeneration: isValidGeneration,
    generationRank: generationRank,
    filterSearch: filterSearch
  };
});
