---
name: ShiftBoard
description: A crew board where every shift is a strip of gaffer tape, saved straight to Google Calendar.
colors:
  whiteboard: "oklch(0.962 0.006 250)"
  whiteboard-panel: "oklch(0.995 0.002 250)"
  marker-ink: "oklch(0.235 0.025 258)"
  pencil-grey: "oklch(0.47 0.022 258)"
  hairline: "oklch(0.885 0.01 252)"
  slot-dash: "oklch(0.64 0.022 255)"
  gaffer-blue: "oklch(0.53 0.155 257)"
  gaffer-blue-edge: "oklch(0.44 0.14 257)"
  gaffer-blue-ink: "oklch(0.99 0.004 250)"
  gaffer-orange: "oklch(0.76 0.155 58)"
  gaffer-orange-edge: "oklch(0.6 0.15 50)"
  gaffer-orange-ink: "oklch(0.24 0.035 50)"
  masking-tape: "oklch(0.925 0.04 95)"
  masking-ink: "oklch(0.3 0.03 80)"
  alarm-red: "oklch(0.54 0.2 27)"
  road-case: "oklch(0.19 0.018 258)"
  road-case-panel: "oklch(0.232 0.02 258)"
  road-case-rule: "oklch(0.31 0.02 258)"
  road-case-slot: "oklch(0.55 0.025 255)"
  chalk: "oklch(0.95 0.008 250)"
  chalk-grey: "oklch(0.75 0.018 252)"
  gaffer-blue-night: "oklch(0.545 0.15 257)"
  gaffer-orange-night: "oklch(0.765 0.15 60)"
  masking-tape-night: "oklch(0.86 0.045 95)"
  alarm-red-night-text: "oklch(0.74 0.15 25)"
typography:
  display:
    fontFamily: "Barlow Condensed, Roboto Condensed, Arial Narrow, system-ui, sans-serif"
    fontSize: "2.5rem"
    fontWeight: 700
    lineHeight: 0.98
    letterSpacing: "0.005em"
  headline:
    fontFamily: "Barlow Condensed, Roboto Condensed, Arial Narrow, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "0.02em"
  title:
    fontFamily: "Barlow Condensed, Roboto Condensed, Arial Narrow, system-ui, sans-serif"
    fontSize: "1.625rem"
    fontWeight: 700
    lineHeight: 1
    fontFeature: "tnum"
  label:
    fontFamily: "Barlow Condensed, Roboto Condensed, Arial Narrow, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "0.06em"
  meta:
    fontFamily: "Barlow Condensed, Roboto Condensed, Arial Narrow, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "0.1em"
  body:
    fontFamily: "Barlow, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.45
rounded:
  tape: "2px"
  field: "8px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  2xl: "32px"
  3xl: "48px"
components:
  button-primary:
    backgroundColor: "{colors.marker-ink}"
    textColor: "{colors.whiteboard}"
    typography: "{typography.label}"
    rounded: "{rounded.field}"
    padding: "0 24px"
    height: "48px"
  button-primary-disabled:
    backgroundColor: "{colors.hairline}"
    textColor: "{colors.pencil-grey}"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.marker-ink}"
    rounded: "{rounded.field}"
    padding: "0 16px"
    height: "44px"
  button-text:
    backgroundColor: "transparent"
    textColor: "{colors.pencil-grey}"
    height: "44px"
  tape-empty:
    backgroundColor: "transparent"
    textColor: "{colors.pencil-grey}"
    typography: "{typography.label}"
    rounded: "{rounded.tape}"
    height: "48px"
  tape-event:
    backgroundColor: "{colors.gaffer-blue}"
    textColor: "{colors.gaffer-blue-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.tape}"
    height: "48px"
  tape-warehouse:
    backgroundColor: "{colors.gaffer-orange}"
    textColor: "{colors.gaffer-orange-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.tape}"
    height: "48px"
  calendar-select:
    backgroundColor: "{colors.whiteboard-panel}"
    textColor: "{colors.marker-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.field}"
    padding: "0 40px 0 14px"
    height: "48px"
---

# Design System: ShiftBoard

## Overview

**Creative North Star: "The Crew Tape Board"**

Event and warehouse crews label everything with gaffer tape and plan on a ruled board. ShiftBoard is that board: each week is a ruled block of seven days, and a shift is a strip of tape pressed across the day it belongs to. Blue tape is an Event shift, orange tape is a Warehouse shift. Tapping an empty slot pulls a strip across it; tapping the strip peels it off. Nothing is saved until the single Save to Calendar button in the thumb-reach bar at the bottom.

This is an operating surface for phones first. Structure comes from rules and proximity, never from cards: hairlines between days, a heavy ink rule under each week title. Colour is spent almost entirely on the two tapes, so a glance down the board shows the shape of someone's weeks. Everything else is ink on a cool whiteboard by day and chalk on a road-case blue-black at night, following the phone's light or dark setting.

