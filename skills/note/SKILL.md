---
name: note
description: Create atomic, interconnected Zettelkasten notes (org-mode) in the user's knowledge vault. Use when the user wants to capture an idea, concept, or thing they learned as a permanent, linkable note.
argument-hint: "[concept or idea to capture]"
---

Create atomic, self-contained, interconnected **org-mode** notes following the Zettelkasten method.

## Core principles

1. **Atomicity** — one note, one concept. If the input covers several ideas, split it into one note per concept and link them to each other.
2. **Self-contained** — the note must be understandable on its own, months later, without reading anything first. Include just enough background.
3. **Connectivity** — a note without links is lost. Link related notes with org file links and always state *how* they relate.

## Workflow

1. **Get the idea.** Use the argument if given; otherwise ask what to capture. Get today's date with `date +%F` — never guess it; write it as an org active timestamp `[YYYY-MM-DD]`.
2. **Locate the vault**, in this order:
   - `$ZETTELKASTEN_VAULT` if set
   - `~/zettelkasten` if it exists
   - otherwise ask the user where their vault is (offer to create one)
3. **Find existing notes to connect to.** Search the vault for related titles, tags, and terms (`grep -ril` over `*.org`). Link to real existing notes; only link to notes that don't exist yet when they're an obvious next note to write.
4. **Decide the note type:**
   - Idea is developed enough to stand alone → permanent note in `<vault>/Zettelkasten/`
   - Raw capture, not yet thought through → fleeting note in `<vault>/Inbox/` (minimal: title, one-paragraph summary, `#+FILETAGS: :fleeting:`) and say so
5. **Write the note** using the template below. Filename: `{Topic} - {Specific Concept}.org` (e.g. `MCP - Protocol Overview.org`, `Zettelkasten - Atomicity Principle.org`).
6. **Add backlinks.** If an existing note you found is directly related, append a link to the new note in its `** Connections` section (create the section if missing).
7. **Report** the created file path and the links added.

## Note template

```org
#+TITLE: {Concept Name}
#+CREATED: [YYYY-MM-DD]
#+SOURCE: {url_or_reference}
#+FILETAGS: :{domain}:{topic}:zettel:

* {Concept Name}

#+BEGIN_QUOTE
{One-sentence definition or summary}
#+END_QUOTE

** Explanation

{2-3 paragraphs explaining the concept in your own words; include examples if helpful}

** Key Characteristics

- Characteristic 1
- Characteristic 2

** Connections

- [[file:Related Concept A.org][Related Concept A]] - {how they relate}
- [[file:Related Concept B.org][Related Concept B]] - {how they relate}
- [[file:Contrasting Concept.org][Contrasting Concept]] - {how they differ}

** Examples

{Concrete examples or applications}

** Source

- {Original source with link, if any}
```

## Linking rules

- Permanent notes live in a **flat** `Zettelkasten/` folder — domains are tags, not subfolders. This keeps links simple: `[[file:Topic - Concept.org][Display Text]]` resolves from any note in the folder.
- Linking to a note in another folder (e.g. from `Zettelkasten/` to `Research/`): compute the correct relative path from the *linking* file, e.g. `[[file:../Research/Paper X.org][Paper X]]`.
- Inbox fleeting notes: same rule, `[[file:../Zettelkasten/Topic - Concept.org][...]]`.

## Vault layout

```text
Vault/
├── Inbox/            # fleeting notes, not yet processed
├── Zettelkasten/     # permanent atomic notes (flat; organize with tags)
└── Research/         # source material (papers, articles) if the user keeps any
```

Create missing folders as needed; don't restructure a vault that already has its own layout — follow what's there.

**org-roam vaults** (detected by `org-roam.db` or `.org-id-locations`): just write the file — org-roam indexes the vault by scanning, so the note and its file links are picked up on the next db sync (Emacs startup or `M-x org-roam-db-sync`). Don't generate `:ID:` properties yourself; file links get indexed and backlinked like any other.

## Style rules

- Write in your own words; never paste long source passages — summarize.
- The one-sentence summary in the quote block must stand alone as the note's identity.
- Connections must explain the relationship, not just name the note.
- Tags: lowercase, hyphens for spaces (`:prompt-engineering:`), 2–4 tags plus `:zettel:`.
- If the user's input is in a different language than their existing notes, match the vault's language.
