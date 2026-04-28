# Design · 设计

The visual identity, theme tokens, and component-level UX decisions behind Augur. · Augur 的视觉、主题和组件级 UX 决策。

---

## 1. Aesthetic origin

Augur uses a **paper** aesthetic — warm cream backgrounds, coral accents, system serif body type, and an Italiana display wordmark. The reference point is Anthropic's Claude UI: calm, considered, designed-not-themed.

- **Background**: `#F5F2EB` (light) / `#1F1E1B` (dark) — cream, not pure white. Reads as "paper" not "screen."
- **Surface**: `#FCFAF5` (light) / `#252320` (dark) — slightly lighter than background; cards rest *above* the page.
- **Primary (coral)**: `#C2410C` — single accent. No secondary color. Used for selection, AI affordances, the wordmark mark, smart-cleanup glow, and the OracleHint capsule highlight.
- **Text**: warm dark on warm light, deliberately not pure black/white.

The full palette lives in [`src/dashboard/theme.ts`](../src/dashboard/theme.ts) as a MUI v6 `extendTheme` block with light/dark colorSchemes. Components consume it via CSS vars (`var(--mui-palette-primary-main)` etc.) so the same component works in both schemes without prop drilling.

## 2. Typography

| Use | Family |
|---|---|
| Wordmark "Augur" | **Italiana** (Google Fonts, bundled via `@fontsource/italiana/400.css`) |
| Display + body | System serif chain: `Iowan Old Style, Charter, Cambria, Georgia, serif` |
| Code / mono | System mono chain |

**Why Italiana**: a single-weight, single-stroke artistic Italian serif. Gives the brand a flowing, designed-feel without commissioning a custom logotype. Used only in the nav wordmark — body text stays system-serif so it reads as "this is content" rather than "this is brand."

**Why no sans-serif**: serifs read as paper / publishing / craft; sans reads as utility. Augur is the former.

## 3. The mark — fluff ball

The icon went through several iterations:

1. Asterisk (Claude-like) — too borrowed
2. Arc / flower petals — too soft
3. Spike ball with central hub + end beads — read as "weapon"
4. **Final: 48 coral lines radiating from a center point on a paper-squircle background** — fluff ball

[`public/icons/icon.svg`](../public/icons/icon.svg) is the source — 48 strokes at 7.5° intervals, varying lengths via a 10-step pattern `[1.0, 0.84, 0.92, 0.78, 0.96, 0.86, 0.8, 0.94, 0.88, 0.76]`. No central hub disc, no end beads — keeps the silhouette honest.

The 16/32/48/128 PNGs are regenerated from this SVG at build time via [`@resvg/resvg-js`](../scripts/icons.mjs). Single source of truth.

The 2D React companion ([`AugurMark.tsx`](../src/dashboard/components/AugurMark.tsx)) renders the same 48-stroke pattern via `Array.from({ length: RAY_COUNT })`. Used in the nav.

## 4. The 3D MagicBall

Next to the greeting sits a 3D version of the mark — [`MagicBall.tsx`](../src/dashboard/components/MagicBall.tsx). 80 thin coral struts on a Fibonacci sphere, no central hub, sharp rectangles (not pill-shaped, which become ovals when foreshortened in 3D and read as "stray balls").

**Mouse-follow**: cursor position drives rotation as if the user is dragging the ball, not flicking it.
- `targetY = -mouseX * 140` (cursor moves right → ball rotates so its left side comes toward the camera)
- `targetX = -mouseY * 110` (cursor moves down → ball tilts top-toward-camera)

The "drag" metaphor matters — earlier iterations used `+mouseX` and felt like the ball was "fleeing" the cursor. Mental-model alignment: the cursor pulls the visible surface toward itself.

**Idle wobble**: when cursor doesn't move, the ball auto-rotates at `0.05 increment per 50ms` (2× the original speed — first iteration felt sluggish).

**Strut details**:
- Thickness 1.1–1.3 px
- Length pattern `[1.0, 0.84, 0.92, 0.78, 0.96, 0.86, 0.8, 0.94, 0.88, 0.76]` (matches the icon)
- Per-strut opacity variation `0.62 + ((i * 37) % 32) / 100` — deterministic pseudo-random shading

## 5. Component decisions

### OracleHint (Dynamic Island)

Capsule at top of new tab when the model is genuinely confident (top candidate ≥ 0.55 calibrated). Three slots:

```
┌──────────────────────────────────────────┐
│   [#2 left]   [★ #1 centre ★]   [#3 right] │
└──────────────────────────────────────────┘
```

- Center is the highest-confidence pick and is selected by default.
- ←/→ navigates, Enter opens, Esc dismisses.
- Auto-dismisses after 3 s of inactivity.
- Bouncy entrance: `cubic-bezier(0.34, 1.56, 0.64, 1)` over 440ms.