The tape is drawn honestly: a flat matte fill (gaffer tape is matte), torn ends, a slight hand-applied tilt that varies from row to row, and a one-pixel soft shadow where it sits on the board. No gloss, no bevel, no printed texture.

**Key Characteristics:**
- Two saturated tapes carry all the meaning; the UI around them is ink and grey.
- Ruled rows and week headers instead of cards.
- Condensed marker-style capitals for anything written on tape or the board.
- Every tap target is at least 44px; tapes are 48px tall.
- Light and dark are both designed, not inverted.

## Colors

A restrained board of cool greys that exists to make two strips of tape unmistakable.

### Primary
- **Gaffer Blue** (oklch(0.53 0.155 257)): the Event tape. Only shift types use it. Labels on it are Gaffer Blue Ink, near-white (5.2:1). In dark mode it shifts to Gaffer Blue Night (oklch(0.545 0.15 257)).
- **Gaffer Orange** (oklch(0.76 0.155 58)): the Warehouse tape. Labels on it are Gaffer Orange Ink, a dark brown-black (7.4:1). Night value: oklch(0.765 0.15 60).

### Secondary
- **Masking Tape** (oklch(0.925 0.04 95)): the torn strip behind today's date and the text-selection highlight. Masking Ink (oklch(0.3 0.03 80)) sits on it. Night value: oklch(0.86 0.045 95).

### Neutral
- **Whiteboard** (oklch(0.962 0.006 250)): the page ground in light mode.
- **Whiteboard Panel** (oklch(0.995 0.002 250)): the save bar and form fields, one step lighter than the board.
- **Marker Ink** (oklch(0.235 0.025 258)): body text, headings, the primary button fill, week rules, focus rings.
- **Pencil Grey** (oklch(0.47 0.022 258)): secondary text, empty-slot labels, day-of-week names, text buttons (6.1:1 on the board).
- **Hairline** (oklch(0.885 0.01 252)): 1px rules between days, field borders, the disabled Save button.
- **Slot Dash** (oklch(0.64 0.022 255)): the dashed outline of an empty tape slot (3.0:1 on the board).
- **Road Case** (oklch(0.19 0.018 258)), **Road Case Panel** (oklch(0.232 0.02 258)), **Road Case Rule** (oklch(0.31 0.02 258)), **Road Case Slot** (oklch(0.55 0.025 255)), **Chalk** (oklch(0.95 0.008 250)) and **Chalk Grey** (oklch(0.75 0.018 252)): the same roles at night.
- **Alarm Red** (oklch(0.54 0.2 27)): error toasts. As text on the night board it lightens to oklch(0.74 0.15 25).

### Named Rules
**The Two Tapes Rule.** Blue means Event and orange means Warehouse, everywhere. No button, link, badge or decoration borrows either colour.

**The Edge Carries Contrast Rule.** A tape too light to reach 3:1 against the board gets a 1.5px darker edge along its long sides that does (Gaffer Orange Edge, oklch(0.6 0.15 50), 3.7:1). Where the fill already clears 3:1, the edge matches the fill.

## Typography

**Display Font:** Barlow Condensed (with Roboto Condensed, Arial Narrow)
**Body Font:** Barlow (with system-ui)

**Character:** One industrial family in two widths. The condensed cut, set in capitals, is the marker on the tape and the stencil on the board; the regular cut carries sentences and status.

### Hierarchy
- **Display** (700, 2.5rem, 0.98; 3.5rem on wide screens; 2.125rem under 360px): the signed-out headline only. Capitals, balanced wrapping.
- **Headline** (700, 1.25rem, 1.1, 0.02em, capitals): week titles ("This week") with the date range beside them in Body at 600.
- **Title** (700, 1.625rem, 1, tabular figures): the day-of-month numeral.
- **Label** (700, 1rem, 0.06em, capitals): everything written on tape, and the primary button at 1.0625rem.
- **Meta** (600, 0.8125rem, 0.1em, capitals): day-of-week names and the "Save shifts to" field label.
- **Body** (400, 1rem, 1.45): sentences, status text, the calendar picker. Never below 16px in a form field (iOS zooms otherwise).

### Named Rules
**The Marker Rule.** Anything written on the tape or the board is condensed capitals; anything that reads as a sentence is Barlow in sentence case.

## Layout

A single column on phones, capped at 34rem and centred, with a 16px gutter that grows to respect notches and rounded corners (safe-area insets). The board is a vertical run of week blocks. Each day is a two-column grid: a 3.25rem date label, then two equal tape slots with an 8px gap. Rows are at least 64px tall. Week titles stick to the top of the screen while their week scrolls under them.

The save bar is fixed to the bottom in thumb reach, above the home indicator, with the status on the left and Save to Calendar on the right. The page leaves room beneath the last week so nothing hides behind it.

