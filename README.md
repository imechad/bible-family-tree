# Bible Family Tree Explorer

A self-hosted, single-page family tree explorer: a pannable/zoomable tree laid out in
generation rows, instant name search with Generation and Gender filters, and a detail
panel showing each person's relatives and scripture-cited, AI-gathered notes.

> **⚠ Phase 1 — MOCK DATA.** `data/people.json` currently holds an invented demo family
> (the "Vell" dynasty, 30 people over 7 generations). None of them are Bible characters.
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
gender and an earlier generation, derived children and siblings agree with the parent
links, every note cites at least one valid reference, and generations are positive
integers. It also boots the server on a free port and checks that `/api/people` returns
the array and that a malformed file produces an error instead of a crash.
**Run this after every data edit.** It tells you exactly which person and field is wrong.

## What the app does

- **Tree:** one row per generation (generation 1 at the top), with connector lines from
  parents to children. Each family's lines get their own colour, and the selected
  person's family lines turn gold. Pan by dragging with the mouse or swiping on touch.
  Zoom with the − / + buttons or Ctrl/⌘ + scroll.
- **Search and filters:** search names instantly (case- and accent-insensitive), and filter
  by Generation and Gender. Clicking a result (or pressing Enter for the first match)
  jumps to that person, highlights them, and opens their details. Non-matching cards are
  dimmed while a search is active.
- **Detail panel:** shows Generation, Gender, Age, Mom, Dad, Children and Siblings. Every
  relative is a clickable link. Siblings are labelled `half · same mother` and so on when
  they share only one parent. On phones the panel becomes a bottom sheet.
- **AI-gathered notes:** these are marked with a 🤖 badge and a standing disclaimer.
  Quoted scripture is shown as a separate blockquote, apart from the AI's commentary.
  Every reference links to that exact passage on BibleGateway (KJV), for example
  `Genesis 4:25` →
  `https://www.biblegateway.com/passage/?search=Genesis%204%3A25&version=KJV`.
- **Deep links:** `http://localhost:8095/#person=<id>` opens with that person selected.

## Data: `data/people.json`

One flat JSON array, one object per person. **Only parent links are stored.** Children
and siblings are computed when the page loads, so each relationship is written down
exactly once.

### Person shape

| field        | type                          | notes |
|--------------|-------------------------------|-------|
| `id`         | string, unique                | Stable and never reused. Use kebab-case, e.g. `"seth"`, `"jacob-son-of-isaac"`. |
| `name`       | string                        | Display name. |
| `gender`     | `"male"` \| `"female"`        | |
| `generation` | positive integer              | 1 = top row. Must be greater than both parents' generations. |
| `age`        | number \| `null`              | `null` if scripture doesn't say. |
| `mom`        | id \| `null`                  | Must be the id of a `"female"` person. |
| `dad`        | id \| `null`                  | Must be the id of a `"male"` person. |
| `notes`      | array (use `[]` for none)     | See below. |

**Do not** add `children` or `siblings` fields. They are derived, and the test rejects them.
List siblings in birth order within the file, because the tree shows them left to right in
file order.

### Note shape

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
  "notes": [
    {
      "text": "Commentary written by the AI, summarising what the passage says about this person. See also Genesis 5:6.",
      "quotes": [
        { "ref": "Genesis 4:25", "text": "Exact KJV text of the verse goes here." }
      ],
      "refs": ["Genesis 4:25", "Genesis 5:6"]
    }
  ]
}
```

### Adding a person (phase 2 workflow)

1. Append an object like the one above to the array in `data/people.json`.
2. Set `mom` / `dad` to existing ids, or `null` when unknown.
3. Run `node tests/data.test.js` and fix anything it reports.
4. Refresh the browser.

## Project layout

```
server.js            zero-dependency HTTP server (port 8095), GET /api/people
data/people.json     ALL people: the only file to edit for new data
public/index.html    page shell
public/styles.css    dark, responsive theme (desktop + iPhone)
public/family.js     shared logic: derive children/siblings, validate, verse links
                     (used by both the browser and the tests)
public/app.js        tree layout/rendering, search, filters, detail panel
tests/data.test.js   data integrity + server smoke tests (plain node)
```
