# Bible Family Tree Explorer

A self-hosted, single-page family tree explorer: a pannable/zoomable tree laid out in
generation rows, where each couple's lines meet at a small junction and their children
fan out below it, a build-your-own Filters panel where every field has its own controls
(contains boxes for name/mom/dad, is / is between / is unknown for generation and age, a
gender dropdown, amount or name for child/sibling/spouse, has / no / contains for notes),
a detail panel showing each person's relatives and scripture-cited, AI-gathered notes,
and a built-in KJV Bible reader whose highlighted names jump straight to that person in
the tree.

> **⚠ Phase 1.5 — MOCK DATA + the first real people.** `data/people.json` holds two kinds
> of people side by side:
> - **The Vell family is invented demo data** (the "Vell" dynasty, 34 people over 7
>   generations plus one relative of unknown generation, including a remarriage and a
>   childless couple). None of them are Bible characters. Their notes are made-up demo
>   text that cites real Genesis verses only so the links can be clicked and checked,
>   and their `firstMention` values are **demo placeholders**: real Genesis 4–11 verses
>   picked so the reader has something to open — their invented names never occur in
>   scripture.
> - **Adam's family (Genesis 2–5) is the first real data:** Adam, Eve, Cain, Abel and
>   Seth, with real first-mention verses.
>
> The rest of scripture arrives through phase 2, **by editing the data files only**. No
> code changes needed.

## Run it

Requires Node.js 18+. No `npm install` needed: there are zero dependencies.

```sh
node server.js
# → Bible Family Tree Explorer listening on http://localhost:8095
```

Open <http://localhost:8095>. It also works from a phone on the same network
(`http://<this-machine's-IP>:8095`).

The server always uses **port 8095**. `data/people.json` is re-read on every request, so
after editing it just refresh the browser. If the file isn't valid JSON, the page shows
the parser error (with its position) and a Retry button. The server keeps running.

## Test it

```sh
node tests/data.test.js
```

This checks data integrity: ids are unique, every mom/dad id exists and has the right
gender and an earlier generation, every spouse id exists and the link is recorded on
**both** people (female + male), derived children and siblings agree with the parent
links, every note cites at least one valid reference, and generations are a positive
integer or `"unknown"`, every person has a single-verse `firstMention` that exists in the
KJV text, and the bundled KJV files are complete (66 books, 31,102 verses). It also unit-tests union derivation (couples, single parents,
childless couples, remarriage), the junction geometry (pink/blue parent lines meet one
pill, the children's lines fan out from it, a childless couple keeps the pill with no
child lines), and the filter builder's logic (every field's operators, blank-row
inertness, AND-combined rows, and the badge count), multi-note rendering and the reader's
name resolution (unique names, first-mention anchors, `mentions.json` overrides, and
"ambiguous stays plain text"), then boots
the server on a free port and checks that `/api/people` returns the
array and that a malformed file produces an error instead of a crash.
**Run this after every data edit.** It tells you exactly which person and field is wrong.

## What the app does

- **Tree:** one row per generation (generation 1 at the top). Every parent is their own
  separate card. There are no boxes around couples. A couple's cards sit side by side,
  **mom always on the left, dad always on the right**. Between and below them is a small
  orange-red **junction** pill, one per union:
  - A **blue line** runs from the dad down to the junction, and a **pink line** runs from
    the mom down to it. These are the same colours as the cards.
  - A **light grey line** runs from the junction to each of that union's children, so all
    siblings fan out from one shared meeting point and parentage is never ambiguous. It is
    near-white so every child line stands out on the dark canvas (desktop and phone), and
    neutral so it never reads as a parent's pink or blue line.
  - Cards are colour-coded by gender (pink-tinted ♀ female, blue-tinted ♂ male) and a
    legend in the corner of the tree explains the pink, blue and light child lines and the junction. On phones the
    legend shrinks to the two line-colour entries so it doesn't cover the tree.
  - A single parent with children still gets a junction: their one coloured line drops
    to it and the children fan out from there.
  - A married couple without children keeps the junction between them, so the
    marriage stays visible, but it has no child lines.
  - A remarried person is drawn once in **each** union, with a small `⧉ 1/2` / `⧉ 2/2`
    marker. Each union has its own junction. Their own parents' line goes to the first
    copy, and both copies light up when selected.
  - People whose generation is unknown ("unknown cousin" types) appear in a trailing
    **? generation** band below the numbered rows, drawn as standalone cards.
  - Selecting someone highlights their unions: lines get thicker, child lines turn white
    with a gold edge, and the junction gets a gold ring. Parent lines keep their pink/blue colour.
    Pan by dragging with the mouse or swiping on touch. Zoom with the − / + buttons or
    Ctrl/⌘ + scroll.
