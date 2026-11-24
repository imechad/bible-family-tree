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
    search: $('search'),
    genSel: $('filter-gen'),
    genderSel: $('filter-gender'),
    clear: $('clear-filters'),
    ageMin: $('filter-age-min'),
    ageMax: $('filter-age-max'),
    hasNotes: $('filter-has-notes'),
    hasChildren: $('filter-has-children'),
    hasSpouse: $('filter-has-spouse'),
    filtersBtn: $('filters-btn'),
    filtersBadge: $('filters-badge'),
    filterPanel: $('filter-panel'),
    filterBackdrop: $('filter-backdrop'),
    filterClose: $('filter-close'),
    filterReset: $('filter-reset'),
    filterCount: $('filter-count'),
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
    detailClose: $('detail-close')
  };

  var state = {
    index: null,
    people: [],       // renderable people, in data order
    layout: null,     // { instances: Map(id -> [{x,y}]), unions: [], width, height, ... }
    nodeEls: new Map(),   // id -> [card elements]; a remarried person has one per union
    unionEls: [],     // [{ els: [svg nodes], members: [ids] }] for highlight toggling
    selectedId: null,
    zoom: 1
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
    els.resultsCount.textContent = kind === 'error' ? 'No data loaded' : '';
  }

  function load() {
    showStatus('loading', 'Loading family…');
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
    // Anyone without a usable generation can't be placed on a row; they're
    // reported in the warning instead of breaking the whole page.
    state.people = Array.from(index.byId.values()).filter(function (p) { return F.isPositiveInt(p.generation); });

    renderWarning(problems);

    if (state.people.length === 0) {
      showStatus('empty', 'No people yet', 'data/people.json is an empty list. Add a person to get started.');
      return;
    }
    els.status.hidden = true;

    fillGenerationFilter();
    state.layout = computeLayout(state.people);
    renderTree();
    applyFilters();

    var fromHash = idFromHash();
    if (fromHash && state.index.byId.has(fromHash)) select(fromHash, { scroll: true });
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

  function fillGenerationFilter() {
    var gens = Array.from(new Set(state.people.map(function (p) { return p.generation; }))).sort(function (a, b) { return a - b; });
    var keep = els.genSel.value;
    els.genSel.replaceChildren(el('option', { value: '', text: 'All generations' }));
    gens.forEach(function (g) { els.genSel.appendChild(el('option', { value: String(g), text: 'Generation ' + g })); });
    if (gens.indexOf(Number(keep)) !== -1) els.genSel.value = keep;
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
      un.gen = Math.max.apply(null, un.members.map(function (id) { return idx.byId.get(id).generation; }));
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
      units.push({ id: p.id, gen: p.generation, width: NODE_W, anchorPerson: p.id,
        anchorUnion: parentUnion(p.id), sub: 0, first: order.get(p.id) });
    });

    var gens = Array.from(new Set(people.map(function (p) { return p.generation; }))).sort(function (a, b) { return a - b; });
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
      els.nodes.appendChild(el('div', { class: 'gen-label', style: 'top:' + y + 'px;height:' + NODE_H + 'px', text: 'Gen ' + g }));
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
          'aria-label': displayName(p) + ', ' + genderLabel(p.gender) + ', generation ' + p.generation + role(inst) +
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
    if (history.replaceState) history.replaceState(null, '', location.pathname + location.search);
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

  function linksOrNone(nodes, noneText) {
    return nodes.length ? el('div', { class: 'links-list' }, nodes) : el('span', { class: 'none', text: noneText });
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
      el('dt', { text: 'Generation' }), el('dd', { text: F.isPositiveInt(p.generation) ? String(p.generation) : p.generation === "unknown" ? el('span', { class: 'none dashed', text: 'Unknown' }) : '?' }),
      el('dt', { text: 'Gender' }), el('dd', { text: p.gender === "unknown" ? el('span', { class: 'none dashed', text: 'Unknown' }) : genderLabel(p.gender) }),
      el('dt', { text: 'Age' }), el('dd', null, [p.age === "unknown" ? el('span', { class: 'none dashed', text: 'Unknown' }) : typeof p.age === 'number' ? p.age + ' years' : el('span', { class: 'none', text: 'Not recorded' })]),
      el('dt', { text: 'Mom' }), el('dd', null, [parentLink(p.mom)]),
      el('dt', { text: 'Dad' }), el('dd', null, [parentLink(p.dad)]),
      el('dt', { text: 'Spouses' }), el('dd', null, [linksOrNone(idx.spousesOf.get(id).map(function (s) { return personLink(s); }), p.spousesState === "none" ? el('span', { class: 'none solid', text: 'None' }) : p.spousesState === "unknown" ? el('span', { class: 'none dashed', text: 'Unknown' }) : 'None recorded')]),
      el('dt', { text: 'Children' }), el('dd', null, [linksOrNone(childLinks(p), p.childrenState === "none" ? el('span', { class: 'none solid', text: 'None' }) : p.childrenState === "unknown" ? el('span', { class: 'none dashed', text: 'Unknown' }) : 'None recorded')]),
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
        'Generation ' + (p.generation || '?') + ' · ' + genderLabel(p.gender),
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
    // The filter panel sits on top, so Escape closes it first.
    if (!els.filterPanel.hidden) { closeFilterPanel(true); return; }
    if (!els.detail.hidden && document.activeElement !== els.search) closeDetail();
  });

  // ---------------------------------------------------------------- search & filters

  /** The filter panel's controls as a plain object (see Family.matchesFilters),
   *  so the filtering rules live in family.js where the tests can reach them. */
  function readFilters() {
    return {
      gen: els.genSel.value,
      gender: els.genderSel.value,
      ageMin: els.ageMin.value,
      ageMax: els.ageMax.value,
      hasNotes: els.hasNotes.checked,
      hasChildren: els.hasChildren.checked,
      hasSpouse: els.hasSpouse.checked
    };
  }

  function filtersActive() {
    return !!(els.search.value.trim() || F.activeFilterCount(readFilters()));
  }

  /** [{ person, reasons, rank }] for the search box (see Family.search),
   *  ANDed with every filter in the panel. */
  function currentMatches() {
    return F.filterSearch(state.people, state.index, els.search.value, readFilters());
  }

  function updateFilterBadge(matchCount) {
    var n = F.activeFilterCount(readFilters());
    els.filtersBadge.hidden = !n;
    els.filtersBadge.textContent = String(n);
    els.filtersBtn.classList.toggle('on', n > 0);
    els.filtersBtn.setAttribute('aria-label', n ? 'Filters, ' + n + ' active' : 'Filters');
    els.filterReset.disabled = !n;
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
    els.filterPanel.hidden = false;
    // The dimming backdrop is only for the phone sheet; on desktop an outside
    // click is caught by the document listener and still reaches its target.
    els.filterBackdrop.hidden = !narrowMQ.matches;
    els.filtersBtn.setAttribute('aria-expanded', 'true');
    positionFilterPanel();
    els.genSel.focus({ preventScroll: true });
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
    var terms = F.parseQuery(els.search.value).map(function (t) { return t.value; });

    els.clear.hidden = !active;
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
      : 'All ' + matches.length + ' people';
    updateFilterBadge(matches.length);

    if (!matches.length) {
      var term = els.search.value.trim();
      els.results.replaceChildren(el('li', { class: 'empty-state' }, [
        el('span', { class: 'big' }, [searchIcon()]),
        el('strong', { text: term ? 'No matches for “' + term + '”' : 'No one matches these filters' }),
        el('p', { text: 'Try a shorter name, or clear the filters to see everyone.' }),
        el('button', { class: 'btn', type: 'button', onclick: clearFilters, text: 'Clear search & filters' })
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
        el('div', { class: 'r-meta', text: 'Gen ' + p.generation + ' · ' + genderMark(p.gender) + genderLabel(p.gender) + (age && p.age !== "unknown" ? ' · age ' + age : '') }),
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

  /** The panel's "Clear filters": resets every panel control but leaves the
   *  search text alone, since that has its own box (and ✕/Escape). */
  function resetPanelFilters() {
    var f = F.emptyFilters();
    els.genSel.value = f.gen;
    els.genderSel.value = f.gender;
    els.ageMin.value = f.ageMin;
    els.ageMax.value = f.ageMax;
    els.hasNotes.checked = f.hasNotes;
    els.hasChildren.checked = f.hasChildren;
    els.hasSpouse.checked = f.hasSpouse;
    applyFilters();
  }

  /** Top-bar "Clear" and the empty state's button: search AND filters. */
  function clearFilters() {
    els.search.value = '';
    resetPanelFilters();
  }

  els.search.addEventListener('input', applyFilters);
  // 'input' as well as 'change' so the count moves while the user is still
  // typing an age or arrowing through a dropdown, not only on blur.
  [els.genSel, els.genderSel, els.ageMin, els.ageMax, els.hasNotes, els.hasChildren, els.hasSpouse].forEach(function (c) {
    c.addEventListener('input', applyFilters);
    c.addEventListener('change', applyFilters);
  });
  els.clear.addEventListener('click', clearFilters);
  els.filterReset.addEventListener('click', resetPanelFilters);
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
    positionFilterPanel();
  });
  els.resultsToggle.addEventListener('click', function () {
    setResultsCollapsed(!els.resultsPane.classList.contains('collapsed'));
  });
  els.search.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      var first = currentMatches()[0];
      if (first) {
        select(first.person.id, { scroll: true });
        if (narrowMQ.matches) { setResultsCollapsed(true); els.search.blur(); }
      }
    } else if (e.key === 'Escape') {
      clearFilters();
    }
  });

  window.addEventListener('hashchange', function () {
    var id = idFromHash();
    if (id && id !== state.selectedId) select(id, { scroll: true });
  });

  load();
})();
