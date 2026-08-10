#!/usr/bin/env bash
# org2pdf — convert an org-mode file to PDF on minimal TeX installs.
#
# Works where vanilla `emacs org-latex-export-to-pdf` fails: texlive-basic lacks
# fontspec/textcomp (tcrm)/T1-ecrm fonts, and itemize bullets + section signs +
# unicode symbols need them. This script patches the generated .tex instead.
#
# Usage: org2pdf.sh INPUT.org [-o OUTPUT.pdf]
# Requires: emacs (org-mode), pdflatex, python3
set -euo pipefail

INPUT=""
OUTPUT=""
while [[ $# -gt 0 ]]; do
	case "$1" in
	-o | --output)
		OUTPUT="$2"
		shift 2
		;;
	-h | --help)
		echo "Usage: org2pdf.sh INPUT.org [-o OUTPUT.pdf]"
		exit 0
		;;
	*)
		INPUT="$1"
		shift
		;;
	esac
done
[[ -n "$INPUT" ]] || {
	echo "error: no input file (usage: org2pdf.sh INPUT.org [-o OUTPUT.pdf])" >&2
	exit 1
}
[[ -f "$INPUT" ]] || {
	echo "error: $INPUT not found" >&2
	exit 1
}

command -v emacs >/dev/null || {
	echo "error: emacs required" >&2
	exit 1
}
command -v pdflatex >/dev/null || {
	echo "error: pdflatex required" >&2
	exit 1
}
command -v python3 >/dev/null || {
	echo "error: python3 required" >&2
	exit 1
}

DIR="$(cd "$(dirname "$INPUT")" && pwd)"
BASE="$(basename "$INPUT" .org)"
TEX="$DIR/$BASE.tex"
[[ -n "$OUTPUT" ]] || OUTPUT="$DIR/$BASE.pdf"
export ORG2PDF_INPUT="$DIR/$(basename "$INPUT")"

echo "org2pdf: exporting $ORG2PDF_INPUT -> $TEX"

# 1) org -> LaTeX via emacs, minimal package set, no compile attempt
emacs --batch --kill -l ox-latex --eval '(progn
(setq org-latex-default-packages-alist
  (quote (("" "inputenc" t) ("" "fontenc" t) ("" "graphicx" t)
          ("" "longtable" t) ("" "url" t) ("" "amsmath" t) ("" "hyperref" nil))))
(setq org-latex-packages-alist nil)
(setq org-export-with-broken-links t)
(find-file (getenv "ORG2PDF_INPUT")) (org-latex-export-to-latex))' >/dev/null

[[ -f "$TEX" ]] || {
	echo "error: emacs export produced no $TEX" >&2
	exit 1
}

# 2) minimal-texlive compatibility patch
python3 - "$TEX" <<'PYEOF'
import sys
import re

path = sys.argv[1]
src = open(path, encoding="utf-8").read()

# itemize bullets use \textbullet (TS1/textcomp) -> absent on minimal texlive.
# Switch to math-mode symbols (cmsy ships with amsfonts, always present).
fix = r"""
% minimal-texlive fix: itemize bullets + section sign need textcomp (tcrm), not installed
\renewcommand{\labelitemi}{$\bullet$}
\renewcommand{\labelitemii}{$\circ$}
\renewcommand{\labelitemiii}{$\cdot$}
\renewcommand{\labelitemiv}{$\bullet$}
\pdfstringdefDisableCommands{\def\textsubscript#1{#1}\def\textsuperscript#1{#1}}
"""
if "labelitemi" not in src:
    src = src.replace("\\begin{document}", fix + "\n\\begin{document}", 1)

# org strikethrough (bare +...+ in prose, e.g. "+20.6%") exports as \sout{};
# the soul package is absent on minimal texlive -> strip non-nested spans.
src = re.sub(r"\\sout\{([^{}]*)\}", r"\1", src)

# org escapes literal $ as \$; on minimal installs \$ -> textcomp/tcrm.
# Replace with raw OT1 char 36 (renders $, no TS1 needed).
src = src.replace("\\$", "\\char36{}")

