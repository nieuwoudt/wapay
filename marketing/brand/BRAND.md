# WaPay / Please Pay Me — brand kit

Everything the boards need: real logos (SVG masters + 3000px PNGs), hex codes,
and the font files. The SVG wordmarks are **outlined to paths** — no font
needed to open or scale them. The R-bubble placeholder can be replaced with
these marks.

## Logos in this kit

| File | What it is |
|---|---|
| `logo-wapay.svg / .png` | WaPay lockup, no TM |
| `logo-wapay-TM.svg / .png` | WaPay lockup with small TM |
| `logo-pleasepayme.svg / .png` | Please Pay Me lockup, no TM |
| `logo-pleasepayme-TM.svg / .png` | Please Pay Me lockup with small TM |
| `mark-wapay.svg / .png` | W speech-bubble mark alone (avatars, favicons, app icons) |
| `mark-pleasepayme.svg / .png` | R speech-bubble mark alone |

The TM is the same size on both lockups (26% of cap height, top-aligned).
PNGs are transparent-background. For dark backgrounds, recolor the ink
letters `#1D2026 → #FFFFFF` in the SVG; the emerald and the marks stay as they are.

## Hex codes

| Token | Hex | Use |
|---|---|---|
| Emerald (primary) | `#1FA867` | The brand green. The word "Pay", accents, links |
| Emerald dark | `#0C885E` | Gradient partner, hover/pressed states |
| Ink | `#1D2026` | Headlines, wordmark letters, body on light |
| WhatsApp action green | `#25D366` | ONLY the WhatsApp CTA button, nothing else |
| Teal (chat header) | `#075E54` | Chat-UI chrome, deep accents |
| Mint | `#DFF5E9` | Soft tinted panels |
| Mint soft | `#EFF9F3` | Lightest tint / section backgrounds |
| Chat background | `#EDE9E3` | WhatsApp-style chat surfaces |
| Gray | `#6B7280` | The TM, secondary text |
| Gold | `#F0B429` | Sparing highlight (ratings, "new") |

Mark gradient: `#1FA867 → #0C885E`, top-left to bottom-right.

## Family rule (keeps the two brands related)

The word **"Pay" is always emerald `#1FA867`**; every other letter is ink
`#1D2026`. So: **Wa**·**Pay** and **Please**·**Pay**·**Me**. Marks are the same
speech bubble — W for WaPay, R (rand) for Please Pay Me.

## Type

| Role | Face | File |
|---|---|---|
| Wordmarks / display | Archivo ExtraBold 800 | `fonts/Archivo-wght-800.ttf` |
| Headings | Archivo Bold 700 | `fonts/Archivo-wght-700.ttf` |
| Subheads | Archivo Medium 500 | `fonts/Archivo-wght-500.ttf` |
| Body | Public Sans Regular 400 | `fonts/Public-Sans-wght-400.ttf` |
| Body emphasis | Public Sans SemiBold 600 | `fonts/Public-Sans-wght-600.ttf` |

Both families are Google Fonts under the SIL Open Font License (free for
commercial use, embedding, and web): fonts.google.com/specimen/Archivo and
fonts.google.com/specimen/Public+Sans.

## Usage notes

- Clearspace: keep at least half the bubble's width empty around the lockup.
- Minimum lockup width ~120px; below that, use the bubble mark alone.
- Don't stretch, outline, add shadows, or recolor the greens.
- One bright `#25D366` action button per screen — everything else uses the
  emerald family.
