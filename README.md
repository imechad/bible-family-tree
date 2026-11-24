# Bible Family Tree Explorer

A self-hosted, single-page family tree explorer: a pannable/zoomable tree of family
blocks laid out in generation rows, instant search by anything attached to a person
(their name, kids, parents, spouses, siblings, notes) with Generation and Gender filters,
and a detail panel showing each person's relatives and scripture-cited, AI-gathered notes.

> **⚠ Phase 1 — MOCK DATA.** `data/people.json` currently holds an invented demo family
> (the "Vell" dynasty, 33 people over 7 generations, including a remarriage and a
> childless couple). None of them are Bible characters.
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
links, every note cites at least one valid reference, and generations are positive
integers. It also unit-tests family-block derivation (couples, single parents, childless
couples, remarriage), search (by a kid's name, comma lists, prefixes) and multi-note
rendering, then boots the server on a free port and checks that `/api/people` returns the
array and that a malformed file produces an error instead of a crash.
**Run this after every data edit.** It tells you exactly which person and field is wrong.

## What the app does

- **Tree:** one row per generation (generation 1 at the top). Every union is drawn as
  a bordered **family block**: the two parent cards side by side, **mom always on the
  left, dad always on the right**. One trunk line drops from the bottom-centre of the
  block and branches to each child, so parentage is never ambiguous.
  - Cards are colour-coded by gender (pink-tinted ♀ female, blue-tinted ♂ male) and a
    legend in the corner of the tree explains it.
  - A single parent with children is a one-person block.
  - A married couple without children is still a block (dashed border), just with no
    child lines.
  - A remarried person is drawn once in **each** of their family blocks, with a small
    `⧉ 1/2` / `⧉ 2/2` marker. Their own parents' line goes to the first copy, and both
    copies light up when selected.
  - Each family's lines and block border share a colour. The selected person's blocks and
    lines turn gold. Pan by dragging with the mouse or swiping on touch. Zoom with the
    − / + buttons or Ctrl/⌘ + scroll.
- **Search and filters:** search is instant and case- and accent-insensitive. It matches
  **anything attached to a person**: their own name, generation, gender, age, their
  mom's, dad's, kids', spouses' and siblings' names, and the text of their notes. Typing
  a child's name brings up that child's parents (and typing a parent's name brings up
  their children). Each result carries a chip saying *why* it matched, e.g.
  `kid: Lisska Arlo`, `sibling: Lisska Arlo` or `notes: "…orchard on the hill…"`.
  - **Lists:** `Lisska, Briar` shows everyone matching *any* of the names.
  - **Prefixes** target one role: `kid:` (alias `child:`), `mom:`, `dad:`, `spouse:`
    (`wife:`/`husband:`), `sibling:`, `gen:`, `gender:`, `age:`, plus `name:` and `notes:`.
    `kid:Briar` returns Briar's parent. A prefix applies to the comma-separated values
    that follow it until the next prefix: `kid:Briar, Wick` finds the parents of either.
    `gen:` and `age:` take a number or a range (`age:60-70`). `gender:f` matches female.
  - A bare number (e.g. `3`) matches generation or age only, not verse numbers in notes.
    Relative and note matches must start a word (so `wick` doesn't pull in every relative
    of *Fenwick*). Own-name matches are plain substrings as before, but ranked after
    word-start hits.
  - Results are ordered: own-name hits, then relatives, then generation/gender/age, then
    notes, each by generation. The Generation and Gender dropdowns narrow the results
    further, exactly as before. Clicking a result (or pressing Enter for the first match)
    jumps to that person, highlights them, and opens their details. Non-matching cards
    are dimmed while a search is active.
- **Detail panel:** shows Generation, Gender, Age, Mom, Dad, Spouses, Children and
  Siblings. Every relative is a clickable link. When someone has children by more than
  one partner, each child is tagged `(with <other parent>)`. Siblings are labelled `half · same mother` and so on when
  they share only one parent. On phones the panel becomes a bottom sheet.
- **AI-gathered notes:** these are marked with an ℹ️ "AI-gathered notes" badge (on tree
  cards, search results and the detail panel) and a standing disclaimer. A person can have
  several notes. Each one renders as its own numbered entry ("Note 2 of 3") with its own
  commentary, its own quoted verses and its own source links. Quoted scripture is shown as
  a separate blockquote, apart from the AI's commentary.
  Every reference links to that exact passage on BibleGateway (KJV), for example
  `Genesis 4:25` →
  `https://www.biblegateway.com/passage/?search=Genesis%204%3A25&version=KJV`.
- **Deep links:** `http://localhost:8095/#person=<id>` opens with that person selected.

## Data: `data/people.json`

One flat JSON array, one object per person. **Only parent and spouse links are stored.**
Children, siblings and family blocks are computed when the page loads. Each parent link
is written once, on the child. A marriage is written on **both** spouses, so either
record reads correctly on its own, and the test checks that the two sides agree.

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
| `spouses`    | array of ids (use `[]` for none) | Zero, one, or several. **Mutual:** if A lists B, B must list A. A spouse must be the opposite gender (a family block has a mom slot and a dad slot). Order matters for a remarried person: list the first marriage first; that block is where their own parents' line lands. |
| `notes`      | array (use `[]` for none)     | Zero, one, or several notes. Each renders as its own entry. See below. |

**Do not** add `children` or `siblings` fields. They are derived, and the test rejects them.
List siblings in birth order within the file, because the tree shows them left to right in
file order.

**Family blocks** are derived, too. There is one per married couple (whether or not they
have children), one per (mom, dad) pair who share a child, and one per single parent
(a child whose other parent is `null`). Co-parents don't *have* to be listed as spouses,
because not every union in scripture is a marriage, but they still get a shared block. If
spouses are in different generations, their block sits on the later generation's row.

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
2. Set `mom` / `dad` to existing ids, or `null` when unknown. For a marriage, add each
   spouse's id to the other's `spouses` list.
3. Run `node tests/data.test.js` and fix anything it reports.
4. Refresh the browser.

## Project layout

```
server.js            zero-dependency HTTP server (port 8095), GET /api/people
data/people.json     ALL people: the only file to edit for new data
public/index.html    page shell
public/styles.css    dark, responsive theme (desktop + iPhone)
public/family.js     shared logic: derive children/siblings/spouses and family blocks,
                     validate, search, note views, verse links
                     (used by both the browser and the tests)
public/app.js        family-block tree layout/rendering, search UI, filters, detail panel
tests/data.test.js   data integrity + server smoke tests (plain node)
```
