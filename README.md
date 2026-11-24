# Bible Family Tree Explorer

A self-hosted, single-page family tree explorer: a pannable/zoomable tree laid out in
generation rows, where each couple's lines meet at a small junction and their children
fan out below it, a build-your-own Filters panel where every field has its own controls
(contains boxes for name/mom/dad, is / is between / is unknown for generation and age, a
gender dropdown, amount or name for child/sibling/spouse, has / no / contains for notes),
and a detail panel showing each person's relatives and scripture-cited, AI-gathered notes.

> **⚠ Phase 1 — MOCK DATA.** `data/people.json` currently holds an invented demo family
> (the "Vell" dynasty, 34 people over 7 generations plus one relative of unknown
> generation, including a remarriage and a childless couple). None of them are Bible
> characters.
> The notes are made-up demo text; they cite real Genesis verses only so the verse links
> can be clicked and checked. Real Bible characters arrive in phase 2, **by editing the
> data file only**. No code changes needed.

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
integer or `"unknown"`. It also unit-tests union derivation (couples, single parents,
childless couples, remarriage), the junction geometry (pink/blue parent lines meet one
pill, the children's lines fan out from it, a childless couple keeps the pill with no
child lines), and the filter builder's logic (every field's operators, blank-row
inertness, AND-combined rows, and the badge count) and multi-note rendering, then boots
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
- **Detail panel:** shows Generation, Gender, Age, Mom, Dad, Spouses, Children and
  Siblings. Every relative is a clickable link. When someone has children by more than
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
- **Deep links:** `http://localhost:8095/#person=<id>` opens with that person selected.

## Data: `data/people.json`

One flat JSON array, one object per person. **Only parent and spouse links are stored.**
Children, siblings and unions (each drawn with its own junction) are computed when the page loads. Each parent link
is written once, on the child. A marriage is written on **both** spouses, so either
record reads correctly on its own, and the test checks that the two sides agree.

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
3. Run `node tests/data.test.js` and fix anything it reports.
4. Refresh the browser.

## Project layout

```
server.js            zero-dependency HTTP server (port 8095), GET /api/people
data/people.json     ALL people: the only file to edit for new data
public/index.html    page shell
public/styles.css    dark, responsive theme (desktop + iPhone)
public/family.js     shared logic: derive children/siblings/spouses and unions,
                     junction geometry, validate, filter-builder logic, note views, verse links
                     (used by both the browser and the tests)
public/app.js        union/junction tree layout and rendering, drawn SVG icons, filter builder UI, detail panel
tests/data.test.js   data integrity + server smoke tests (plain node)
```