- **Filters:** the **Filters** button opens a build-your-own panel. **Add filter** starts
  a row; each row is one condition, and every row must match (rows combine with AND).
  Each field decides its own controls:
  - **Name** — a contains box, matched case-insensitively against anyone's name.
  - **Generation** and **Age** — an operator dropdown with `is`, `is between` and
    `is unknown`. `is` shows one box, `is between` shows two (inclusive range), and
    `is unknown` shows no box at all and matches people whose value isn't recorded.
  - **Gender** — a dropdown: male, female, or unknown.
  - **Mom** / **Dad** — a contains box on the parent's name (mom references are female
    people, dad references are male). A person whose mom/dad is unknown or none doesn't
    match a typed name.
  - **Child** / **Sibling** / **Spouse** — an operator dropdown with `amount`,
    `amount range` and `name`. `amount` is one number box (exact count), `amount range`
    is two number boxes (inclusive), `name` is a contains box on any one listed person's
    name. Searching by name finds one person at a time — to look for several, add more rows.
  - **Notes** — an operator dropdown with `has note`, `no note` and `note contains`; the
    text box appears only for `note contains` and matches the note text.

  A blank box never filters anything (the row just sits inert), so half-typed text never
  empties the list. Everything applies as you type: the result count, the panel's
  "N people shown" line, the results list and the dimming on the tree all update
  immediately. While any filter is on, the button shows a gold count badge (one per
  active row), so you can see at a glance why the list is shorter. **Clear filters** in
  the panel resets every row, and the top-bar **Clear** button (and the one in the
  "No one matches these filters" message) does the same. Close the panel with ✕, Escape,
  or a click outside it. On desktop it drops down under the button. On phones it opens
  as a bottom sheet that spans the screen width and scrolls inside itself.
- **Detail panel:** shows Generation, Gender, Age, Mom, Dad, Spouses, Children, First
  mention and Siblings. Every relative is a clickable link. When someone has children by more than
  one partner, each child is tagged `(with <other parent>)`. Siblings are labelled `half · same mother` and so on when
  they share only one parent. On phones the panel becomes a bottom sheet.
- **AI-gathered notes:** these are marked with a drawn info icon (an inline SVG circled
  "i", not an emoji, so it looks the same on every device). It appears on tree cards,
  in the results list and in the legend. In the detail panel it sits next to an
  "AI-gathered notes" badge with a standing disclaimer. A person can have
  several notes. Each one renders as its own numbered entry ("Note 2 of 3") with its own
  commentary, its own quoted verses and its own source links. Quoted scripture is shown as
  a separate blockquote, apart from the AI's commentary.
  Every reference links to that exact passage on BibleGateway (KJV), for example
  `Genesis 4:25` →
  `https://www.biblegateway.com/passage/?search=Genesis%204%3A25&version=KJV`.
- **First mention:** the detail panel's **First mention** row shows the verse where the
  person is first named, linked twice: `Genesis 2:19 ↗` opens it on BibleGateway, and
  **Read here** opens the built-in reader at that verse.
- **Deep links:** `http://localhost:8095/#person=<id>` opens with that person selected;
  `#read=Genesis+2:19` opens the Bible reader (see below).

## Reading the Bible

The **Bible** button next to **Filters** opens the King James Version inside the app. It
uses the same panel pattern as Filters: it drops down under the button on desktop and is
a full-width bottom sheet on phones; ✕, Escape, or a tap outside / on the dimmed
backdrop closes it.

- **Navigation:** a book dropdown (all 66 books in canonical order) and a chapter stepper
  (`‹ Genesis 2 ›`). The stepper crosses book boundaries (`›` on Genesis 50 goes to
  Exodus 1). Each book's text is downloaded the first time it is opened and kept in
  memory after that.
- **Deep links:** `#read=Genesis+2` opens Genesis 2; `#read=Genesis+2:19` also scrolls
  verse 19 into view and briefly highlights it. Book names use the same spellings as
  everywhere else (`#read=1+Samuel+3:4`, `#read=Song+of+Solomon+1`). Opening the reader
  puts its location in the address bar; closing it removes it (and restores
  `#person=<id>` if someone is still selected). A reader link and a person link are never
  in the address bar at the same time.
- **Highlighted names:** every name of a documented person (anyone in
  `data/people.json`) is highlighted in gold. Tap it and the reader closes, and that
  person is selected exactly as if you had tapped them in the results list: their card
  is highlighted and scrolled into view and their detail panel opens.