# Transliterate unicode that would pull in missing fonts (TS1) or break pdflatex.
table = {
    "\u2192": "$\\rightarrow$",  # ->
    "\u00d7": "$\\times$",       # x
    "\u2260": "$\\neq$",         # !=
    "\u2248": "$\\approx$",      # ~=
    "\u03c4": "$\\tau$",         # tau
    "\u03b3": "$\\gamma$",       # gamma
    "\u03b2": "$\\beta$",         # beta
    "\u2194": "$\\leftrightarrow$",  # <->
    "\u2605": "*",               # star
    "\u2153": "1/3",             # one third
    "\u2026": "\\ldots{}",       # ...
    "\u00b2": "\\textsuperscript{2}",  # superscript two (O(N²))
    "\u2212": "-",               # minus sign
    "\u2014": "---",             # em dash
    "\u2013": "--",              # en dash
    "\u00a7": "S",               # section sign
    "\u2264": "$\\leq$",           # <=
    "\u2265": "$\\geq$",           # >=
    "\u226a": "$\\ll$",            # <<
    "\u26a0": "!",                # warning sign (avoid [..]: breaks in table cells)
    "\u2713": "OK",              # checkmark
    "\u2705": "OK",            # white check mark (emoji variant)
    "\u274c": "(!)",           # cross mark (emoji variant)
    "\ufe0f": "",              # emoji variation selector-16 (strips ⚠️/✅️ to ⚠/✅)
    # textcomp-mapped chars: inputenc maps these to \text... glyphs that need the
    # missing tcrm font (same failure as bullets/§/$) — ASCII-ize them here:
    "\u20ac": "EUR",            # euro sign (\\texteuro -> tcrm1095 on minimal texlive)
    "\u00a9": "(c)",           # copyright (\\textcopyright -> tcrm)
    "\u00ae": "(R)",           # registered (\\textregistered -> tcrm)
    "\u2122": "(TM)",          # trademark (\\texttrademark -> tcrm)
    # fractions/symbols inputenc maps to TS1 glyphs (tcrm) as well:
    "\u00bd": "1/2",           # one half (\\textonehalf)
    "\u00bc": "1/4",           # one quarter (\\textonequarter)
    "\u00be": "3/4",           # three quarters (\\textthreequarters)
    "\u00b9": "\\textsuperscript{1}",  # superscript one (\\textonesuperior)
    "\u00b3": "\\textsuperscript{3}",  # superscript three (\\textthreesuperior)
    "\u00b5": "u",             # micro sign (\\textmu)
    "\u00f7": "$\\div$",      # division sign (\\textdiv)
}
for u, r in table.items():
    src = src.replace(u, r)

open(path, "w", encoding="utf-8").write(src)
PYEOF

# 3) compile — self-healing loop. Minimal texlive rejects two unicode classes:
heal_tex() {
	python3 - "$TEX" "$@" <<'PYEOF'
import sys
import unicodedata as _ud
src = open(sys.argv[1], encoding="utf-8").read()
codes = sys.argv[2:]
if codes and codes != ["ALL"]:
    chars = [chr(int(h, 16)) for h in codes]
else:
    chars = sorted({c for c in src if ord(c) > 0x7F})
for c in chars:
    if c not in src:
        continue
    try:
        rep = _ud.normalize("NFKD", c).encode("ascii", "ignore").decode("ascii").replace("\u2044", "/")
    except Exception:
        rep = ""
    if not rep:
        rep = "?"
    src = src.replace(c, rep)
    print("org2pdf: healed U+%04X %s -> %s" % (ord(c), _ud.name(c, "?"), "?" if rep == "?" else rep), file=sys.stderr)
open(sys.argv[1], "w", encoding="utf-8").write(src)
PYEOF
}
# 3) compile — self-healing loop. Minimal texlive rejects two unicode classes:
#   (a) "Unicode character U+XXXX not set up for use with LaTeX" -> transliterate
#       exactly those chars (NFKD, else '?'); (b) chars inputenc maps to TS1/
#       textcomp glyphs (€ © ½ -> \texteuro \textonehalf...) which need the missing
#       tcrm font and fail as mktexpk/font errors — not attributable to one char in
#       the log, so blanket-transliterate every remaining non-ASCII char then.
#   Accented Latin (é ü...) is OT1-safe under utf8 inputenc and is never touched.
#   Loop until 3 consecutive clean passes (TOC/bookmarks stabilization).
cd "$DIR"
clean=0
for _ in 1 2 3 4 5 6 7 8; do
	pdflatex -interaction nonstopmode "$BASE.tex" >/dev/null 2>&1 || true
	CODES=$(grep -oP '\(U\+[0-9A-Fa-f]+\)' "$BASE.log" 2>/dev/null | grep -oP '[0-9A-Fa-f]+' | sort -u | tr '\n' ' ' || true)
	FONT=$(grep -icE 'mktexpk|tcrm[0-9]+\.|missfont' "$BASE.log" 2>/dev/null || true)
	if [[ -n "$CODES" ]]; then
		heal_tex $CODES
		clean=0
	elif ((FONT > 0)); then
		heal_tex ALL
		clean=0
	else
		clean=$((clean + 1))
	fi
	if ((clean >= 3)); then break; fi
done
[[ -f "$BASE.pdf" ]] || {
	echo "error: pdflatex failed repeatedly; log kept at $BASE.log" >&2
	exit 1
}

rm -f "$BASE.aux" "$BASE.toc" "$BASE.out" "$BASE.log" missfont.log
if [[ "$(readlink -f "$OUTPUT" 2>/dev/null)" != "$(readlink -f "$DIR/$BASE.pdf" 2>/dev/null)" ]]; then
	mv "$DIR/$BASE.pdf" "$OUTPUT"
fi
echo "org2pdf: $OUTPUT ($(stat -c%s "$OUTPUT") bytes)"
