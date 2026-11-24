/* Bible Family Tree Explorer — browser app. Depends on family.js (window.Family). */
(function () {
  'use strict';

  var F = window.Family;

  // Card geometry. Rows leave a tall gap below each card so the connector
  // "bus" lines have room and don't run through names.
  var NODE_W = 180;
  var NODE_H = 62;
  var COL_GAP = 20;
  var FAMILY_GAP = 44;
  var ROW_H = NODE_H + 96;
  var MARGIN_LEFT = 52; // room for the vertical "Gen N" labels
  var MARGIN = 30;
  var ZOOM_MIN = 0.35;
  var ZOOM_MAX = 1.6;
  // Muted so connectors stay behind the cards visually; distinct enough that
  // neighbouring families' lines can be told apart.
  var FAMILY_HUES = ['#6f8fbf', '#b98a96', '#7fa37a', '#c3a06a', '#9484c4', '#5fa8a0', '#b88462', '#8d9a5c'];

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    search: $('search'),
    genSel: $('filter-gen'),
    genderSel: $('filter-gender'),
    clear: $('clear-filters'),
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
    layout: null,     // { pos: Map(id -> {x,y}), width, height, families: [] }
    nodeEls: new Map(),
    familyEls: [],
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

  function fold(s) {
    // Accent-insensitive search so "Ysolde" is found by "ysolde" and, later,
    // transliterated names match with or without diacritics.
    return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }

  function displayName(p) { return p.name && String(p.name).trim() ? p.name : p.id; }
  function notesOf(p) { return Array.isArray(p.notes) ? p.notes.filter(function (n) { return n && typeof n.text === 'string'; }) : []; }
  function ageText(p) { return typeof p.age === 'number' && isFinite(p.age) ? String(p.age) : null; }
  function genderLabel(g) { return g === 'male' ? 'Male' : g === 'female' ? 'Female' : 'Unknown'; }

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

  /** Commentary text with any verse references inside it turned into links. */
  function linkifiedText(text) {
    var frag = document.createDocumentFragment();
    F.splitRefs(text).forEach(function (seg) {
      frag.appendChild(seg.type === 'ref' ? refLink(seg.value) : document.createTextNode(seg.value));
    });
    return frag;
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
   * Generation rows, top to bottom. Within a row, each sibling group is
   * centred under its parents and married-in spouses (no recorded parents)
   * are glued beside their partner, so families read as clusters. Groups that
   * would overlap are pushed right; that keeps this a single cheap pass,
   * which matters once the data holds hundreds of people.
   */
  function computeLayout(people) {
    var byId = state.index.byId;
    var order = new Map(people.map(function (p, i) { return [p.id, i]; }));
    var inTree = function (id) { return id && order.has(id); };

    // Partners = two people who share a child. Derived, like everything else.
    var partners = new Map();
    function addPartner(a, b) {
      if (!partners.has(a)) partners.set(a, []);
      if (partners.get(a).indexOf(b) === -1) partners.get(a).push(b);
    }
    people.forEach(function (p) {
      if (inTree(p.mom) && inTree(p.dad)) { addPartner(p.mom, p.dad); addPartner(p.dad, p.mom); }
    });

    var gens = Array.from(new Set(people.map(function (p) { return p.generation; }))).sort(function (a, b) { return a - b; });
    var pos = new Map();
    var rowY = new Map();

    gens.forEach(function (g, rowIdx) {
      var y = MARGIN + rowIdx * ROW_H;
      rowY.set(g, y);
      var row = people.filter(function (p) { return p.generation === g; });
      var blocks = [];
      var blockOf = new Map();
      var loose = [];

      row.forEach(function (p) {
        var parentXs = [p.mom, p.dad].filter(function (id) { return id && pos.has(id); })
          .map(function (id) { return pos.get(id).x + NODE_W / 2; });
        if (!parentXs.length) { loose.push(p); return; }
        var key = (p.mom || '') + '|' + (p.dad || '');
        var block = blocks.find(function (b) { return b.key === key; });
        if (!block) {
          block = { key: key, center: parentXs.reduce(function (a, b) { return a + b; }, 0) / parentXs.length, members: [] };
          blocks.push(block);
        }
        block.members.push(p.id);
        blockOf.set(p.id, block);
      });

      // Repeat until stable: a spouse can only be glued once their partner
      // has a spot, and that partner may itself be a just-glued spouse.
      var changed = true;
      while (changed && loose.length) {
        changed = false;
        loose = loose.filter(function (p) {
          var mates = partners.get(p.id) || [];
          var sameRow = mates.find(function (id) { return blockOf.has(id); });
          if (sameRow) {
            var b = blockOf.get(sameRow);
            var at = b.members.indexOf(sameRow) + 1;
            while (at < b.members.length && !byId.get(b.members[at]).mom && !byId.get(b.members[at]).dad) at++;
            b.members.splice(at, 0, p.id);
            blockOf.set(p.id, b);
            changed = true;
            return false;
          }
          var above = mates.find(function (id) { return pos.has(id); });
          if (above) {
            var nb = { key: 'spouse:' + p.id, center: pos.get(above).x + NODE_W / 2, members: [p.id] };
            blocks.push(nb);
            blockOf.set(p.id, nb);
            changed = true;
            return false;
          }
          return true;
        });
      }

      // Whoever is left (e.g. generation 1, or unconnected people) is grouped
      // with any partners also left, in data order.
      var looseSet = new Set(loose.map(function (p) { return p.id; }));
      loose.forEach(function (p) {
        if (blockOf.has(p.id)) return;
        var b = { key: 'loose:' + p.id, center: null, members: [] };
        var queue = [p.id];
        while (queue.length) {
          var id = queue.shift();
          if (blockOf.has(id)) continue;
          b.members.push(id);
          blockOf.set(id, b);
          (partners.get(id) || []).forEach(function (m) { if (looseSet.has(m) && !blockOf.has(m)) queue.push(m); });
        }
        blocks.push(b);
      });

      blocks.sort(function (a, b) {
        if (a.center === null && b.center === null) return 0;
        if (a.center === null) return 1;
        if (b.center === null) return -1;
        return a.center - b.center;
      });

      var cursor = null;
      blocks.forEach(function (b) {
        var width = b.members.length * NODE_W + (b.members.length - 1) * COL_GAP;
        var left = b.center === null ? (cursor === null ? 0 : cursor) : b.center - width / 2;
        if (cursor !== null && left < cursor) left = cursor;
        b.members.forEach(function (id, i) { pos.set(id, { x: left + i * (NODE_W + COL_GAP), y: y }); });
        cursor = left + width + FAMILY_GAP;
      });
    });

    // Pushing groups right can leave content at negative x; shift everything
    // so the leftmost card sits just right of the generation labels.
    var minX = Infinity, maxX = -Infinity;
    pos.forEach(function (p) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); });
    var shift = MARGIN_LEFT - minX;
    pos.forEach(function (p) { p.x += shift; });

    // Family units: one connector per distinct (mom, dad) pair.
    var famMap = new Map();
    people.forEach(function (p) {
      var parents = [p.mom, p.dad].filter(inTree);
      if (!parents.length) return;
      var key = (p.mom || '') + '|' + (p.dad || '');
      if (!famMap.has(key)) famMap.set(key, { parents: parents, kids: [] });
      famMap.get(key).kids.push(p.id);
    });

    return {
      pos: pos,
      rowY: rowY,
      gens: gens,
      families: Array.from(famMap.values()),
      width: maxX + shift + NODE_W + MARGIN,
      height: MARGIN + gens.length * ROW_H
    };
  }

  // ---------------------------------------------------------------- tree render

  function renderTree() {
    var L = state.layout;
    var SVG = 'http://www.w3.org/2000/svg';
    els.canvas.style.width = L.width + 'px';
    els.canvas.style.height = L.height + 'px';
    els.links.setAttribute('width', L.width);
    els.links.setAttribute('height', L.height);
    els.links.replaceChildren();
    els.nodes.replaceChildren();
    state.nodeEls.clear();
    state.familyEls = [];

    L.gens.forEach(function (g) {
      var y = L.rowY.get(g);
      if (y > MARGIN) els.nodes.appendChild(el('div', { class: 'gen-band', style: 'top:' + (y - (ROW_H - NODE_H) / 2 + 26) + 'px' }));
      els.nodes.appendChild(el('div', { class: 'gen-label', style: 'top:' + y + 'px;height:' + NODE_H + 'px', text: 'Gen ' + g }));
    });

    // Each family's connector is a "bus": parents drop onto a horizontal bar,
    // children hang off it. Buses in the same row whose spans overlap get
    // different heights (greedy interval colouring), and each family gets its
    // own hue, so a parent's drop line that happens to share a column with
    // someone else's child can't be misread as one continuous line.
    var byRow = new Map();
    L.families.forEach(function (fam) {
      var xs = fam.parents.concat(fam.kids).map(function (id) { return L.pos.get(id).x + NODE_W / 2; });
      fam.minX = Math.min.apply(null, xs);
      fam.maxX = Math.max.apply(null, xs);
      fam.kidTop = Math.min.apply(null, fam.kids.map(function (id) { return L.pos.get(id).y; }));
      if (!byRow.has(fam.kidTop)) byRow.set(fam.kidTop, []);
      byRow.get(fam.kidTop).push(fam);
    });
    var colorIdx = 0;
    byRow.forEach(function (fams, kidTop) {
      fams.sort(function (a, b) { return a.minX - b.minX; });
      var levelEnds = [];
      fams.forEach(function (fam) {
        var lvl = levelEnds.findIndex(function (end) { return end < fam.minX - 12; });
        if (lvl === -1) { lvl = levelEnds.length; levelEnds.push(0); }
        levelEnds[lvl] = fam.maxX;
        fam.level = lvl;
      });
      var gap = ROW_H - NODE_H;
      var step = Math.min(14, (gap - 24) / Math.max(1, levelEnds.length - 1));
      fams.forEach(function (fam) {
        var busY = kidTop - gap / 2 + (fam.level - (levelEnds.length - 1) / 2) * step;
        var d = '';
        fam.parents.forEach(function (id) {
          var p = L.pos.get(id);
          d += 'M' + (p.x + NODE_W / 2) + ',' + (p.y + NODE_H) + 'V' + busY;
        });
        fam.kids.forEach(function (id) {
          var c = L.pos.get(id);
          d += 'M' + (c.x + NODE_W / 2) + ',' + busY + 'V' + c.y;
        });
        d += 'M' + fam.minX + ',' + busY + 'H' + fam.maxX;
        var path = document.createElementNS(SVG, 'path');
        path.setAttribute('d', d);
        path.style.stroke = FAMILY_HUES[colorIdx++ % FAMILY_HUES.length];
        els.links.appendChild(path);
        state.familyEls.push({ el: path, members: fam.parents.concat(fam.kids) });
      });
    });

    state.people.forEach(function (p) {
      var at = L.pos.get(p.id);
      var age = ageText(p);
      var hasNotes = notesOf(p).length > 0;
      var node = el('button', {
        type: 'button',
        class: 'node ' + (p.gender === 'female' ? 'female' : 'male'),
        style: 'left:' + at.x + 'px;top:' + at.y + 'px;width:' + NODE_W + 'px;height:' + NODE_H + 'px',
        'data-id': p.id,
        'aria-label': displayName(p) + ', generation ' + p.generation + (hasNotes ? ', has AI-gathered notes' : ''),
        onclick: function () { select(p.id, { scroll: false }); }
      }, [
        el('span', { class: 'n-name', text: displayName(p) }),
        el('span', { class: 'n-meta', text: genderLabel(p.gender) + (age ? ' · age ' + age : '') }),
        hasNotes ? el('span', { class: 'n-ai', title: 'Has AI-gathered notes', text: '🤖' }) : null
      ]);
      els.nodes.appendChild(node);
      state.nodeEls.set(p.id, node);
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
    var first = state.people.filter(function (p) { return p.generation === L.gens[0]; });
    if (!first.length) return;
    var xs = first.map(function (p) { return L.pos.get(p.id).x + NODE_W / 2; });
    var mid = (Math.min.apply(null, xs) + Math.max.apply(null, xs)) / 2;
    els.viewport.scrollLeft = mid * state.zoom - els.viewport.clientWidth / 2;
  }

  function centerOn(id) {
    var at = state.layout.pos.get(id);
    if (!at) return;
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
    return ids;
  }

  function select(id, opts) {
    if (!state.index || !state.index.byId.has(id)) return;
    opts = opts || {};
    state.selectedId = id;
    var related = relatedIds(id);
    state.nodeEls.forEach(function (node, nid) {
      node.classList.toggle('selected', nid === id);
      node.classList.toggle('related', related.has(nid));
    });
    state.familyEls.forEach(function (f) { f.el.classList.toggle('active', f.members.indexOf(id) !== -1); });
    // Put highlighted connectors on top so they're not hidden under grey ones.
    state.familyEls.forEach(function (f) { if (f.el.classList.contains('active')) els.links.appendChild(f.el); });

    renderDetail(id);
    markCurrentResult();
    if (history.replaceState) history.replaceState(null, '', '#person=' + encodeURIComponent(id));

    var node = state.nodeEls.get(id);
    if (opts.scroll && node) {
      centerOn(id);
      node.classList.remove('pulse');
      void node.offsetWidth; // restart the animation on repeat jumps
      node.classList.add('pulse');
    }
  }

  function closeDetail() {
    els.detail.hidden = true;
    els.sizer.style.marginBottom = '';
    state.selectedId = null;
    state.nodeEls.forEach(function (n) { n.classList.remove('selected', 'related'); });
    state.familyEls.forEach(function (f) { f.el.classList.remove('active'); });
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

  function renderDetail(id) {
    var idx = state.index;
    var p = idx.byId.get(id);
    var notes = notesOf(p);
    var age = ageText(p);

    var parentLink = function (pid) {
      return pid && idx.byId.has(pid) ? personLink(pid) : el('span', { class: 'none', text: 'Not recorded' });
    };

    var fields = el('dl', { class: 'fields' }, [
      el('dt', { text: 'Generation' }), el('dd', { text: F.isPositiveInt(p.generation) ? String(p.generation) : '?' }),
      el('dt', { text: 'Gender' }), el('dd', { text: genderLabel(p.gender) }),
      el('dt', { text: 'Age' }), el('dd', null, [age ? age + ' years' : el('span', { class: 'none', text: 'Unknown' })]),
      el('dt', { text: 'Mom' }), el('dd', null, [parentLink(p.mom)]),
      el('dt', { text: 'Dad' }), el('dd', null, [parentLink(p.dad)]),
      el('dt', { text: 'Children' }), el('dd', null, [linksOrNone(idx.childrenOf.get(id).map(function (c) { return personLink(c); }), 'None recorded')]),
      el('dt', { text: 'Siblings' }), el('dd', null, [linksOrNone(idx.siblingsOf.get(id).map(function (s) { return personLink(s.id, SIBLING_KIND[s.kind]); }), 'None recorded')])
    ]);

    var notesSection;
    if (notes.length) {
      notesSection = el('section', { class: 'notes-section' }, [
        el('h3', null, ['Notes', el('span', { class: 'ai-badge', text: '🤖 AI-gathered notes' })]),
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
        notes.length ? el('span', { class: 'ai-badge', text: '🤖 AI-gathered notes' }) : null
      ]),
      fields,
      notesSection
    );
    els.detail.hidden = false;
    els.detail.scrollTop = 0;
  }

  function renderNote(n) {
    var refs = Array.isArray(n.refs) ? n.refs.filter(function (r) { return typeof r === 'string' && r.trim(); }) : [];
    var quotes = Array.isArray(n.quotes) ? n.quotes.filter(function (q) { return q && typeof q.text === 'string'; }) : [];
    return el('article', { class: 'note' }, [
      el('p', { class: 'note-commentary' }, [el('span', { class: 'who', text: 'AI commentary:' }), linkifiedText(n.text)]),
      // Scripture is set apart from the commentary so a reader can always
      // tell the source text from the AI's paraphrase of it.
      el('div', null, quotes.map(function (q) {
        return el('blockquote', { class: 'verse' }, [
          el('p', { text: '“' + q.text + '”' }),
          el('cite', null, ['— ', typeof q.ref === 'string' && q.ref ? refLink(q.ref, q.ref + ' (KJV)') : 'unknown reference'])
        ]);
      })),
      el('div', { class: 'note-refs' }, refs.length
        ? [el('span', { text: 'Sources:' })].concat(refs.map(function (r) { return refLink(r); }))
        : [el('span', { class: 'none', text: '⚠ No source reference recorded for this note' })])
    ]);
  }

  els.detailClose.addEventListener('click', closeDetail);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !els.detail.hidden && document.activeElement !== els.search) closeDetail();
  });

  // ---------------------------------------------------------------- search & filters

  function filtersActive() {
    return !!(els.search.value.trim() || els.genSel.value || els.genderSel.value);
  }

  function currentMatches() {
    var q = fold(els.search.value.trim());
    var gen = els.genSel.value ? Number(els.genSel.value) : null;
    var gender = els.genderSel.value || null;
    return state.people
      .filter(function (p) {
        return (!q || fold(displayName(p)).indexOf(q) !== -1) &&
          (gen === null || p.generation === gen) &&
          (!gender || p.gender === gender);
      })
      .sort(function (a, b) { return a.generation - b.generation; }); // stable: data order within a generation
  }

  function highlighted(name, q) {
    if (!q) return [name];
    var i = fold(name).indexOf(q);
    if (i === -1) return [name];
    // fold() can change length for some scripts; only highlight when it didn't.
    if (fold(name).length !== name.length) return [name];
    return [name.slice(0, i), el('mark', { text: name.slice(i, i + q.length) }), name.slice(i + q.length)];
  }

  function applyFilters() {
    if (!state.layout) return;
    var active = filtersActive();
    var matches = currentMatches();
    var matchSet = new Set(matches.map(function (p) { return p.id; }));
    var q = fold(els.search.value.trim());

    els.clear.hidden = !active;
    els.resultsPane.classList.toggle('active', active);
    if (active) setResultsCollapsed(false);

    state.nodeEls.forEach(function (node, id) {
      node.classList.toggle('dim', active && !matchSet.has(id));
      node.classList.toggle('match', active && matchSet.has(id));
    });

    els.resultsCount.textContent = active
      ? matches.length + (matches.length === 1 ? ' match' : ' matches')
      : 'All ' + matches.length + ' people';

    if (!matches.length) {
      var term = els.search.value.trim();
      els.results.replaceChildren(el('li', { class: 'empty-state' }, [
        el('span', { class: 'big', text: '🔍' }),
        el('strong', { text: term ? 'No matches for “' + term + '”' : 'No one matches these filters' }),
        el('p', { text: 'Try a shorter name, or clear the filters to see everyone.' }),
        el('button', { class: 'btn', type: 'button', onclick: clearFilters, text: 'Clear search & filters' })
      ]));
      return;
    }

    els.results.replaceChildren.apply(els.results, matches.map(function (p) {
      var age = ageText(p);
      var hasNotes = notesOf(p).length > 0;
      return el('li', null, [el('button', {
        type: 'button',
        'data-id': p.id,
        onclick: function () {
          select(p.id, { scroll: true });
          // On phones, fold the list away so the tree and sheet have room.
          if (narrowMQ.matches) setResultsCollapsed(true);
        }
      }, [
        el('div', { class: 'r-name' }, highlighted(displayName(p), q).concat(hasNotes ? [' 🤖'] : [])),
        el('div', { class: 'r-meta', text: 'Gen ' + p.generation + ' · ' + genderLabel(p.gender) + (age ? ' · age ' + age : '') })
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

  function clearFilters() {
    els.search.value = '';
    els.genSel.value = '';
    els.genderSel.value = '';
    applyFilters();
  }

  els.search.addEventListener('input', applyFilters);
  els.genSel.addEventListener('change', applyFilters);
  els.genderSel.addEventListener('change', applyFilters);
  els.clear.addEventListener('click', clearFilters);
  els.resultsToggle.addEventListener('click', function () {
    setResultsCollapsed(!els.resultsPane.classList.contains('collapsed'));
  });
  els.search.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      var first = currentMatches()[0];
      if (first) {
        select(first.id, { scroll: true });
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
