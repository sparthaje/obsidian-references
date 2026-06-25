# Part 2 — Clickable references → reference notes → automatic paper graph

> Status: **planned / not yet implemented.** Part 1 (the references side panel that lists
> `[N] <title>` for the page you are viewing) is implemented. This document captures the
> goals, design, and open questions for Part 2 so it can be built deliberately later.

## Context & goal

Part 1 answers "what does this page cite?" Part 2 makes those citations *actionable and
durable* inside the vault:

When you click a reference `[12]` in the panel, Links should **open a markdown note for that
cited work** — creating it the first time, reusing it forever after — with an (initially empty)
`annotation-target` in its frontmatter, ready for you to paste the PDF URL. The note for the
paper you are reading gets a wikilink to that reference note.

The payoff compounds across your library:

- The **first** time any paper cites "Attention is all you need", the note `references/attention-is-all-you-need.md` is created.
- The **next** paper that cites it links to the *same* note — no duplicate.
- Obsidian's **graph view** now shows the real citation network between the papers you read.
- When you later paste a PDF URL into that reference note's `annotation-target`, opening it
  annotates *that* paper with Links — and its own citations start linking onward. The reading
  list grows itself.

So Part 2 turns a pile of PDFs into a connected, navigable knowledge graph, with zero manual
bookkeeping.

## The hard problem: canonical identity (deduplication)

Everything hinges on answering **"are these two citations the same work?"** so the second
citation links to the first one's note instead of making a new one. Reference strings differ
across papers (author order, abbreviations, venue formatting, "et al."), so we need a stable
**canonical key** per work and a deterministic note path derived from it.

Candidate identity signals, best → worst:

1. **arXiv id / DOI**, if present in the reference text (`arXiv:1706.03762`, `doi:10.../...`).
   Strongest; extractable by regex from the full reference string we already capture.
2. **Normalized title** — lowercase, strip punctuation/diacritics, collapse whitespace, drop a
   trailing period. Good enough for the common case where the title is extracted cleanly
   (Part 1's `guessTitle` already does most of this).
3. **Title + first author surname + year** — disambiguates identical-titled works.

**Recommendation:** key = arXiv-id/DOI if found, else `slug(normalizedTitle)` (optionally
`+ "-" + year`). Store the raw signals in the note's frontmatter so the key can be recomputed
/ migrated later. Accept that dedup is heuristic and occasionally wrong; make it easy to merge
two notes manually.

## Note shape

`references/<key>.md` (folder configurable in settings):

```md
---
annotation-target:            # <- paste the PDF URL here to start annotating this work
title: "Attention is all you need"
authors: "Vaswani, A. et al."
year: 2017
arxiv: 1706.03762             # whichever identity signals we found
aliases: ["[70] Attention is all you need"]
cited-by: ["[[Diffusion Policy (paper note)]]"]
---
```

- Empty `annotation-target` is the whole point: paste a URL later and the note becomes a
  first-class Links reader for that paper.
- `cited-by` and/or wikilinks in the *citing* note give the graph its edges (see below).

## Linking direction (what makes the graph light up)

Two complementary edges; we should write the first, optionally the second:

1. **Citing paper → reference note.** When `[12]` is clicked (or, later, automatically for every
   reference on a page), insert/maintain a wikilink in the *current paper's* annotation note —
   e.g. appended under a `## References` section: `- [12] [[references/attention-is-all-you-need|Attention is all you need]]`.
   This is the edge the graph needs.
2. **Reference note → citing papers.** Maintain a `cited-by` list in the reference note's
   frontmatter. Nice for backlinks/Dataview, but Obsidian backlinks already give this for free
   from edge #1, so this is optional.

## How clicking wires in (builds on Part 1)

Part 1 already produces, per reference, `{ number, title, fullText, destPage }`. Part 2 adds an
`onClick` on the panel row (replacing the current "jump to page" behavior, or as a second
action) that calls a new `ReferenceNotesService`:

```
onClickReference(ref, citingNotePath):
    key   = canonicalKey(ref)              # arXiv/DOI/slug(title)
    path  = `${settings.referencesFolder}/${key}.md`
    note  = vault.getAbstractFileByPath(path) ?? await createStubNote(path, ref)
    await ensureWikilink(citingNotePath, note, ref)   # add to "## References" if absent
    await app.workspace.getLeaf(...).openFile(note)   # open for the user to paste a URL
```

`createStubNote` writes the frontmatter template above. `ensureWikilink` is idempotent (no
duplicate links on repeat clicks). All of this uses APIs already in the codebase:
`app.vault.create/getAbstractFileByPath`, `app.fileManager.generateMarkdownLink` (used today in
`main.tsx`'s drag-drop handler), and `app.metadataCache` for frontmatter.

## Phased plan

1. **Identity + stub creation.** `canonicalKey()` + `createStubNote()`; clicking a row creates/opens
   the note. No linking yet. (Unblocks the "paste a URL later" workflow.)
2. **Citing-note linking.** `ensureWikilink()` maintains a `## References` section in the active
   paper's note → graph edges appear. Make it idempotent and safe to re-run.
3. **Backfill / automation.** Optional command: "link all references on this page" (loops Part 1's
   list), and "link every reference in this PDF". Optional `cited-by` maintenance.
4. **Settings & polish.** Reference folder path, key strategy (DOI/arXiv vs title), title-vs-fulltext
   in filenames, merge-notes helper for mis-deduplicated entries.

## Open questions / risks

- **Dedup precision vs. recall.** Title-only slugs can collide or, with imperfect `guessTitle`,
  fragment. Mitigation: prefer DOI/arXiv; store raw signals; provide a manual "merge into…" action.
- **Where do reference notes live**, and should the citing note's wikilinks be in the body
  (visible, graph-counted) or only frontmatter? Recommendation: body `## References` section.
- **Editing the citing note while it's in annotator (PDF) view.** The active note is rendered as a
  PDF, not markdown; we must modify the underlying file via `vault.process`/`modify`, not the editor.
- **Filename safety** for slugs (length, illegal chars, non-ASCII titles).
- **Title quality.** Part 1's `guessTitle` is good but heuristic; a wrong title yields a wrong
  slug/filename. Consider keying on full-text hash + showing title as alias, or letting the user
  confirm/rename on first creation.
- **Scope creep toward external lookups.** Tempting to call Crossref/Semantic Scholar to get
  canonical metadata — deliberately out of scope to keep everything local and offline, consistent
  with Part 1. Could be an opt-in enrichment later.
