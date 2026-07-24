# Design tokens

Every token is a CSS custom property on `:root`, declared in `tokens/*.css` and pulled in by
`styles.css` (which `index.ts` imports). Components reference them as `var(--name)` in inline
styles — there are no CSS classes and no theme switcher: **one dark theme only.**

Values were extracted verbatim from the source dashboard design bundle (not part of this repo).

## Colors — `tokens/colors.css`

### Surfaces

| Token            | Value     | Use                                                  |
| ---------------- | --------- | ---------------------------------------------------- |
| `--bg`           | `#0f1014` | App background (near-black base)                     |
| `--bg-side`      | `#121318` | Sidebar                                              |
| `--bg-rail`      | `#111218` | Right rail                                           |
| `--panel`        | `#15161b` | Cards, raised rows                                   |
| `--panel-dim`    | `#13141a` | Recessed panels                                      |
| `--panel-hover`  | `#1b1d24` | Hover/selected fill                                  |
| `--input`        | `#191b21` | Input, select, textarea fill                         |
| `--input-border` | `#22252f` | Input border; also progress-bar track and `Kbd` fill |
| `--border`       | `#1f222b` | Default hairline                                     |
| `--border-2`     | `#262933` | Stronger hairline (buttons, modals)                  |

The ramp moves one step at a time: `transparent → #16181f → --panel-hover` on hover. Depth comes
from 1px borders, never elevation.

### Text ramp

| Token          | Value     | Use                                  |
| -------------- | --------- | ------------------------------------ |
| `--text`       | `#e6e7ec` | Primary                              |
| `--text-2`     | `#9b9fad` | Secondary, button labels             |
| `--text-3`     | `#62667a` | Muted — section labels, placeholders |
| `--text-4`     | `#4a4e5e` | Faint — timestamps, ages             |
| `--text-prose` | `#c9cbd4` | Long-form document body              |

De-emphasis is a ramp step down or opacity (.55–.85), never a hue change. Disabled is `opacity: .5`.

### Accent and functional hues

| Token           | Value     | Meaning                                    |
| --------------- | --------- | ------------------------------------------ |
| `--accent`      | `#7b83eb` | The single brand indigo                    |
| `--accent-deep` | `#4c56c0` | Pressed/focus border, `accent` button fill |
| `--on-accent`   | `#0f1014` | Text on an `--accent` fill                 |
| `--blue`        | `#52a9ff` | Docs, references                           |
| `--green`       | `#46c288` | Done, plans, live agents                   |
| `--orange`      | `#f0883e` | Blocked, warnings                          |
| `--purple`      | `#c084fc` | Probe                                      |
| `--yellow`      | `#e2c541` | Gap                                        |
| `--danger`      | `#e5484d` | Destructive                                |
| `--gold`        | `#d3b078` | Human avatar                               |

Color carries _meaning_, not decoration. It appears mostly as an 8–12% alpha tint behind small text.

### Tints and scrim

`--tint-accent` `rgba(123,131,235,.10)` · `--tint-blue` `rgba(82,169,255,.08)` ·
`--tint-green` `rgba(70,194,136,.10)` · `--tint-orange` `rgba(240,136,62,.09)` ·
`--tint-danger` `rgba(229,72,77,.12)` · `--tint-yellow` `rgba(226,197,65,.10)` ·
`--scrim` `rgba(5,6,9,.55)` (modal backdrop — no `backdrop-filter`).

### Semantic aliases

`--surface-app` `--surface-sidebar` `--surface-rail` `--surface-card` `--surface-card-hover`
`--surface-input` alias the raw surfaces above. Standalone: `--surface-overlay` `#131419`,
`--surface-modal` `#16171d`, `--surface-code` `#0d0e12`, `--surface-toast` `#1d1f27`,
`--border-card-hover` `#2e3342`. Prefer the semantic name in new code.

## Typography — `tokens/typography.css`

| Token                    | Value                                        |
| ------------------------ | -------------------------------------------- |
| `--sans` / `--font-sans` | `'Schibsted Grotesk', system-ui, sans-serif` |
| `--mono` / `--font-mono` | `'JetBrains Mono', ui-monospace, monospace`  |

Mono is for identity and measurement — ids, counts, timestamps, durations, `kbd`. Everything else is sans.

Size ramp (exact odd values are intentional; there is no modular scale):

| Token          | Value    | Use                              |
| -------------- | -------- | -------------------------------- |
| `--fs-micro`   | `9.5px`  | Kind/priority labels             |
| `--fs-tiny`    | `10.5px` | Mono ids, counts, section labels |
| `--fs-caption` | `11.5px` | Meta rows, activity lines        |
| `--fs-body`    | `12.5px` | Card titles, rows, inputs        |
| `--fs-base`    | `13px`   | Body default                     |
| `--fs-prose`   | `13.5px` | Document body                    |
| `--fs-title`   | `15px`   | Modal/featured headings          |
| `--fs-doc`     | `21px`   | Slide-over document title        |

Weights `--fw-regular` 400 · `--fw-medium` 500 · `--fw-semibold` 600 · `--fw-bold` 700.
Tracking `--ls-heading` `-.01em` (headings) · `--ls-label` `.08em` (uppercase section labels).

## Layout — `tokens/layout.css`

Radii: `--radius-kbd` 4px (chips/kbd) · `--radius-chip` 5px · `--radius-btn` 7px
(buttons, inputs, nav rows) · `--radius` 8px (cards) · `--radius-lg` 10px (featured) ·
`--radius-xl` 12px (modals). Dots are circles; swatches are 2px squares.

Shadows only on floating layers: `--shadow-modal` `0 24px 60px rgba(0,0,0,.5)` ·
`--shadow-overlay` `-24px 0 60px rgba(0,0,0,.55)` · `--shadow-toast` `0 8px 24px rgba(0,0,0,.4)`.
Emphasis rings: `--glow-accent` `0 0 0 1px rgba(123,131,235,.12)` · `--glow-green` `0 0 6px rgba(70,194,136,.7)`.

Structure: `--sidebar-w` 226px · `--rail-w` 290px · `--topbar-h` 48px.

Motion: `--dur-fast` .1s · `--dur` .12s · `--dur-slow` .18s, all `--ease` `ease`. Fast and small — nothing bounces.

## Base styles and keyframes — `tokens/base.css`

Carries the reset, `body` defaults, the link and scrollbar styling, and four keyframes that
components reference by name:

| Keyframe   | Used by                                                   |
| ---------- | --------------------------------------------------------- |
| `pulse`    | `StatusDot state="live"`, `TicketCard live`               |
| `toast-in` | `Toast`                                                   |
| `card-in`  | Staggered card entry (available; not used by the app yet) |
| `slide-in` | Slide-over panels (available; not used by the app yet)    |

**These keyframes are why components need the stylesheet.** Importing a component from `../ds`
pulls in `styles.css` automatically, so they are always present.

## Fonts — `tokens/fonts.css`

Schibsted Grotesk and JetBrains Mono load from the Google Fonts CDN, matching the source app.
No font binaries ship with the system. If the app must work offline, self-host and replace this file —
the `--sans` / `--mono` tokens are the only thing components depend on.