The capsule has `tabIndex={-1}` and calls `node.focus()` on mount to try to claim keyboard focus from the omnibox. Chrome's anti-focus-stealing policy means this only works after the user interacts with the page (click or Tab), so practically the keyboard nav is "first-click warm-up." The mouse interaction always works.

See [`OracleHint.tsx`](../src/dashboard/components/OracleHint.tsx).

### TabWall — coral AI glow

When smart cleanup auto-selects tabs, each row gets a **coral micro-glow** with a 2.4-second breathing animation:

```css
box-shadow: 0 0 0 1px rgba(194, 65, 12, 0.32),
            0 0 12px rgba(194, 65, 12, 0.30);
animation: augur-ai-glow 2.4s ease-in-out infinite;
```

The glow **persists** even if the user unchecks the row — that's the visual contract: "AI proposed this; whether you agreed is the checkbox state." Glow clears on Close or Clear actions.

### AiAssistant — wand button + popover

Magic-wand icon (`AutoFixHigh`) in the nav, between search bar and settings. Click opens a 380-px-wide popover anchored to the bottom-right of the button. Chat panel inside: header (title + refresh icon), scrolling message list with chat bubbles (coral for user, paper for assistant), composer with Enter-to-send.

While streaming: assistant message has a blinking caret (`augur-caret` keyframe). Send button swaps to a Stop button.

See [`AiAssistant.tsx`](../src/dashboard/components/AiAssistant.tsx).

### TodayRecap — no card

The today recap (5 stat icons + numbers) sits **directly on the page** with no card / divider / background. Right-aligned in the hero row's 1fr column next to the greeting. Coral pillow-shape icon backgrounds (`primary-light`) carry the visual weight; the page background carries the rest.

See [`TodayRecap.tsx`](../src/dashboard/components/TodayRecap.tsx).

### PinsRow — drag-reorder + smart-sort

Horizontal row of pinned shortcuts above the hero. Drag reorders manually; "Smart sort" toggle in Settings reorders by predicted relevance (Head A model). Smart sort pauses for 6 hours after a manual drag — your arrangement sticks.

See [`PinsRow.tsx`](../src/dashboard/components/PinsRow.tsx) and [`usePins.ts`](../src/dashboard/hooks/usePins.ts).

### Density tokens

`TabWall` accepts a `dense` prop. Both modes use the same `sizes` object structure to keep the tokens in one place:

```ts
const sizes = dense
  ? { cardPadding: 1.25, headerFavicon: 22, rowFavicon: 14, ... }
  : { cardPadding: 2,    headerFavicon: 32, rowFavicon: 16, ... };
```

Single source of truth; component reads `sizes.X` everywhere. Adding a new density would just add a third object — no scattered conditionals.

## 6. Animation timings

| Surface | Duration | Easing |
|---|---|---|
| OracleHint entrance | 440 ms | `cubic-bezier(0.34, 1.56, 0.64, 1)` (bouncy) |
| OracleHint exit | 200 ms | `cubic-bezier(0.4, 0, 1, 1)` (sharp) |
| AI glow breathe | 2400 ms | `ease-in-out` |
| Tab row hover | 150 ms | `cubic-bezier(0.2, 0, 0, 1)` |
| Slot transitions in OracleHint | 280 ms | `cubic-bezier(0.34, 1.56, 0.64, 1)` |
| Toaster | 200 ms | MUI default |

Bouncy easings only on Augur's distinctive surfaces (OracleHint, slot picks). Everything else uses Material's standard motion to stay calm.

## 7. Layout

The dashboard uses a **1800-px max-width container** (`maxWidth={false}` + manual `maxWidth: 1800`). MUI's default `xl` breakpoint at 1536 leaves big empty gutters on 2K+ screens; 1800 fills them while still staying readable.

Hero row is a 2-column grid: `auto 1fr` (greeting on the left, today recap on the right). Drops to single column on `< md`.

Above-the-fold workspace: 2-column grid `1fr 1fr`. Smart Suggestions on the left, TabWall on the right. Drops to single column on `< lg`.

See [`App.tsx`](../src/dashboard/App.tsx).

## 8. i18n

Two locales: `en` and `zh`, both in [`src/dashboard/i18n/`](../src/dashboard/i18n/). Loaded via `i18next` + `react-i18next`.

Language switcher: Settings → General → Language. No nav-bar toggle — language switching isn't a frequent action and clutters the chrome.

Manifest-level strings (extension name + description) live in [`public/_locales/{en,zh_CN}/messages.json`](../public/_locales/) and are referenced via `__MSG_extName__` / `__MSG_extDescription__` in `manifest.ts`.

## See also

- [ARCHITECTURE.md](./ARCHITECTURE.md) — how the components hang together
- [CONTRIBUTING.md](./CONTRIBUTING.md) — style conventions for new components