### How a name is matched to a person

A name matches as a whole phrase, ignoring case: `Adam` matches "Adam" and "Adam's" but
never "adamant", and a hyphenated compound is one word (`Cain` does not match inside
"Tubal-cain"). A multi-word name such as `Garrow Vell` matches only as those words side by
side. Where names overlap, the longest wins.

Each occurrence is then resolved to **exactly one** person, in this order:

1. **Only one person has that name** → that person.
2. **Several people share the name** and this verse is one of their `firstMention`
   verses (claimed by exactly one of them) → that person. A first-mention verse names
   its person by definition.
3. **Several share the name in a later verse** → `data/mentions.json` says who is meant
   (see below).
4. **Still ambiguous** → the name is left as **plain text**. The app never guesses and
   never jumps to "just anyone with that name": a link to the wrong person is worse than
   no link.

### `data/mentions.json` — resolving repeated names (phase 2)

Optional. When two or more people share a name, list each later verse where the name
refers to a specific one of them:

```json
{
  "John 19:25": { "Mary": "mary-wife-of-clopas" },
  "Luke 2:5":   { "Mary": "mary-mother-of-jesus", "Joseph": "joseph-husband-of-mary" }
}
```

- Keys are single verses (`Book C:V`, same spellings as `refs`; no ranges).
- Inside each verse, keys are **display names** exactly as in `people.json` (matched
  ignoring case) and values are person **ids**. The id must belong to someone with that
  display name.
- Unique names don't need entries; neither does a person's own `firstMention` verse.
- `node tests/data.test.js` cross-checks the file (every ref is a real single verse,
  every id exists and carries that name). A missing file is fine and means "no
  overrides".
- **Served live:** the app reads this file through `GET /api/mentions`, which
  `server.js` re-reads on every request (edit, refresh — same as `people.json`). A
  missing file returns `{}`; malformed JSON returns a 500 with the parser's message.

### Bible text

