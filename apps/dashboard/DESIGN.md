# Dashboard design

The house rules for the factory dashboard. Change this file before changing the look.

## Subject and scene

- **What it is.** The factory's system of record. Every run is one entry, and that entry keeps changing after the merge as outcomes arrive. The dashboard answers three questions:
  1. What needs me?
  2. What is it costing?
  3. Is the work holding up?
- **Who reads it, and where.** An engineering lead or platform engineer opens it on a laptop in daylight, between meetings, for about thirty seconds, to check on the factory. Sometimes they open it on a phone from a PR notification.
- **Mode.** An operating surface: precision and restraint. It is not a landing page.

## Idea: an instrument, not a card kit

The look borrows from instruments and shop-floor signage rather than SaaS templates:

- graphite ink on a cool, slightly blue-green neutral;
- one high-visibility yellow, used the way a factory uses safety yellow: rarely, and only to say "look here";
- figures that read like a gauge, wide and tabular;
- everything else steps back.

## Tokens

| Role | Light | Dark | Use |
|---|---|---|---|
| paper | `#f4f6f6` | `#0e1113` | page background |
| sheet | `#ffffff` | `#15191c` | panels, list surfaces |
| ink | `#161b1e` | `#e6eaec` | text, primary buttons, selected state |
| ink-2 | `#475055` | `#b4bcc1` | secondary text |
| quiet | `#737c81` | `#8a9398` | labels, axes, timestamps |
| rule | `#e1e5e6` | `#252b2f` | hairlines, about 12% of ink |
| hi-vis | `#ffd400` | `#ffd400` | brand mark, "needs you", the live run; a fill with ink on top, never text on paper |
| good / warn / bad | `#1d7a4c` / `#9a5a00` / `#c0352d` | `#4cc488` / `#e2a640` / `#f07067` | state only, always with a glyph and a word |
| series 1 / 2 / 3 | `#2a78d6` / `#eb6834` / `#1baf7a` | `#3987e5` / `#d95926` / `#199e70` | chart data; a CVD-validated categorical palette |

Dark mode is set separately for the same scene at night. It is not an inversion: the yellow stays the same, and the neutrals keep their blue-green tint.

## Type

- **One family: Mona Sans (variable, OFL), self-hosted.** Its width axis does the work that a second font would otherwise do:
  - Page titles: about 112 width.
  - Readout figures: about 118 width, so the numbers look like a gauge.
  - Tabular numerals only in numeric table columns. Mona Sans draws its tabular zero with a slash, which looks wrong in dates and headline figures.
  - UI text: 100 width.
- **Scale:** 12 · 13 · 14 (UI body) · 16 · 22 (page title) · 32 (readout). 14px is the floor for row text. Prose that needs to be read runs at 15px on a measure of 72ch or less.
- **Monospace only for real identifiers:** run ids, SHAs, branches and env names. Model names and labels use the body font.
- **Sentence case everywhere.** No tracked capitals, no eyebrow labels above headings, no `A · B · C` meta strings.

## Layout

- **Spacing:** a 4px base. Tight spacing inside a group, generous spacing between groups.
- **One panel style:** sheet colour, a 1px rule, radius 8, no shadow. Panels are composed rather than repeated: one panel can hold two views split by a rule. There are no identical card grids and no cards inside cards.
- **Readout strip:** the key figures sit in one band divided by rules, not in four separate cards.
- **Lists are aligned tables:** a status glyph, the title and its context, then right-aligned figures. Chips appear only where they carry a link.
- **Radius:** 6 for controls, 8 for panels.

## Status

Status is shown by a glyph in its tone plus a word:

- working: a rotating arc
- in review: a half disc
- merged: a check in a disc
- failed: a cross
- queued: a dashed ring

There are no tinted pill backgrounds behind the glyphs. Hi-vis yellow marks what needs a person.

## Charts

These follow the dataviz rules:

- one axis;
- 2px lines;
- bars for counts, lines for rates;
- a dashed median reference line where a typical value matters;
- a legend whenever there are two or more series;
- a crosshair tooltip on hover.

No gradient or area washes.

## Motion

- Hover and press feedback: 120ms ease-out.
- Exactly one moving thing at rest: the glyph of a live run.
- With `prefers-reduced-motion`, nothing rotates.

## Refused defaults

These are the AI-generated defaults we checked for and do not use:

- Inter for everything;
- cream background with a terracotta accent;
- an icon tile above every heading;
- identical rounded card grids;
- tinted badges on every row;
- gradient fills;
- ALL-CAPS section labels;
- monospace as a "technical" costume;
- purple or blue gradients;
- hero-metric templates.

The sources these come from are Anthropic frontend-design, Impeccable and Taste. We took their principles, not their palettes.