From 60rem the measure widens to 68rem and weeks sit two side by side. The signed-out screen becomes two columns: copy on the left, the example week on the right, centred in the viewport. Under 22.5rem the date column narrows to 2.75rem and tape labels tighten so "Warehouse" still fits a 320px phone.

Spacing runs on a 4px base (4, 8, 12, 16, 24, 32, 48). Related things sit 8-16px apart; separate groups get 24-32px.

## Elevation & Depth

Flat by default. Depth appears in three places only, each explaining something physical:

- **Tape shadow** (`drop-shadow(0 1px 1px oklch(0.25 0.03 258 / 0.4))`, night `oklch(0 0 0 / 0.55)`): a strip of tape sitting on the board.
- **Save bar shadow** (`0 -10px 30px -16px oklch(0.2 0.03 258 / 0.35)`): the bar floats over the scrolling board.
- **Toast shadow** (`0 14px 30px -12px oklch(0.2 0.03 258 / 0.5)`): a transient message above everything.

### Named Rules
**The Taped By Hand Rule.** Every strip is torn at both ends, sits a fraction of a degree off level, and varies its angle from row to row (between -1° and 0.9°), with every other tear mirrored. Today's date sits on masking tape at -3°.

## Shapes

Tape has almost square corners (2px) and torn ends drawn as SVG masks. Fields and buttons have gently rounded corners (8px). Empty slots are 1.5px dashed outlines in Slot Dash, the outline of where tape goes. Week titles carry a 2px Marker Ink rule; days are divided by 1px hairlines.

## Components

### Tape slot
The signature component: one per work type per day, a 48px-tall toggle button with `aria-pressed`.
- **Empty:** a dashed outline, a drawn plus, and the type name in Pencil Grey.
- **On:** a strip of the type's tape pulled across the slot (240ms, `cubic-bezier(0.16, 1, 0.3, 1)`, from the left). Switching off peels it away to the right (150ms, `cubic-bezier(0.5, 0, 0.75, 0)`). Pressing scales it to 0.96.
- **Unsaved add:** the tape carries a small dot after its label.
- **Unsaved removal:** the slot shows a 2px dashed outline in that tape's colour with the label struck through.
- **Loading:** slots are disabled at 45% opacity until their week's shifts arrive; shifts that load from the calendar appear in place without the pull.
- **Reduced motion:** the pull and peel become a 150ms crossfade.
- **Forced colours:** the strip is replaced by a 3px outline.

### Buttons
- **Shape:** gently rounded (8px).
- **Primary** (Save to Calendar, Sign in with Google): a Marker Ink fill with the board's colour for text, condensed capitals, 48px tall, 24px side padding. Disabled: a Hairline fill with Pencil Grey text. Pressing scales it to 0.97.
- **Quiet** ("New calendar", "Show 4 more weeks"): a transparent fill, a 1.5px Hairline border and Marker Ink text, 44px tall.
- **Text** ("Sign out", "Show the week before", "Try again"): underlined Pencil Grey, never wrapping, 44px tall.

### Calendar picker
A native select styled as a field: Whiteboard Panel, a 1.5px Hairline border, 8px corners, 48px tall, a drawn chevron, and 16px text. It sits under a Meta label that reads "Save shifts to".

### Week title
Headline capitals ("This week", "Next week", "Last week", or the date range alone), the date range in Pencil Grey beside them, and a 2px Marker Ink rule beneath. It sticks to the top while scrolling.

### Save bar and toast
The save bar is Whiteboard Panel with a Hairline top border. Its status reads "No unsaved changes", "Loading your shifts…", "3 to add · 1 to remove" or "Saving to Google Calendar…". The toast is Marker Ink (or Alarm Red for errors), sits above the bar, can be dismissed with a tap, and stays 3s (6s for errors).

## Do's and Don'ts

### Do:
- **Do** keep blue for Event and orange for Warehouse, and nothing else.
- **Do** mark every unsaved change on the board itself: a dot for new tape, a struck-through outline for tape coming off.
- **Do** keep every control at least 44px and every tape slot 48px.
- **Do** give any light tape a darker edge until it reaches 3:1 against the board.
- **Do** design both themes: whiteboard by day, road case at night.

### Don't:
- **Don't** put days or weeks in cards, or use coloured side stripes; rules and spacing carry the structure.
- **Don't** add gloss, gradients, glows, bevels or printed textures to the tape; it's matte.
- **Don't** animate shifts arriving from the calendar; only the user's own taps get the pull and peel.
- **Don't** put a small label above a heading; field labels above fields are fine.
- **Don't** use emoji or text characters as icons; draw them as SVG, like the plus and the chevron.

<!-- Not canonized: the "New calendar" flow still uses the browser's prompt() dialog, kept from the earlier app; the night ground sits close to the common blue-black default and was kept because the chosen direction named it. apple-touch-icon.png is rendered from icon.svg and carries no separate provenance. -->