The text is the public-domain **King James Version (KJV)**, taken from the
[thiagobodruk/bible](https://github.com/thiagobodruk/bible) repository and stored as one
JSON file per book in `public/kjv/` (`{"book":"Genesis","chapters":[["verse 1", …], …]}`,
verse *n* at index *n−1*) plus `public/kjv/index.json` listing the books in order. The
server serves them as ordinary static files.

## Data: `data/people.json`

One flat JSON array, one object per person. **Only parent and spouse links are stored.**
Children, siblings and unions (each drawn with its own junction) are computed when the page loads. Each parent link
is written once, on the child. A marriage is written on **both** spouses, so either
record reads correctly on its own, and the test checks that the two sides agree.

People with the same name are fully supported and stay distinct individuals: every
link (`mom`, `dad`, `spouses`) is by id, never by name. When two people share a name,
give them fuller display names (e.g. `"Mary, wife of Clopas"` vs `"Mary Magdalene"`)
so their cards are easy to tell apart at a glance.

### Person shape

| field        | type                          | notes |
|--------------|-------------------------------|-------|
| `id`         | string, unique                | Stable and never reused. Use kebab-case, e.g. `"seth"`, `"jacob-son-of-isaac"`. |
| `name`       | string                        | Display name. |
| `gender`     | `"male"` \| `"female"` \| `"unknown"` | `"unknown"` = the record doesn't say. |
| `generation` | positive integer \| `"unknown"` | 1 = top row. A number must be greater than both parents' generations (when known). `"unknown"` = can't be placed (shown in the ? generation band). |
| `age`        | number \| `"unknown"`         | `"unknown"` if the record doesn't say. |
| `mom`        | id \| `"unknown"` \| `"none"` | An id must be a `"female"` person (unknown-gender parents are allowed but the union can't draw a mom slot for them). `"unknown"` = not recorded. `"none"` = affirmatively no mother (first of their line). |
| `dad`        | id \| `"unknown"` \| `"none"` | An id must be a `"male"` person. `"unknown"` = not recorded. `"none"` = affirmatively no father (first of their line). |
| `spouses`    | array of ids (use `[]` for none) | Zero, one, or several. **Mutual:** if A lists B, B must list A. A spouse must be the opposite gender (a union has a mom slot and a dad slot). Order matters for a remarried person: list the first marriage first; that union is where their own parents' line lands. |
| `spousesState` | optional `"known"` \| `"none"` \| `"unknown"` | Absent = `"known"` (the list is authoritative). `"none"` = affirmatively never married. `"unknown"` = don't know whether they married. |
| `childrenState` | optional `"known"` \| `"none"` \| `"unknown"` | Same default. `"none"` = affirmatively childless. `"unknown"` = don't know whether they had children. |
| `siblingsState` | optional `"known"` \| `"none"` \| `"unknown"` | Same default. `"none"` = affirmatively an only child. |
| `firstMention` | single verse ref, **always filled** | The first verse where the person's name is **stated**, e.g. `"Genesis 2:19"` (where "Adam" is first named). Not where they are first *implied* ("the man", "his wife"). Exactly one verse: `Book C:V`; ranges (`Genesis 1:1-2`), lists and whole chapters are rejected. On the mock Vell family these are demo placeholders. |
| `notes`      | array (use `[]` for none)     | Zero, one, or several notes. Each renders as its own entry. See below. |

### Unknown vs None

These two states mean different things and the UI shows them differently:

- **`"unknown"`** — the record doesn't say. Scripture never named this person's mother, or
  their age is simply not recorded. Treat as a gap to be filled if a source turns up.
- **`"none"`** — affirmatively absent. This person had no children, never married, or is the
  first of their line with no father. This is a settled fact, not a gap.

Parent markers (`"unknown"`/`"none"` in `mom`/`dad`) are never person ids — they don't resolve
to anyone in the tree, and a founder with `mom`/`dad` = `"none"` can still have children.

**Do not** add `children` or `siblings` fields. They are derived, and the test rejects them.
List siblings in birth order within the file, because the tree shows them left to right in
file order.

**Unions** are derived, too. Each one is drawn as a junction pill. There is one per married couple (whether or not they
have children), one per (mom, dad) pair who share a child, and one per single parent
(a child whose other parent is `null`). Co-parents don't *have* to be listed as spouses,
because not every union in scripture is a marriage, but they still share a union and a junction. If
spouses are in different generations, their union sits on the later generation's row.

### Note shape

`notes` is an array, and every element is one self-contained note:

| field    | type                         | notes |
|----------|------------------------------|-------|
| `text`   | string                       | The AI's commentary. Any reference written in the text (e.g. "see Genesis 5:3") is linked automatically. |
| `refs`   | array of strings, at least 1 | Every passage the note draws on. Format: `Book Chapter:Verse`, a range like `Genesis 5:3-8` or `Genesis 1:1-2:3`, or a whole chapter like `Psalm 23`. Use full book names (`1 Samuel`, `Song of Solomon`). |
| `quotes` | optional array of `{ ref, text }` | Exact verse text, shown as a blockquote. Each `ref` must also appear in `refs`. |

### Copy-paste example

```json
{
  "id": "example-person",
  "name": "Example Person",
  "gender": "male",
  "generation": 3,
  "age": 120,
  "mom": "example-mother-id",
  "dad": "example-father-id",
  "spouses": ["example-first-wife-id", "example-second-wife-id"],
  "firstMention": "Genesis 4:25",
  "notes": [
    {
      "text": "Commentary written by the AI, summarising what the passage says about this person. See also Genesis 5:6.",
      "quotes": [
        { "ref": "Genesis 4:25", "text": "Exact KJV text of the verse goes here." }
      ],
      "refs": ["Genesis 4:25", "Genesis 5:6"]
    },
    {
      "text": "A second, separate note. It has its own sources and no quote.",
      "refs": ["Genesis 5:8"]
    }
  ]
}
```

### Adding a person (phase 2 workflow)

1. Append an object like the one above to the array in `data/people.json`.
2. Set `mom` / `dad` to existing ids, or `"unknown"`/`"none"` when there is no mother or
   father to name. For a marriage, add each spouse's id to the other's `spouses` list.
3. Set `firstMention` to the first verse that states their name. If someone else
   already has the same display name, add `data/mentions.json` entries for the later
   verses where the name means this person (see "Reading the Bible").
4. Run `node tests/data.test.js` and fix anything it reports.
5. Refresh the browser.

## Project layout

```
server.js            zero-dependency HTTP server (port 8095), GET /api/people
data/people.json     ALL people: the main file to edit for new data
data/mentions.json   optional: which person a repeated name means in a given verse
public/index.html    page shell
public/styles.css    dark, responsive theme (desktop + iPhone)
public/kjv/          public-domain KJV text, one JSON file per book + index.json
public/family.js     shared logic: derive children/siblings/spouses and unions,
                     junction geometry, validate, filter-builder logic, note views, verse links,
                     ref parsing and name-in-verse resolution for the reader
                     (used by both the browser and the tests)
public/app.js        union/junction tree layout and rendering, drawn SVG icons, filter builder UI,
                     detail panel, Bible reader
tests/data.test.js   data integrity + server smoke tests (plain node)
```
