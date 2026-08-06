---
name: org2pdf
description: Use when converting org-mode files to PDF, when pdflatex/emacs org export fails with missing font errors (textcomp, tcrm, fontspec, T1), or when a generated PDF renders wrong symbols for unicode (arrows, math, dashes).
---

# Org to PDF

Convert an org-mode file to a PDF that compiles even on **minimal TeX installs**
(no `fontspec`, no `textcomp`/tcrm fonts, no T1/ecrm, no `booktabs`, no `xcolor`).

## Usage

```sh
/path/to/skills/org2pdf/scripts/org2pdf.sh INPUT.org [-o OUTPUT.pdf]
```

Requires: `emacs` (org-mode), `pdflatex`, `python3`. The script:

1. exports org → LaTeX via emacs with a minimal, dependency-free package set
2. patches the .tex for missing-font installs (see Gotchas)
3. compiles with pdflatex (3 passes for TOC/bookmarks)

## When NOT to use

- You have pandoc or a full TeX distribution — use those instead.
- The target is a .docx/.html export — emacs `ox-html`/`ox-odt` don't need this.
- The org file already has `#+LATEX_COMPILER: lualatex` and fontspec works — skip the patch.

## Gotchas (why this skill exists)

These bite on minimal texlive (`texlive-combined-basic`) and manifest as
`!pdfTeX error: (file tcrm1095): Font tcrm1095 at 600 not found` — the font
*tfm* exists but the glyph data is missing:

| Cause | Symptom | Fix (script does this) |
| ------- | --------- | ------------------------ |
| `itemize` bullets use `\textbullet` (TS1/textcomp) | tcrm1095 font error on any bullet list | redefine `\labelitemi..iv` to `$\bullet$`/`$\circ$`/`$\cdot$` (math cmsy exists) |
| `§` maps to `\S`/`\textsection` (TS1) | tcrm1095 error at the `§` | transliterate to plain `S` |
| escaped dollar `\$` (org writes it for prices) is TS1-only in modern LaTeX | tcrm1095 error at any price, even correctly-escaped | replace `\$` with `\char36{}` (raw OT1 char, renders `$`) |
| Unicode `→ × ≠ ≈ τ γ ★ ⅓ − …` | LaTeX error or wrong glyph | transliterate to LaTeX math/ASCII equivalents |
| Unicode `≤ ≥ ≪ ⚠ ✓` | LaTeX error or wrong glyph (not in older table) | transliterate: `$\leq$`/`$\geq$`/`$\ll$` (cmsy), `!`/`OK` (bracket-free — `[!]` breaks in table cells) |
| broken links (`[[URL][desc]]` or dangling org links) | emacs export aborts: "Unable to resolve link" | set `org-export-with-broken-links t`; broken links export as their description |
| bare `+` signs in prose (e.g. `+20.6%`) | org reads `+...+` as strikethrough → `\sout{}` (soul absent) → undefined control sequence | strip non-nested `\sout{...}` spans in the patch step |
| em/en dashes `— –` in some contexts | TS1 fallback attempts | convert to `---` / `--` |
| `\textsubscript`/`\textsuperscript` inside a *heading* | tcrm error via PDF-bookmark processing | `\pdfstringdefDisableCommands{...}` neutralizes them for bookmarks |
| `#+BEGIN_EXAMPLE` sources with long URLs | overfull hbox warnings (harmless) | accept; or `#+ATTR_LATEX: :font \footnotesize` on the block |

## Common Mistakes

- **Editing the generated .tex instead of the .org** — the script overwrites it every run.
- **Adding the patch by hand to .tex** — re-run the script instead; it re-applies.
- **Expecting `$` in org to break** — org escapes `$` correctly (`\$`); the breakage is only on minimal installs where `\$` needs textcomp, which the script patches via `\char36{}`. Prices work as-is.
- **`emacs` export-to-pdf instead of export-to-latex** — the script uses
  `org-latex-export-to-latex` (no compile) then compiles manually; export-to-pdf
  double-compiles and fails noisily on minimal installs.
- **Verbatim blocks with `%`** — LaTeX treats `%` as a comment; org escapes it
  correctly, so keep `%` inside `#+BEGIN_EXAMPLE` as-is.
