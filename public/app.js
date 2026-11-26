/* Bible Family Tree Explorer — browser app. Depends on family.js (window.Family). */
(function () {
  'use strict';

  var F = window.Family;

  // Card geometry. Rows leave a tall gap below each union so the parent
  // lines, the junction pill and the children's fan-out all have room and
  // don't run through names.
  var NODE_W = 180;
  var NODE_H = 62;
  var COUPLE_GAP = 44;  // between mom and dad: wide enough that the junction visibly sits between them
  var UNIT_GAP = 22;    // between siblings' unions/cards
  var FAMILY_GAP = 48;  // between different sibling groups
  var ROW_GAP = 150;    // clear space between one row's cards and the next
  var ROW_H = NODE_H + ROW_GAP;
  // The junction pill sits a little above the middle of the gap, so the
  // children's fan-out (usually wider) gets the longer, less steep run.
  var JUNCTION = { drop: 52, pillW: 14, pillH: 30 };
  var MARGIN_LEFT = 52; // room for the vertical "Gen N" labels
  var MARGIN = 30;
  var ZOOM_MIN = 0.35;
  var ZOOM_MAX = 1.6;

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    filtersBtn: $('filters-btn'),
    filtersBadge: $('filters-badge'),
    filterPanel: $('filter-panel'),
    filterBackdrop: $('filter-backdrop'),
    filterClose: $('filter-close'),
    filterReset: $('filter-reset'),
    filterCount: $('filter-count'),
    filterRows: $('filter-rows'),
    addFilterRow: $('add-filter-row'),
    clearFilters: $('clear-filters'),
    warning: $('data-warning'),
    resultsPane: $('results-pane'),
    results: $('results'),
    resultsCount: $('results-count'),
    resultsToggle: $('results-toggle'),
    viewport: $('viewport'),
    sizer: $('sizer'),
    canvas: $('canvas'),
    links: $('links'),
    nodes: $('nodes'),
    status: $('status'),
    detail: $('detail'),
    detailBody: $('detail-body'),
    detailClose: $('detail-close'),
    bibleBtn: $('bible-btn'),
    readerPanel: $('reader-panel'),
    readerBackdrop: $('reader-backdrop'),
    readerClose: $('reader-close'),
    readerBook: $('reader-book'),
    readerPrev: $('reader-prev'),
    readerNext: $('reader-next'),
    readerWhere: $('reader-where'),
    readerBody: $('reader-body')
  };

  var state = {
    index: null,
    people: [],       // renderable people, in data order
    layout: null,     // { instances: Map(id -> [{x,y}]), unions: [], width, height, ... }
    nodeEls: new Map(),   // id -> [card elements]; a remarried person has one per union
    unionEls: [],     // [{ els: [svg nodes], members: [ids] }] for highlight toggling
    selectedId: null,
    zoom: 1,
    // data/mentions.json: { "<Book C:V>": { "<display name>": "<person id>" } }.
    // Resolves repeated names in later verses; absent = empty.
    mentions: {}
  };

  var narrowMQ = window.matchMedia('(max-width: 820px)');

  // ---------------------------------------------------------------- helpers

  /** Tiny DOM builder. Text always goes through textContent, never innerHTML,
   *  because people.json will be hand-edited and must not be able to inject markup. */
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? '' : v);
      });
    }
    (children || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  var fold = F.fold;

  function displayName(p) { return p.name && String(p.name).trim() ? p.name : p.id; }
  function notesOf(p) { return Array.isArray(p.notes) ? p.notes.filter(function (n) { return n && typeof n.text === 'string'; }) : []; }
  function ageText(p) { return typeof p.age === 'number' && isFinite(p.age) ? String(p.age) : null; }
  function genderLabel(g) { return g === 'male' ? 'Male' : g === 'female' ? 'Female' : 'Unknown'; }
  function genderMark(g) { return g === 'male' ? '♂ ' : g === 'female' ? '♀ ' : '? '; }

  function refLink(ref, label) {
    return el('a', {
      class: 'ref-link',
      href: F.bibleUrl(ref),
      target: '_blank',
      rel: 'noopener noreferrer',
      title: 'Open ' + ref + ' (KJV) on BibleGateway',
      text: (label || ref) + ' ↗'
    });
  }

  var SVG_NS = 'http://www.w3.org/2000/svg';

  /** Drawn icons instead of emoji: emoji render differently on every
   *  platform (and as colourful clip-art on iOS), while an inline SVG in
   *  currentColor stays crisp at any zoom and matches the UI's palette. */
  function icon(name, paths) {
    var s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('class', 'icon icon-' + name);
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('focusable', 'false');
    paths.forEach(function (d) {
      var n = document.createElementNS(SVG_NS, d[0]);
      Object.keys(d[1]).forEach(function (k) { n.setAttribute(k, d[1][k]); });
      s.appendChild(n);
    });
    return s;
  }
  function infoIcon() {
    return icon('info', [
      ['circle', { cx: 12, cy: 12, r: 10, fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }],
      ['circle', { cx: 12, cy: 7.6, r: 1.45, fill: 'currentColor' }],
      ['rect', { x: 10.85, y: 10.4, width: 2.3, height: 7.4, rx: 1.15, fill: 'currentColor' }]
    ]);
  }
  // Used by the results list's "no one matches" empty state.
  function searchIcon() {
    return icon('search', [
      ['circle', { cx: 10.5, cy: 10.5, r: 6.5, fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }],
      ['path', { d: 'M15.5 15.5L21 21', stroke: 'currentColor', 'stroke-width': 2.4, 'stroke-linecap': 'round' }]
    ]);
  }
  function aiBadge() {
    return el('span', { class: 'ai-badge' }, [infoIcon(), 'AI-gathered notes']);
  }

  // ---------------------------------------------------------------- loading

  function showStatus(kind, title, message, withRetry) {
    els.status.hidden = false;
    els.status.className = 'status ' + kind;
    els.status.replaceChildren(el('div', { class: 'status-box' }, [
      el('h2', { text: title }),
      message ? el('code', { text: message }) : null,
      withRetry ? el('p', null, [el('button', { class: 'btn', type: 'button', onclick: load, text: 'Retry' })]) : null
    ]));
    els.resultsCount.textContent = kind === 'error' ? 'No data loaded'
      : kind === 'empty' ? 'No people yet' : '';
  }

  var mentionsPromise = null;

  /** Fetched once per page load. A missing file (404) or junk is simply
   *  "no overrides": repeated names then stay plain text in the reader. */
  function loadMentions() {
    if (!mentionsPromise) {
      mentionsPromise = fetch('/api/mentions', { cache: 'no-store' })
        .then(function (res) { return res.ok ? res.json() : {}; })
        .catch(function () { return {}; })
        .then(function (m) {
          state.mentions = m && typeof m === 'object' && !Array.isArray(m) ? m : {};
          return state.mentions;
        });
    }
    return mentionsPromise;
  }

  function load() {
    showStatus('loading', 'Loading family…');
    loadMentions();
    fetch('/api/people', { cache: 'no-store' })
      .then(function (res) {
        return res.text().then(function (body) {
          var json;
          try { json = JSON.parse(body); } catch (e) { json = null; }
          if (!res.ok) throw new Error((json && json.error) || ('Server responded ' + res.status));
          if (!Array.isArray(json)) throw new Error('Server did not return a list of people.');
          return json;
        });
      })
      .then(init)
      .catch(function (err) {
        showStatus('error', 'Couldn’t load the family data',
          (err && err.message ? err.message : String(err)) +
          '\n\nFix data/people.json and press Retry — no server restart needed.', true);
      });
  }

  function init(raw) {
    var index = F.buildIndex(raw);
    var problems = F.validate(raw, index);
    state.index = index;
    // Everyone stays in the app: an "unknown" (or otherwise unusable)
    // generation is drawn in a trailing "Gen ?" band rather than dropped;
    // bad values are still reported in the warning.
    state.people = Array.from(index.byId.values());

    renderWarning(problems);
    loadMentions().then(function (m) {
      if (state.index !== index || !Object.keys(m).length) return;
      var extra = F.validateMentions(m, index);
      if (extra.length) renderWarning(problems.concat(extra));
    });

    if (state.people.length === 0) {
      showStatus('empty', 'No people yet', 'data/people.json is an empty list. Add a person to get started.');
      return;
    }
    els.status.hidden = true;

    state.layout = computeLayout(state.people);
    renderTree();
    applyFilters();

    var readRef = refFromHash();
    var fromHash = idFromHash();
    if (readRef) { scrollToTop(); openReader(readRef); }
    else if (fromHash && state.index.byId.has(fromHash)) select(fromHash, { scroll: true });
    else scrollToTop();
  }

  function renderWarning(problems) {
    if (!problems.length) { els.warning.hidden = true; return; }
    var shown = problems.slice(0, 12);
    els.warning.hidden = false;
    els.warning.replaceChildren(
      el('strong', { text: '⚠ ' + problems.length + ' data problem' + (problems.length === 1 ? '' : 's') + ' in data/people.json' }),
      document.createTextNode(' — the tree shows what it can. Run "node tests/data.test.js" for the full list.'),
      el('ul', null, shown.map(function (p) { return el('li', { text: p }); })
        .concat(problems.length > shown.length ? [el('li', { text: '…and ' + (problems.length - shown.length) + ' more' })] : []))
    );
  }



  // ---------------------------------------------------------------- layout

  /**
   * Generation rows, top to bottom, built from unions: each union (mom +
   * dad, or a single parent) is two (or one) separate cards side by side,
   * mom on the left and dad on the right, with a junction pill between and
   * below them. People with no union are plain cards.
   *
   * Within a row, the unions/cards of one set of siblings are centred under
   * their parents' junction, in birth order. Groups that would overlap are
   * pushed right; that keeps this a single cheap pass, which matters once
   * the data holds hundreds of people.
   */
  /** The row a generation value lands on: its number, or 'unknown' for
   *  anything that isn't a positive integer, so nothing NaNs out when rows
   *  are sorted (F.generationRank puts 'unknown' last). */
  function rowGen(g) { return F.isPositiveInt(g) ? g : 'unknown'; }

  function genText(g) { return F.isPositiveInt(g) ? String(g) : '?'; }

  function computeLayout(people) {
    var idx = state.index;
    var order = new Map(people.map(function (p, i) { return [p.id, i]; }));
    var fu = F.deriveUnions(idx, function (id) { return order.has(id); });
    var inTree = function (id) { return !!id && order.has(id); };

    function parentUnion(id) {
      var p = idx.byId.get(id);
      var mom = inTree(p.mom) && p.mom !== id ? p.mom : null;
      var dad = inTree(p.dad) && p.dad !== id ? p.dad : null;
      return mom || dad ? fu.byKey.get((mom || '') + '|' + (dad || '')) : null;
    }

    // A unit is what occupies a slot in a row: a union's cards or a lone card.
    var units = [];
    fu.unions.forEach(function (un) {
      un.members = [un.mom, un.dad].filter(Boolean);
      // A union sits on its later parent's row: children are always in a
      // later generation than BOTH parents, so they stay below it.
      // A married-in partner of unknown generation rides on the known one's row.
      var memberGens = un.members.map(function (id) { return idx.byId.get(id).generation; }).filter(F.isPositiveInt);
      un.gen = memberGens.length ? Math.max.apply(null, memberGens) : 'unknown';
      un.width = un.members.length * NODE_W + (un.members.length - 1) * COUPLE_GAP;
      // Hang the union under the parents of whichever member has them (the
      // "blood" relative); a married-in spouse rides along.
      var anchor = un.members.filter(function (id) { return parentUnion(id); })
        .sort(function (a, c) { return order.get(a) - order.get(c); })[0] || null;
      un.anchorPerson = anchor;
      units.push({
        union: un, gen: un.gen, width: un.width, anchorPerson: anchor,
        anchorUnion: anchor ? parentUnion(anchor) : null,
        // Remarried siblings keep their unions side by side, in union order.
        sub: anchor ? fu.unionsOf.get(anchor).indexOf(un) : 0,
        first: Math.min.apply(null, un.members.map(function (id) { return order.get(id); }))
      });
    });
    people.forEach(function (p) {
      if (fu.unionsOf.has(p.id)) return;
      units.push({ id: p.id, gen: rowGen(p.generation), width: NODE_W, anchorPerson: p.id,
        anchorUnion: parentUnion(p.id), sub: 0, first: order.get(p.id) });
    });

    // Numbered generations top to bottom, then the unknown band last.
    var gens = Array.from(new Set(units.map(function (u) { return u.gen; }))).sort(function (a, b) {
      var ra = F.generationRank(a), rb = F.generationRank(b);
      return ra === rb ? 0 : ra - rb;
    });
    var rowY = new Map();
    var instances = new Map();
    function addInstance(id, inst) {
      if (!instances.has(id)) instances.set(id, []);
      instances.get(id).push(inst);
    }

    gens.forEach(function (g, rowIdx) {
      var y = MARGIN + rowIdx * ROW_H;
      rowY.set(g, y);
      var groups = [];
      var groupOf = new Map();
      units.filter(function (u) { return u.gen === g; })
        .sort(function (a, b) { return a.first - b.first; })
        .forEach(function (u) {
          var parent = u.anchorUnion;
          if (!parent || parent.cx === undefined) {
            groups.push({ center: null, units: [u] });
            return;
          }
          if (!groupOf.has(parent.key)) {
            var grp = { center: parent.cx, parent: parent, units: [] };
            groupOf.set(parent.key, grp);
            groups.push(grp);
          }
          groupOf.get(parent.key).units.push(u);
        });

      groups.forEach(function (grp) {
        if (!grp.parent) return;
        var kids = grp.parent.children;
        grp.units.sort(function (a, b) {
          return kids.indexOf(a.anchorPerson) - kids.indexOf(b.anchorPerson) || a.sub - b.sub;
        });
      });
      groups.sort(function (a, b) {
        if (a.center === null && b.center === null) return 0;
        if (a.center === null) return 1;
        if (b.center === null) return -1;
        return a.center - b.center;
      });

      var cursor = null;
      groups.forEach(function (grp) {
        var width = grp.units.reduce(function (w, u) { return w + u.width; }, 0) + (grp.units.length - 1) * UNIT_GAP;
        var left = grp.center === null ? (cursor === null ? 0 : cursor) : grp.center - width / 2;
        if (cursor !== null && left < cursor) left = cursor;
        grp.units.forEach(function (u) {
          u.x = left;
          if (u.union) {
            var un = u.union;
            un.x = left;
            un.y = y;
            // Same midpoint junctionGeometry() uses, so children centre
            // under the pill their lines actually come from.
            un.cx = left + un.width / 2;
            un.members.forEach(function (id, i) {
              addInstance(id, { x: left + i * (NODE_W + COUPLE_GAP), y: y, union: un });
            });
          } else {
            addInstance(u.id, { x: left, y: y, union: null });
          }
          left += u.width + UNIT_GAP;
        });
        cursor = left - UNIT_GAP + FAMILY_GAP;
      });
    });

    // Pushing groups right can leave content at negative x; shift everything
    // so the leftmost union sits just right of the generation labels.
    var minX = Infinity, maxX = -Infinity;
    units.forEach(function (u) { minX = Math.min(minX, u.x); maxX = Math.max(maxX, u.x + u.width); });
    var shift = MARGIN_LEFT - minX;
    fu.unions.forEach(function (un) { un.x += shift; un.cx += shift; });
    instances.forEach(function (list) { list.forEach(function (inst) { inst.x += shift; }); });

    // Where a child's line lands: the copy of them in a union that hangs
    // under their parents (a remarried person appears more than once).
    instances.forEach(function (list, id) {
      var own = list.filter(function (inst) { return inst.union && inst.union.anchorPerson === id; })[0];
      list.primary = own || list[0];
    });

    return {
      instances: instances,
      unions: fu.unions,
      rowY: rowY,
      gens: gens,
      width: maxX + shift + MARGIN,
      height: MARGIN + gens.length * ROW_H
    };
  }

  // ---------------------------------------------------------------- tree render

  function renderTree() {
    var L = state.layout;
    var SVG = SVG_NS;
    els.canvas.style.width = L.width + 'px';
    els.canvas.style.height = L.height + 'px';
    els.links.setAttribute('width', L.width);
    els.links.setAttribute('height', L.height);
    els.links.replaceChildren();
    els.nodes.replaceChildren();
    state.nodeEls.clear();
    state.unionEls = [];

    L.gens.forEach(function (g) {
      var y = L.rowY.get(g);
      if (y > MARGIN) els.nodes.appendChild(el('div', { class: 'gen-band', style: 'top:' + (y - ROW_GAP / 2 + 26) + 'px' }));
      els.nodes.appendChild(el('div', { class: 'gen-label', style: 'top:' + y + 'px;height:' + NODE_H + 'px', text: 'Gen ' + genText(g) }));
    });

    function svg(tag, attrs) {
      var n = document.createElementNS(SVG, tag);
      Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
      return n;
    }

    // Every union gets a junction pill between and below its parents. Each
    // parent's line down to it is drawn in their gender colour, so you can
    // tell which line is mom's and which is dad's even where lines cross;
    // every child's line fans out from the same pill in a light neutral, so
    // siblings visibly share one meeting point. Lines first, pills on top.
    var lineLayer = svg('g', { class: 'union-lines' });
    var pillLayer = svg('g', { class: 'union-pills' });
    els.links.appendChild(lineLayer);
    els.links.appendChild(pillLayer);
    L.unions.forEach(function (un) {
      var at = function (id) {
        var inst = id && (L.instances.get(id) || []).filter(function (i) { return i.union === un; })[0];
        return inst ? { x: inst.x + NODE_W / 2, y: inst.y + NODE_H } : null;
      };
      var kids = un.children.map(function (id) {
        var k = L.instances.get(id).primary;
        return { id: id, x: k.x + NODE_W / 2, y: k.y };
      });
      var geo = F.junctionGeometry({ mom: at(un.mom), dad: at(un.dad) }, kids, JUNCTION);
      if (!geo) return;
      var parts = [];
      var group = svg('g', { class: 'union' + (un.children.length ? '' : ' childless') });
      geo.lines.forEach(function (ln) {
        var d = 'M' + ln.x1 + ',' + ln.y1 + 'L' + ln.x2 + ',' + ln.y2;
        if (ln.kind === 'child') {
          // Invisible normally; on selection it becomes the gold edge that
          // shows which children belong to the highlighted union.
          group.appendChild(svg('path', { d: d, class: 'ln-casing' }));
        }
        group.appendChild(svg('path', { d: d, class: 'ln ln-' + ln.kind }));
      });
      lineLayer.appendChild(group);
      var names = un.members.map(function (id) { return displayName(state.index.byId.get(id)); });
      var pill = svg('rect', {
        x: geo.junction.x, y: geo.junction.y, width: geo.junction.w, height: geo.junction.h,
        rx: geo.junction.w / 2, class: 'junction'
      });
      var tip = document.createElementNS(SVG, 'title');
      tip.textContent = (un.members.length === 2 ? names.join(' & ') : names[0] + ' (single parent)') +
        (un.children.length ? ' — ' + un.children.length + ' child' + (un.children.length === 1 ? '' : 'ren') : ' — married, no children recorded');
      pill.appendChild(tip);
      pillLayer.appendChild(pill);
      parts.push(group, pill);
      state.unionEls.push({ els: parts, members: un.members.concat(un.children) });
    });

    state.people.forEach(function (p) {
      var list = L.instances.get(p.id) || [];
      var age = ageText(p);
      var notesCount = notesOf(p).length;
      var female = p.gender === 'female';
      var role = function (inst) {
        if (!inst.union || inst.union.members.length < 2) return '';
        return inst.union.mom === p.id ? ', mom in this family' : ', dad in this family';
      };
      state.nodeEls.set(p.id, list.map(function (inst, i) {
        var node = el('button', {
          type: 'button',
          class: 'node ' + (female ? 'female' : p.gender === 'male' ? 'male' : 'unknown'),
          style: 'left:' + inst.x + 'px;top:' + inst.y + 'px;width:' + NODE_W + 'px;height:' + NODE_H + 'px',
          'data-id': p.id,
          'aria-label': displayName(p) + ', ' + genderLabel(p.gender) + ', generation ' + (F.isPositiveInt(p.generation) ? p.generation : 'unknown') + role(inst) +
            (list.length > 1 ? ', shown ' + list.length + ' times (one per marriage)' : '') +
            (notesCount ? ', has AI-gathered notes' : ''),
          onclick: function () { select(p.id, { scroll: false, instance: i }); }
        }, [
          el('span', { class: 'n-name', text: displayName(p) }),
          el('span', { class: 'n-meta', text: genderMark(p.gender) + genderLabel(p.gender) + (age && p.age !== "unknown" ? ' · age ' + age : '') }),
          notesCount ? el('span', { class: 'n-ai', title: notesCount + ' AI-gathered note' + (notesCount === 1 ? '' : 's') }, [infoIcon()]) : null,
          list.length > 1 ? el('span', {
            class: 'n-dup',
            title: 'Same person, drawn once in each of their ' + list.length + ' unions',
            text: '⧉ ' + (i + 1) + '/' + list.length
          }) : null
        ]);
        els.nodes.appendChild(node);
        return node;
      }));
    });

    applyZoom(state.zoom);
  }

  // ---------------------------------------------------------------- zoom & pan

  function applyZoom(z, anchor) {
    var vp = els.viewport;
    // Keep the point under the anchor (default: viewport centre) fixed while zooming.
    var ax = anchor ? anchor.x : vp.clientWidth / 2;
    var ay = anchor ? anchor.y : vp.clientHeight / 2;
    var cx = (vp.scrollLeft + ax) / state.zoom;
    var cy = (vp.scrollTop + ay) / state.zoom;
    state.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
    els.canvas.style.transform = 'scale(' + state.zoom + ')';
    // The transform doesn't affect layout size, so a sizer gives the
    // scroll container the real scaled dimensions.
    els.sizer.style.width = state.layout.width * state.zoom + 'px';
    els.sizer.style.height = state.layout.height * state.zoom + 'px';
    vp.scrollLeft = cx * state.zoom - ax;
    vp.scrollTop = cy * state.zoom - ay;
    document.querySelector('[data-zoom="reset"]').textContent = Math.round(state.zoom * 100) + '%';
  }

  document.querySelectorAll('[data-zoom]').forEach(function (b) {
    b.addEventListener('click', function () {
      if (!state.layout) return;
      var dir = b.getAttribute('data-zoom');
      applyZoom(dir === 'in' ? state.zoom * 1.2 : dir === 'out' ? state.zoom / 1.2 : 1);
    });
  });

  els.viewport.addEventListener('wheel', function (e) {
    // Ctrl/⌘+wheel (and trackpad pinch, which browsers report as ctrl+wheel)
    // zooms the tree instead of the whole page.
    if (!(e.ctrlKey || e.metaKey) || !state.layout) return;
    e.preventDefault();
    var r = els.viewport.getBoundingClientRect();
    applyZoom(state.zoom * Math.exp(-e.deltaY * 0.0025), { x: e.clientX - r.left, y: e.clientY - r.top });
  }, { passive: false });

  // Mouse drag-to-pan. Touch is left to the browser's native scrolling,
  // which already pans with momentum on iPhone and feels better than any
  // hand-rolled version.
  (function () {
    var drag = null;
    var suppressClick = false;
    els.viewport.addEventListener('pointerdown', function (e) {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, sl: els.viewport.scrollLeft, st: els.viewport.scrollTop, moved: false, id: e.pointerId };
    });
    els.viewport.addEventListener('pointermove', function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
      if (!drag.moved) {
        drag.moved = true;
        els.viewport.classList.add('dragging');
        els.viewport.setPointerCapture(e.pointerId);
      }
      els.viewport.scrollLeft = drag.sl - dx;
      els.viewport.scrollTop = drag.st - dy;
    });
    function end() {
      if (drag && drag.moved) suppressClick = true;
      drag = null;
      els.viewport.classList.remove('dragging');
    }
    els.viewport.addEventListener('pointerup', end);
    els.viewport.addEventListener('pointercancel', end);
    // A drag that ends over a card must not also select that card.
    els.viewport.addEventListener('click', function (e) {
      if (suppressClick) { e.stopPropagation(); e.preventDefault(); suppressClick = false; }
    }, true);
  })();

  function scrollToTop() {
    var L = state.layout;
    els.viewport.scrollTop = 0;
    // Start centred on generation 1 rather than at the far-left edge.
    var xs = [];
    state.people.forEach(function (p) {
      if (p.generation !== L.gens[0]) return;
      (L.instances.get(p.id) || []).forEach(function (inst) { xs.push(inst.x + NODE_W / 2); });
    });
    if (!xs.length) return;
    var mid = (Math.min.apply(null, xs) + Math.max.apply(null, xs)) / 2;
    els.viewport.scrollLeft = mid * state.zoom - els.viewport.clientWidth / 2;
  }

  function centerOn(id, instance) {
    var list = state.layout.instances.get(id);
    if (!list) return;
    var at = list[instance] || list.primary;
    var vp = els.viewport;
    var visibleH = vp.clientHeight;
    // On phones the bottom sheet covers the lower part of the tree, so centre
    // within the part that's still visible.
    if (narrowMQ.matches && !els.detail.hidden) {
      var sheetTop = els.detail.getBoundingClientRect().top;
      var vpTop = vp.getBoundingClientRect().top;
      visibleH = Math.max(NODE_H * state.zoom + 20, sheetTop - vpTop);
      // Extra scroll room below the tree, otherwise people in the last rows
      // can never be scrolled up out from under the sheet.
      els.sizer.style.marginBottom = els.detail.offsetHeight + 'px';
    } else {
      els.sizer.style.marginBottom = '';
    }
    vp.scrollTo({
      left: (at.x + NODE_W / 2) * state.zoom - vp.clientWidth / 2,
      top: (at.y + NODE_H / 2) * state.zoom - visibleH / 2,
      behavior: 'smooth'
    });
  }

  // ---------------------------------------------------------------- selection

  function relatedIds(id) {
    var p = state.index.byId.get(id);
    var ids = new Set();
    if (p.mom && state.index.byId.has(p.mom)) ids.add(p.mom);
    if (p.dad && state.index.byId.has(p.dad)) ids.add(p.dad);
    state.index.childrenOf.get(id).forEach(function (c) { ids.add(c); });
    state.index.siblingsOf.get(id).forEach(function (s) { ids.add(s.id); });
    state.index.spousesOf.get(id).forEach(function (s) { ids.add(s); });
    return ids;
  }

  function select(id, opts) {
    if (!state.index || !state.index.byId.has(id)) return;
    opts = opts || {};
    // The person hash replaces a reader hash: never both at once.
    if (!els.readerPanel.hidden) closeReader({ keepHash: true });
    state.selectedId = id;
    var related = relatedIds(id);
    // Every copy of a remarried person lights up, so it's obvious the two
    // cards are one person.
    state.nodeEls.forEach(function (nodes, nid) {
      nodes.forEach(function (node) {
        node.classList.toggle('selected', nid === id);
        node.classList.toggle('related', related.has(nid));
      });
    });
    state.unionEls.forEach(function (u) {
      var on = u.members.indexOf(id) !== -1;
      u.els.forEach(function (n) {
        n.classList.toggle('active', on);
        // Put highlighted connectors on top so they're not hidden under others.
        if (on) n.parentNode.appendChild(n);
      });
    });

    renderDetail(id);
    markCurrentResult();
    if (history.replaceState) history.replaceState(null, '', '#person=' + encodeURIComponent(id));

    var nodes = state.nodeEls.get(id) || [];
    if (opts.scroll && nodes.length) {
      centerOn(id, opts.instance);
      nodes.forEach(function (node) {
        node.classList.remove('pulse');
        void node.offsetWidth; // restart the animation on repeat jumps
        node.classList.add('pulse');
      });
    }
  }

  function closeDetail() {
    els.detail.hidden = true;
    els.sizer.style.marginBottom = '';
    state.selectedId = null;
    state.nodeEls.forEach(function (nodes) { nodes.forEach(function (n) { n.classList.remove('selected', 'related'); }); });
    state.unionEls.forEach(function (u) { u.els.forEach(function (n) { n.classList.remove('active'); }); });
    markCurrentResult();
    // Only clear a person hash; an open reader owns the hash while it's up.
    if (history.replaceState && /^#person=/.test(location.hash)) history.replaceState(null, '', location.pathname + location.search);
  }

  function idFromHash() {
    var m = /^#person=(.+)$/.exec(location.hash);
    if (!m) return null;
    try { return decodeURIComponent(m[1]); } catch (e) { return null; }
  }

  // ---------------------------------------------------------------- detail panel

  function personLink(id, kind) {
    var p = state.index.byId.get(id);
    return el('button', {
      type: 'button',
      class: 'person-link',
      onclick: function () { select(id, { scroll: true }); }
    }, [displayName(p), kind ? el('span', { class: 'kind', text: '(' + kind + ')' }) : null]);
  }

  var SIBLING_KIND = {
    full: null,
    'half-maternal': 'half · same mother',
    'half-paternal': 'half · same father',
    maternal: 'same mother',
    paternal: 'same father'
  };

  /** `none` is either fallback text (wrapped in a plain .none span) or a
   *  ready-made state element (styled None/Unknown span), added as-is. */
  function linksOrNone(nodes, none) {
    if (nodes.length) return el('div', { class: 'links-list' }, nodes);
    return typeof none === 'string' ? el('span', { class: 'none', text: none }) : none;
  }

  /** Children list; when someone has kids by more than one partner, each
   *  child is tagged with the other parent so the two families stay distinct. */
  function childLinks(p) {
    var idx = state.index;
    var kids = idx.childrenOf.get(p.id);
    var otherOf = function (c) {
      var child = idx.byId.get(c);
      var other = child.mom === p.id ? child.dad : child.mom;
      return other && idx.byId.has(other) ? other : null;
    };
    var others = new Set(kids.map(otherOf));
    return kids.map(function (c) {
      var other = otherOf(c);
      return personLink(c, others.size > 1 ? (other ? 'with ' + displayName(idx.byId.get(other)) : 'other parent unrecorded') : null);
    });
  }

  function renderDetail(id) {
    var idx = state.index;
    var p = idx.byId.get(id);
    var notes = F.noteViews(p);
    var age = ageText(p);

    var parentLink = function (pid) {
      if (pid === "none") return el('span', { class: 'none solid', text: 'None' });
      if (pid === "unknown") return el('span', { class: 'none dashed', text: 'Unknown' });
      return pid && idx.byId.has(pid) ? personLink(pid) : el('span', { class: 'none', text: 'Not recorded' });
    };

    var fields = el('dl', { class: 'fields' }, [
      el('dt', { text: 'Generation' }), el('dd', null, [F.isPositiveInt(p.generation) ? String(p.generation) : p.generation === "unknown" ? el('span', { class: 'none dashed', text: 'Unknown' }) : '?']),
      el('dt', { text: 'Gender' }), el('dd', null, [p.gender === "unknown" ? el('span', { class: 'none dashed', text: 'Unknown' }) : genderLabel(p.gender)]),
      el('dt', { text: 'Age' }), el('dd', null, [p.age === "unknown" ? el('span', { class: 'none dashed', text: 'Unknown' }) : typeof p.age === 'number' ? p.age + ' years' : el('span', { class: 'none', text: 'Not recorded' })]),
      el('dt', { text: 'Mom' }), el('dd', null, [parentLink(p.mom)]),
      el('dt', { text: 'Dad' }), el('dd', null, [parentLink(p.dad)]),
      el('dt', { text: 'Spouses' }), el('dd', null, [linksOrNone(idx.spousesOf.get(id).map(function (s) { return personLink(s); }), p.spousesState === "none" ? el('span', { class: 'none solid', text: 'None' }) : p.spousesState === "unknown" ? el('span', { class: 'none dashed', text: 'Unknown' }) : 'None recorded')]),
      el('dt', { text: 'Children' }), el('dd', null, [linksOrNone(childLinks(p), p.childrenState === "none" ? el('span', { class: 'none solid', text: 'None' }) : p.childrenState === "unknown" ? el('span', { class: 'none dashed', text: 'Unknown' }) : 'None recorded')]),
      el('dt', { text: 'First mention' }), el('dd', null, [firstMentionLinks(p)]),
      el('dt', { text: 'Siblings' }), el('dd', null, [linksOrNone(idx.siblingsOf.get(id).map(function (s) { return personLink(s.id, SIBLING_KIND[s.kind]); }), 'None recorded')])
    ]);

    var notesSection;
    if (notes.length) {
      notesSection = el('section', { class: 'notes-section' }, [
        el('h3', null, [notes.length > 1 ? 'Notes (' + notes.length + ')' : 'Notes', aiBadge()]),
        el('div', { class: 'ai-disclaimer', role: 'note' }, [
          'Notes compiled by an AI from scripture references — verify against the verses linked below.'
        ])
      ].concat(notes.map(renderNote)));
    } else {
      notesSection = el('section', { class: 'notes-section' }, [
        el('h3', { text: 'Notes' }),
        el('p', { class: 'no-notes', text: 'No notes gathered for this person yet.' })
      ]);
    }

    els.detailBody.replaceChildren(
      el('h2', { text: displayName(p) }),
      el('div', { class: 'subtitle' }, [
        'Generation ' + genText(p.generation) + ' · ' + genderLabel(p.gender),
        notes.length ? ' ' : null,
        notes.length ? aiBadge() : null
      ]),
      fields,
      notesSection
    );
    els.detail.hidden = false;
    els.detail.scrollTop = 0;
  }

  /** One self-contained entry per note: its own commentary, quoted verses
   *  and source links, so several notes never blur into one block of text. */
  function renderNote(n) {
    var frag = document.createDocumentFragment();
    n.segments.forEach(function (seg) {
      frag.appendChild(seg.type === 'ref' ? refLink(seg.value) : document.createTextNode(seg.value));
    });
    return el('article', { class: 'note' }, [
      n.total > 1 ? el('div', { class: 'note-num', text: 'Note ' + n.number + ' of ' + n.total }) : null,
      el('p', { class: 'note-commentary' }, [el('span', { class: 'who', text: 'AI commentary:' }), frag]),
      // Scripture is set apart from the commentary so a reader can always
      // tell the source text from the AI's paraphrase of it.
      el('div', null, n.quotes.map(function (q) {
        return el('blockquote', { class: 'verse' }, [
          el('p', { text: '“' + q.text + '”' }),
          el('cite', null, ['— ', q.ref ? refLink(q.ref, q.ref + ' (KJV)') : 'unknown reference'])
        ]);
      })),
      el('div', { class: 'note-refs' }, n.refs.length
        ? [el('span', { text: 'Sources:' })].concat(n.refs.map(function (r) { return refLink(r.ref); }))
        : [el('span', { class: 'none', text: '⚠ No source reference recorded for this note' })])
    ]);
  }

  els.detailClose.addEventListener('click', closeDetail);
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (!els.readerPanel.hidden) { closeReader({ restoreFocus: true }); return; }
    // The filter panel sits on top, so Escape closes it first.
    if (!els.filterPanel.hidden) { closeFilterPanel(true); return; }
    if (!els.detail.hidden) closeDetail();
  });

  // ---------------------------------------------------------------- search & filters

  // Filter builder state: [{ field, operator, value, value2 }], ANDed by
  // F.filterByRows. Fields without modes keep operator null.
  var filterRows = [];

  const numberOps = [
    { id: 'is', label: 'is', valueType: 'number' },
    { id: 'between', label: 'is between', valueType: 'range' },
    { id: 'isUnknown', label: 'is unknown', valueType: 'none' }
  ];
  const countOps = [
    { id: 'amount', label: 'amount', valueType: 'count' },
    { id: 'amountRange', label: 'amount range', valueType: 'countRange' },
    { id: 'name', label: 'name', valueType: 'text' }
  ];

  // Field dropdown, in the owner's order. Labels are singular on purpose.
  // `control` = the single control for a field with no operator dropdown.
  const fieldDefinitions = {
    name: { label: 'Name', control: 'text', placeholder: 'Name contains…' },
    generation: { label: 'Generation', operators: numberOps },
    gender: { label: 'Gender', control: 'gender' },
    age: { label: 'Age', operators: numberOps },
    mom: { label: 'Mom', control: 'text', placeholder: 'Mom’s name contains…' },
    dad: { label: 'Dad', control: 'text', placeholder: 'Dad’s name contains…' },
    child: { label: 'Child', operators: countOps, noun: 'child' },
    sibling: { label: 'Sibling', operators: countOps, noun: 'sibling' },
    spouse: { label: 'Spouse', operators: countOps, noun: 'spouse' },
    notes: {
      label: 'Notes',
      operators: [
        { id: 'hasNote', label: 'has note', valueType: 'none' },
        { id: 'noNote', label: 'no note', valueType: 'none' },
        { id: 'noteContains', label: 'note contains', valueType: 'text' }
      ]
    }
  };

  function valueTypeOf(row) {
    const def = fieldDefinitions[row.field];
    if (def.control) return def.control;
    const op = def.operators.find(o => o.id === row.operator) || def.operators[0];
    return op.valueType;
  }

  // Text boxes and number boxes can't share a value: "Ab" typed as a name
  // would silently match no one once the box became an amount box.
  const valueKind = t => (t === 'text' ? 'text' : t === 'none' || t === 'gender' ? t : 'number');

  function setRowField(row, fieldId) {
    const def = fieldDefinitions[fieldId];
    row.field = fieldId;
    row.operator = def.operators ? def.operators[0].id : null;
    row.value = '';
    row.value2 = '';
  }

  function setRowOperator(row, operatorId) {
    const before = valueTypeOf(row);
    row.operator = operatorId;
    const after = valueTypeOf(row);
    if (valueKind(before) !== valueKind(after)) row.value = '';
    if (after !== 'range' && after !== 'countRange') row.value2 = '';
  }

  /** A value box that re-filters on every keystroke. */
  function valueInput(row, key, attrs) {
    return el('input', Object.assign({
      class: 'filter-value',
      value: row[key] || '',
      oninput: function (e) { row[key] = e.target.value; applyFilters(); }
    }, attrs));
  }

  function rangeInputs(row, attrs, labels) {
    return el('div', { class: 'filter-range' }, [
      valueInput(row, 'value', Object.assign({ placeholder: 'min', 'aria-label': labels[0] }, attrs)),
      el('span', { class: 'filter-range-sep', text: 'and' }),
      valueInput(row, 'value2', Object.assign({ placeholder: 'max', 'aria-label': labels[1] }, attrs))
    ]);
  }

  function valueControl(row) {
    const def = fieldDefinitions[row.field];
    const what = def.label.toLowerCase();
    // Generation/age are free text boxes (junk in "is" matches no one);
    // child/sibling/spouse counts are number boxes.
    const numText = { type: 'text', inputmode: 'numeric', autocomplete: 'off' };
    const count = { type: 'number', inputmode: 'numeric', min: '0', step: '1' };
    switch (valueTypeOf(row)) {
      case 'text':
        return valueInput(row, 'value', {
          type: 'text', autocomplete: 'off', spellcheck: 'false',
          placeholder: def.placeholder || (row.operator === 'name' ? def.noun + '’s name contains…' : 'contains…'),
          'aria-label': def.placeholder ? def.label + ' contains' : def.label + ' text'
        });
      case 'number':
        return valueInput(row, 'value', Object.assign({ placeholder: what, 'aria-label': def.label + ' is' }, numText));
      case 'range':
        return rangeInputs(row, numText, [def.label + ' from', def.label + ' to']);
      case 'count':
        return valueInput(row, 'value', Object.assign({ placeholder: 'how many', 'aria-label': 'Number of ' + what }, count));
      case 'countRange':
        return rangeInputs(row, count, ['Fewest ' + what, 'Most ' + what]);
      case 'gender':
        return el('select', {
          class: 'filter-value',
          'aria-label': 'Gender',
          onchange: function (e) { row.value = e.target.value; applyFilters(); }
        }, [['', 'any gender'], ['male', 'male'], ['female', 'female'], ['unknown', 'unknown']].map(function (o) {
          return el('option', { value: o[0], selected: (row.value || '') === o[0], text: o[1] });
        }));
      default:
        return null; // 'none': the mode itself is the whole condition
    }
  }

  function createFilterRow(row) {
    const def = fieldDefinitions[row.field];
    const rowEl = el('div', { class: 'filter-row' + (def.operators ? ' has-op' : '') });
    const rerender = function () {
      const fresh = createFilterRow(row);
      rowEl.replaceWith(fresh);
      return fresh;
    };

    const fieldSelect = el('select', {
      class: 'filter-field',
      'aria-label': 'Filter on',
      onchange: function (e) {
        setRowField(row, e.target.value);
        const fresh = rerender();
        fresh.querySelector('.filter-operator, .filter-value').focus({ preventScroll: true });
        applyFilters();
      }
    }, Object.keys(fieldDefinitions).map(function (id) {
      return el('option', { value: id, selected: id === row.field, text: fieldDefinitions[id].label });
    }));

    const operatorSelect = def.operators ? el('select', {
      class: 'filter-operator',
      'aria-label': def.label + ' condition',
      onchange: function (e) {
        setRowOperator(row, e.target.value);
        const fresh = rerender();
        const box = fresh.querySelector('.filter-value');
        if (box) box.focus({ preventScroll: true });
        applyFilters();
      }
    }, def.operators.map(function (op) {
      return el('option', { value: op.id, selected: op.id === row.operator, text: op.label });
    })) : null;

    const control = valueControl(row);
    rowEl.append(fieldSelect);
    if (operatorSelect) rowEl.append(operatorSelect);
    rowEl.append(el('div', { class: 'filter-value-container' + (control ? '' : ' empty') }, [control]));
    rowEl.append(el('button', {
      class: 'btn ghost filter-remove',
      type: 'button',
      'aria-label': 'Remove ' + def.label + ' filter',
      title: 'Remove filter',
      onclick: function () { removeFilterRow(row); },
      text: '✕'
    }));
    return rowEl;
  }

  function addFilterRow() {
    const row = { field: 'name', operator: null, value: '', value2: '' };
    filterRows.push(row);
    renderFilterRows();
    const last = els.filterRows.lastElementChild;
    if (last) last.querySelector('.filter-value').focus({ preventScroll: true });
    applyFilters();
  }

  function removeFilterRow(row) {
    filterRows = filterRows.filter(r => r !== row);
    renderFilterRows();
    applyFilters();
  }

  function renderFilterRows() {
    els.filterRows.replaceChildren.apply(els.filterRows, filterRows.map(createFilterRow));
  }

  function clearFilterRows() {
    filterRows = [];
    renderFilterRows();
    applyFilters();
  }

  /** Rows that actually narrow the list (a blank box is inert). */
  function activeRowCount() {
    return filterRows.filter(F.rowIsActive).length;
  }

  function filtersActive() {
    return activeRowCount() > 0;
  }

  /** [{ person, reasons, rank }] for the results list: everyone passing
   *  every filter row, in data order. */
  function currentMatches() {
    if (!state.index) return [];
    return F.filterByRows(state.people, state.index, filterRows)
      .map(person => ({ person, reasons: [], rank: 0 }));
  }

  function updateFilterBadge(matchCount) {
    var n = activeRowCount();
    els.filtersBadge.hidden = !n;
    els.filtersBadge.textContent = String(n);
    els.filtersBtn.classList.toggle('on', n > 0);
    els.filtersBtn.setAttribute('aria-label', n ? 'Filters, ' + n + ' active' : 'Filters');
    els.filterReset.disabled = !filterRows.length;
    els.clearFilters.hidden = !filterRows.length;
    els.filterCount.textContent = matchCount + (matchCount === 1 ? ' person shown' : ' people shown');
  }

  // Desktop: a popover hanging under the button. Phones get a bottom sheet
  // from CSS, which overrides these coordinates.
  function positionFilterPanel() {
    if (els.filterPanel.hidden || narrowMQ.matches) return;
    var r = els.filtersBtn.getBoundingClientRect();
    els.filterPanel.style.top = Math.round(r.bottom + 8) + 'px';
    els.filterPanel.style.right = Math.max(8, Math.round(window.innerWidth - r.right)) + 'px';
    els.filterPanel.style.left = 'auto';
  }

  function openFilterPanel() {
    if (!els.readerPanel.hidden) closeReader();
    els.filterPanel.hidden = false;
    // The dimming backdrop is only for the phone sheet; on desktop an outside
    // click is caught by the document listener and still reaches its target.
    els.filterBackdrop.hidden = !narrowMQ.matches;
    els.filtersBtn.setAttribute('aria-expanded', 'true');
    positionFilterPanel();
    els.addFilterRow.focus({ preventScroll: true });
  }

  function closeFilterPanel(restoreFocus) {
    if (els.filterPanel.hidden) return;
    els.filterPanel.hidden = true;
    els.filterBackdrop.hidden = true;
    els.filtersBtn.setAttribute('aria-expanded', 'false');
    if (restoreFocus) els.filtersBtn.focus({ preventScroll: true });
  }

  /** Wrap the first occurrence of any search term in <mark>. */
  function highlighted(text, terms) {
    var folded = fold(text);
    // fold() can change length for some scripts; only highlight when it didn't.
    if (folded.length !== text.length) return [text];
    for (var i = 0; i < terms.length; i++) {
      var q = terms[i];
      var at = q ? folded.indexOf(q) : -1;
      if (at !== -1) return [text.slice(0, at), el('mark', { text: text.slice(at, at + q.length) }), text.slice(at + q.length)];
    }
    return [text];
  }

  var REASON_SHOWN = 3;

  function reasonChips(reasons, terms) {
    var extra = reasons.filter(function (r) { return r.field !== 'name'; });
    if (!extra.length) return null;
    var chips = extra.slice(0, REASON_SHOWN).map(function (r) {
      return el('span', { class: 'r-why r-why-' + r.field, title: 'Matched “' + r.term + '” via ' + r.field }, highlighted(r.label, terms));
    });
    if (extra.length > REASON_SHOWN) chips.push(el('span', { class: 'r-why more', text: '+' + (extra.length - REASON_SHOWN) + ' more' }));
    return el('div', { class: 'r-whys' }, chips);
  }

  function applyFilters() {
    if (!state.layout) return;
    var active = filtersActive();
    var matches = currentMatches();
    var matchSet = new Set(matches.map(function (m) { return m.person.id; }));
    var terms = []; // search box removed — no query terms to highlight

    els.resultsPane.classList.toggle('active', active);
    if (active) setResultsCollapsed(false);

    state.nodeEls.forEach(function (nodes, id) {
      nodes.forEach(function (node) {
        node.classList.toggle('dim', active && !matchSet.has(id));
        node.classList.toggle('match', active && matchSet.has(id));
      });
    });

    els.resultsCount.textContent = active
      ? matches.length + (matches.length === 1 ? ' match' : ' matches')
      : matches.length
        ? 'All ' + matches.length + ' people'
        : 'No people yet';
    updateFilterBadge(matches.length);

    if (!matches.length) {
      
      els.results.replaceChildren(el('li', { class: 'empty-state' }, [
        el('span', { class: 'big' }, [searchIcon()]),
        el('strong', { text: 'No one matches these filters' }),
        el('p', { text: 'Loosen or remove a filter, or clear them all to see everyone.' }),
        el('button', { class: 'btn', type: 'button', onclick: clearFilterRows, text: 'Clear filters' })
      ]));
      return;
    }

    els.results.replaceChildren.apply(els.results, matches.map(function (m) {
      var p = m.person;
      var age = ageText(p);
      var hasNotes = notesOf(p).length > 0;
      var nameHit = m.reasons.some(function (r) { return r.field === 'name'; });
      return el('li', null, [el('button', {
        type: 'button',
        'data-id': p.id,
        onclick: function () {
          select(p.id, { scroll: true });
          // On phones, fold the list away so the tree and sheet have room.
          if (narrowMQ.matches) setResultsCollapsed(true);
        }
      }, [
        el('div', { class: 'r-name' }, (nameHit ? highlighted(displayName(p), terms) : [displayName(p)])
          .concat(hasNotes ? [' ', el('span', { class: 'r-info', title: 'Has AI-gathered notes' }, [infoIcon()])] : [])),
        el('div', { class: 'r-meta', text: 'Gen ' + genText(p.generation) + ' · ' + genderMark(p.gender) + genderLabel(p.gender) + (age && p.age !== "unknown" ? ' · age ' + age : '') }),
        reasonChips(m.reasons, terms)
      ])]);
    }));
    markCurrentResult();
  }

  function markCurrentResult() {
    els.results.querySelectorAll('button[data-id]').forEach(function (b) {
      if (b.getAttribute('data-id') === state.selectedId) b.setAttribute('aria-current', 'true');
      else b.removeAttribute('aria-current');
    });
  }

  function setResultsCollapsed(collapsed) {
    els.resultsPane.classList.toggle('collapsed', collapsed);
    els.resultsToggle.textContent = collapsed ? 'Show' : 'Hide';
    els.resultsToggle.setAttribute('aria-expanded', String(!collapsed));
  }


  els.addFilterRow.addEventListener('click', addFilterRow);
  els.filterReset.addEventListener('click', clearFilterRows);
  els.clearFilters.addEventListener('click', clearFilterRows);

  els.filtersBtn.addEventListener('click', function () {
    if (els.filterPanel.hidden) openFilterPanel(); else closeFilterPanel(false);
  });
  els.filterClose.addEventListener('click', function () { closeFilterPanel(true); });
  // On click, not pointerdown: closing on pointerdown would hide the backdrop
  // and let the same tap land on whatever tree card is underneath.
  els.filterBackdrop.addEventListener('click', function () { closeFilterPanel(false); });
  document.addEventListener('pointerdown', function (e) {
    if (els.filterPanel.hidden) return;
    var t = e.target;
    if (els.filterPanel.contains(t) || els.filtersBtn.contains(t) || t === els.filterBackdrop) return;
    closeFilterPanel(false);
  });
  window.addEventListener('resize', function () {
    // Rotating a tablet can cross the phone breakpoint with the panel open.
    if (!els.filterPanel.hidden) els.filterBackdrop.hidden = !narrowMQ.matches;
    if (!els.readerPanel.hidden) els.readerBackdrop.hidden = !narrowMQ.matches;
    positionFilterPanel();
    positionReaderPanel();
  });
  els.resultsToggle.addEventListener('click', function () {
    setResultsCollapsed(!els.resultsPane.classList.contains('collapsed'));
  });
  // ---------------------------------------------------------------- Bible reader

  // KJV text lives in /kjv/<slug>.json (one file per book, verse n = index n-1)
  // with /kjv/index.json listing the 66 books in canonical order. Each file is
  // fetched the first time its book is opened and kept for the session.
  var reader = {
    books: null,          // [{ book, slug, chapters }] from index.json
    booksPromise: null,
    bookFiles: new Map(), // slug -> Promise of the parsed book
    book: 'Genesis',
    chapter: 1,
    verse: null,
    token: 0,             // drops stale renders when chapters are clicked quickly
    markTimer: null
  };

  function okJson(res) {
    if (!res.ok) throw new Error('Server responded ' + res.status);
    return res.json();
  }

  function loadBooks() {
    if (!reader.booksPromise) {
      reader.booksPromise = fetch('/kjv/index.json').then(okJson).then(function (list) {
        if (!Array.isArray(list) || !list.length) throw new Error('kjv/index.json has no books');
        reader.books = list;
        els.readerBook.replaceChildren.apply(els.readerBook, list.map(function (b) {
          return el('option', { value: b.book, text: b.book });
        }));
        return list;
      });
      // A failed fetch shouldn't be cached forever; Retry fetches again.
      reader.booksPromise.catch(function () { reader.booksPromise = null; });
    }
    return reader.booksPromise;
  }

  function loadBook(slug) {
    if (!reader.bookFiles.has(slug)) {
      var p = fetch('/kjv/' + slug + '.json').then(okJson);
      reader.bookFiles.set(slug, p);
      p.catch(function () { reader.bookFiles.delete(slug); });
    }
    return reader.bookFiles.get(slug);
  }

  function bookInfo(name) {
    var slug = F.bookSlug(name);
    return (reader.books || []).filter(function (b) { return b.slug === slug; })[0] || null;
  }

  /** "#read=Genesis+2:19": spaces as '+', the colon left readable. */
  function readHash(ref) {
    return '#read=' + encodeURIComponent(ref).replace(/%20/g, '+').replace(/%3A/gi, ':');
  }

  function refFromHash() {
    var m = /^#read=(.+)$/.exec(location.hash);
    if (!m) return null;
    try { return F.parseRef(decodeURIComponent(m[1].replace(/\+/g, ' '))); } catch (e) { return null; }
  }

  function currentReadRef() {
    return F.formatRef({ book: reader.book, chapter: reader.chapter, verse: reader.verse });
  }

  function positionReaderPanel() {
    if (els.readerPanel.hidden || narrowMQ.matches) return;
    var r = els.bibleBtn.getBoundingClientRect();
    // Wider than the filter popover: hang it from the button's left edge,
    // pulled back left only as far as needed to stay on screen.
    var w = els.readerPanel.offsetWidth;
    var left = Math.min(Math.round(r.left), window.innerWidth - w - 8);
    els.readerPanel.style.top = Math.round(r.bottom + 8) + 'px';
    els.readerPanel.style.left = Math.max(8, left) + 'px';
    els.readerPanel.style.right = 'auto';
  }

  /** Open at a parsed ref ({ book, chapter, verse|null }); with no ref,
   *  resume wherever the reader was last (Genesis 1 the first time). */
  function openReader(ref) {
    closeFilterPanel(false);
    var wasOpen = !els.readerPanel.hidden;
    els.readerPanel.hidden = false;
    els.readerBackdrop.hidden = !narrowMQ.matches;
    els.bibleBtn.setAttribute('aria-expanded', 'true');
    positionReaderPanel();
    if (!wasOpen) els.readerBody.focus({ preventScroll: true });
    if (ref) showChapter(ref.book, ref.chapter, ref.verse || null);
    else showChapter(reader.book, reader.chapter, null);
  }

  /** opts.keepHash: someone else (select) is about to set the hash.
   *  Otherwise the reader's hash goes; a still-selected person gets theirs back. */
  function closeReader(opts) {
    opts = opts || {};
    if (els.readerPanel.hidden) return;
    els.readerPanel.hidden = true;
    els.readerBackdrop.hidden = true;
    els.bibleBtn.setAttribute('aria-expanded', 'false');
    reader.token++;
    if (!opts.keepHash && history.replaceState && /^#read=/.test(location.hash)) {
      history.replaceState(null, '', state.selectedId
        ? '#person=' + encodeURIComponent(state.selectedId)
        : location.pathname + location.search);
    }
    if (opts.restoreFocus) els.bibleBtn.focus({ preventScroll: true });
  }

  function readerMessage(text, retry) {
    els.readerBody.replaceChildren(el('div', { class: 'rp-status' }, [
      el('p', { text: text }),
      retry ? el('button', { class: 'btn', type: 'button', onclick: retry, text: 'Retry' }) : null
    ]));
  }

  /** Neighbouring chapter, crossing book boundaries; null at either end. */
  function stepChapter(dir) {
    var books = reader.books || [];
    var i = books.indexOf(bookInfo(reader.book));
    if (i === -1) return null;
    var ch = reader.chapter + dir;
    if (ch >= 1 && ch <= books[i].chapters) return { book: books[i].book, chapter: ch };
    var nb = books[i + dir];
    if (!nb) return null;
    return { book: nb.book, chapter: dir > 0 ? 1 : nb.chapters };
  }

  function updateStepper() {
    els.readerWhere.textContent = reader.book + ' ' + reader.chapter;
    els.readerPrev.disabled = !stepChapter(-1);
    els.readerNext.disabled = !stepChapter(1);
  }

  function showChapter(book, chapter, verse) {
    var token = ++reader.token;
    reader.book = book;
    reader.chapter = chapter;
    reader.verse = verse || null;
    if (history.replaceState) history.replaceState(null, '', readHash(currentReadRef()));
    els.readerWhere.textContent = book + ' ' + chapter;
    readerMessage('Loading ' + book + ' ' + chapter + '…');
    var retry = function () { showChapter(book, chapter, verse); };
    loadBooks().then(function () {
      var info = bookInfo(book);
      if (!info) throw new Error('“' + book + '” isn’t in the KJV book list.');
      if (token !== reader.token) return null;
      els.readerBook.value = info.book;
      updateStepper();
      if (chapter > info.chapters) {
        readerMessage(info.book + ' has ' + info.chapters + ' chapter' + (info.chapters === 1 ? '' : 's') + '.');
        return null;
      }
      return Promise.all([loadBook(info.slug), loadMentions()]).then(function (r) {
        if (token !== reader.token) return;
        renderChapter(r[0], info.book, chapter, verse);
      });
    }).catch(function (err) {
      if (token !== reader.token) return;
      readerMessage('Couldn’t load ' + book + ' ' + chapter + ': ' + (err && err.message ? err.message : String(err)), retry);
    });
  }

  /** The bundled KJV has spacing artifacts ("said she , hath", "LORD ."):
   *  drop the space before punctuation and collapse double spaces. Display
   *  only; the data files stay untouched. Done before name matching so the
   *  match offsets line up with the text actually shown. */
  function tidyVerse(s) {
    return String(s == null ? '' : s).replace(/\s+([,.;:!?])/g, '$1').replace(/\s{2,}/g, ' ').trim();
  }

  function renderChapter(data, book, chapter, verse) {
    var verses = data && Array.isArray(data.chapters) ? data.chapters[chapter - 1] : null;
    if (!Array.isArray(verses)) { readerMessage(book + ' ' + chapter + ' isn’t in the KJV file.'); return; }
    var marked = null;
    var text = el('div', { class: 'rp-text', lang: 'en' }, verses.map(function (raw, i) {
      var vt = tidyVerse(raw);
      var n = i + 1;
      var ref = book + ' ' + chapter + ':' + n;
      var parts = [el('sup', { class: 'vnum', text: String(n) })];
      var occ = state.index ? F.findNameOccurrences(vt, state.index, ref, state.mentions) : [];
      var last = 0;
      occ.forEach(function (o) {
        if (o.start > last) parts.push(vt.slice(last, o.start));
        parts.push(el('button', {
          type: 'button',
          class: 'name-hl',
          title: 'Show ' + displayName(o.person) + ' in the family tree',
          onclick: function () { goToPerson(o.person.id); }
        }, [o.text]));
        last = o.end;
      });
      if (last < vt.length) parts.push(vt.slice(last));
      parts.push(' ');
      var span = el('span', { class: 'rp-verse', 'data-verse': String(n), id: 'v' + n }, parts);
      if (verse === n) marked = span;
      return span;
    }));
    els.readerBody.replaceChildren(text);
    clearTimeout(reader.markTimer);
    if (marked) {
      marked.classList.add('rp-mark');
      // After layout, so the sheet/popover has its final size.
      requestAnimationFrame(function () { marked.scrollIntoView({ block: 'center' }); });
      reader.markTimer = setTimeout(function () { marked.classList.remove('rp-mark'); }, 2600);
    } else {
      els.readerBody.scrollTop = 0;
    }
  }

  /** Tap on a highlighted name: same flow as tapping a result. */
  function goToPerson(id) {
    closeReader({ keepHash: true });
    select(id, { scroll: true });
    if (narrowMQ.matches) setResultsCollapsed(true);
  }

  /** Detail-panel row: the BibleGateway link plus an in-app "read" link. */
  function firstMentionLinks(p) {
    var key = F.verseKey(p.firstMention);
    if (!key) return el('span', { class: 'none', text: 'Not recorded' });
    return el('span', { class: 'fm-links' }, [
      refLink(p.firstMention),
      el('a', {
        class: 'read-link',
        href: readHash(key),
        title: 'Read ' + key + ' (KJV) here',
        onclick: function (e) {
          // Handled directly: if the hash already matched, no hashchange would fire.
          e.preventDefault();
          openReader(F.parseRef(key));
        },
        text: 'Read here'
      })
    ]);
  }

  els.bibleBtn.addEventListener('click', function () {
    if (els.readerPanel.hidden) openReader(null); else closeReader();
  });
  els.readerClose.addEventListener('click', function () { closeReader({ restoreFocus: true }); });
  els.readerBackdrop.addEventListener('click', function () { closeReader(); });
  els.readerBook.addEventListener('change', function () { showChapter(els.readerBook.value, 1, null); });
  els.readerPrev.addEventListener('click', function () {
    var t = stepChapter(-1);
    if (t) showChapter(t.book, t.chapter, null);
  });
  els.readerNext.addEventListener('click', function () {
    var t = stepChapter(1);
    if (t) showChapter(t.book, t.chapter, null);
  });
  document.addEventListener('pointerdown', function (e) {
    if (els.readerPanel.hidden || narrowMQ.matches) return;
    var t = e.target;
    if (els.readerPanel.contains(t) || els.bibleBtn.contains(t)) return;
    closeReader();
  });

  window.addEventListener('hashchange', function () {
    var ref = refFromHash();
    if (ref) { openReader(ref); return; }
    var id = idFromHash();
    if (id && id !== state.selectedId) select(id, { scroll: true });
  });

  load();
})();
