# PM Board design system

Real React components, imported like any other module:

```tsx
import { Button, Chip, StatusDot } from '../ds';

<Button variant="primary" size="sm" onClick={save}>Save</Button>
<Chip mono tone="green">admin</Chip>
<StatusDot state="live" color="var(--green)" size={7} />
```

Importing from `../ds` also loads `styles.css` (tokens + keyframes), so a component always has
the custom properties and animations it renders against.

## Layout

```
ds/
  index.ts               barrel — every component and its prop types
  types.ts               DSOption / DSOptionInput, shared by Select and SegToggle
  styles.css             entry stylesheet; @imports tokens/
  tokens/                colors, typography, layout, fonts, base (reset + keyframes)
  TOKENS.md              what every CSS custom property means
  components/
    core/                Avatar Button Chip Kbd ProgressBar SegToggle StatusDot
    forms/               FormRow Input SearchInput Select Textarea
    feedback/            Modal Toast ToastStack
    board/               ListRow NavRow SectionLabel TicketCard
```

Every component takes a `style` prop that merges last, so callers can override any inline value.
Components wrapping a native element (`Button`, `Chip`, `Input`, `Select`, `Textarea`, `SearchInput`)
also forward the rest of that element's attributes.

## Conventions

- **Styling is inline**, referencing `var(--token)`. No CSS classes, no CSS-in-JS runtime — see
  [TOKENS.md](./TOKENS.md) for the full variable list.
- **One dark theme.** There is no light mode and no theme switcher.
- **Hover and focus are component state** (`useState`), not CSS pseudo-classes, because the styles
  are inline. That is why the interactive components are stateful.
- **No icons.** Iconography is colored dots (`StatusDot`), mono text chips (`Chip mono`), and
  unicode characters. Do not add an icon set without flagging it.

Look, voice, and copy rules — including the empty-state and toast wording conventions — were
carried over from the original design bundle's readme (not part of this repo). This directory is
the source of truth for both the design intent and the code.

## Provenance

These components were unpacked from `_ds_bundle.js`, a prebuilt IIFE that read `window.React` and
exported through a `window.PMBoardDesignSystem_cdbc5e` namespace (SB-006). Behavior and every style
value carried over unchanged; what was dropped is the `ui_kits/pm-board` demo app the bundle also
carried, which nothing imported. The original bundle is not part of this repo; the extracted
components here are the source of truth.
