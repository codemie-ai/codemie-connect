# CodeMie platform design spec for vanilla CSS

Source: `/Users/Vadym_Vlasenko/AI/projects/codemie-ui` (React 18 + Tailwind 3.4.17 + tailwindcss-themer 4.1.1 + PrimeReact 10.9.5, `unstyled:false`, no PrimeReact theme CSS loaded).
Target: `ui/codemie-tokens.css` (dark = `:root`, light = `html.light`).

The colors below were checked by compiling the reference Tailwind config (`tailwind.config.ts`) to plain CSS and converting each `--colors-*` variable to hex. Cascade notes are written only where the visible result differs from what the class list suggests.

**Citation keys**

| Key | Path in codemie-ui |
|---|---|
| `TW` | `tailwind.config.ts` |
| `MS` | `src/assets/stylesheets/main.scss` |
| `VC` | `src/assets/stylesheets/vue_components.scss`. It is loaded after `MS` (`src/main.tsx:28-29`), so at equal specificity it overrides the Tailwind utilities. |
| `TS` | `src/assets/stylesheets/toastify.scss` |
| `C/` | `src/components/` |
| `LARA` | `src/styles/presets/lara/*`, the global PrimeReact pass-through. A component-level `pt` section **replaces** the matching global section; it does not merge with it (`node_modules/primereact/componentbase/componentbase.esm.js:158-160`). |

**Tailwind defaults used throughout:**
- `transition` = `color, background-color, border-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, filter, backdrop-filter`, 150ms `cubic-bezier(0.4,0,0.2,1)`.
- Shadows:
  - `shadow-md` = `0 4px 6px -1px rgb(0 0 0/.1), 0 2px 4px -2px rgb(0 0 0/.1)`
  - `shadow-lg` = `0 10px 15px -3px rgb(0 0 0/.1), 0 4px 6px -4px rgb(0 0 0/.1)`
  - `shadow-xl` = `0 20px 25px -5px rgb(0 0 0/.1), 0 8px 10px -6px rgb(0 0 0/.1)`
- Default ring color is `rgb(147 197 253/.5)`.
- Radii: `rounded` 4, `-md` 6, `-lg` 8, `-xl` 12, `-full` 9999 (all px).
- Letter spacing: `tracking-tight` -0.025em, `tracking-wide` 0.025em.
- Preflight: `html{line-height:1.5}`, `button{color:inherit;background:transparent}`, and the default border color is `#e5e7eb`.
- `darkMode` is `['variant','.nottused * &']` (TW:503), so every `dark:` class in the source is dead.

---

## 0. Token audit and additions

### 0.1 Tokens in `codemie-tokens.css` whose values differ from the source

| Token | File has (dark / light) | Source (dark / light) | Cite |
|---|---|---|---|
| `--color-icon-primary` | #FFFFFF / **#666666** | #FFFFFF / **#47484A** | TW:413 |
| `--color-text-nav` | #CCCCCC / **#FFFFFF** | #CCCCCC / **#333333** (`text-specific-navigation-link`). #FFFFFF is the *bottom* nav label. | TW:390, :388 |
| `--color-success-bg`, `--status-success-bg` | **#1B271F** / #E6F7E6 | **#212624** / #E6F7E6 (`success.secondary`) | TW:453 |
| `--color-cyan-border` | #005866 / **#005866** | #005866 / **#06B6D4** | TW:448 |
| `--color-purple-text` | #F3E8FF / **#C084FC** | #F3E8FF / **#A78BFA** (`advanced.primary`) | TW:470 |
| `--gradient-magical` | `#672D92→#5677C8` / `#3676f7→#cc22f2` | `linear-gradient(90deg,#672D92 0%,#5373C2 100%)` / `linear-gradient(90deg,#336FE8 0%,#C020E3 100%)` | TW:620, :663 |
| `--gradient-primary-btn` | gradient fill | Not in source. The primary button is a solid fill with a gradient **border** (see §1). | TW:581-589 |
| `--shadow-sm/md/lg` (dark) | 0.4–0.6 alpha | Source uses the Tailwind defaults (0.1 alpha) in **both** themes. | TW:540-542 |
| `--color-bg-elevated` comment | "Modals, dropdowns, popovers" | Modals, menus, tooltips and the select panel use `surface-base-secondary` (= `--color-bg-secondary`). `elevated` is used only by the toast, the LARA dropdown and the checkbox preset. | C/Popup/Popup.tsx:210 |
| `--color-border-btn-secondary(-h)` | #333436→transparent / transparent→#007AFF | `<Button variant=secondary>` uses `border-quaternary` (#333436 / #007AFF) and on hover `border-tertiary` (#BBBBBB / #007AFF). | C/Button/Button.tsx:83 |

### 0.2 Missing tokens to add (paste as-is)

```css
:root {                                   /* theme-independent */
  --font-size-root: 16px;                 /* html default; Tailwind rem base */
  --lh-root: 1.5;                         /* preflight html{line-height:1.5} */
  --tracking-tight: -0.025em;
  --tracking-wide: 0.025em;
  --ease-tw: cubic-bezier(0.4, 0, 0.2, 1);
  --transition-tw: 150ms var(--ease-tw);  /* Tailwind `transition` */
  --shadow-tw-md: 0 4px 6px -1px rgba(0,0,0,.1), 0 2px 4px -2px rgba(0,0,0,.1);
  --shadow-tw-lg: 0 10px 15px -3px rgba(0,0,0,.1), 0 4px 6px -4px rgba(0,0,0,.1);
  --shadow-tw-xl: 0 20px 25px -5px rgba(0,0,0,.1), 0 8px 10px -6px rgba(0,0,0,.1);
  --ring-tw-default: rgba(147,197,253,.5);
  --color-mask: rgba(0,0,0,.5);           /* Popup.tsx:223 */
  --switch-w: 32px;  --switch-h: 16px;    /* TW:578-579 */
  --color-tooltip-chart-bg: #1C1C1C;      /* TW:271 */
  --color-nav-badge-bg: #9E00FF; --color-nav-badge-text: #FFFFFF;  /* TW:308,389 */
  --color-nav-bottom-hover: rgba(255,255,255,.15);                  /* TW:307 */
  --font-prose: var(--font-sans);         /* chat/markdown only, MS:67 */
}
:root, :root.dark {
  --color-bg-chat: #1C1C1C;               /* surface.base.chat TW:223 */
  --color-bg-float: #232323;              /* TW:220 */
  --color-bg-btn-secondary-h: #333436;    /* TW:238 */
  --color-bg-table-header: #333436;       /* TW:296 */
  --color-bg-nav-link: #212224;           /* TW:309 */
  --color-bg-nav-rail: linear-gradient(to bottom, #000000, rgba(0,0,0,.15)); /* Navigation.tsx:229 */
  --color-switch-thumb-off: #FFFFFF;  --color-switch-thumb-on: #FFFFFF;      /* TW:292-293 */
  --color-border-tertiary: #BBBBBB;       /* TW:318 */
  --color-border-quaternary: #333436;     /* TW:319 */
  --color-border-interactive: #47484A;    /* TW:354 */
  --color-border-sidebar: #E5E5E5;        /* TW:328 */
  --color-border-avatar: #BBBBBB;         /* TW:330 */
  --color-text-accent: #F2F0EF;           /* TW:375 (alias of --color-primary-action-text) */
  --color-text-accent-status: #C5A9FA;  --color-text-accent-status-h: #AC94D9; /* TW:377-378 */
  --color-text-info: #BBBBBB;             /* TW:384 */
  --color-text-error: #F9303C;            /* TW:385 */
  --color-text-nav-hover: #F2F0EF;        /* TW:391 */
  --color-text-nav-bottom: #CCCCCC;       /* TW:388 */
  --color-icon-nav: #FFFFFF;  --color-icon-nav-hover: #F2F0EF;  /* TW:392-393 */
  --color-icon-accent: #FFFFFF;           /* TW:421 */
  --color-icon-radio: #BBBBBB;            /* TW:429 */
  --color-danger: #FA323E;  --color-danger-h: #FF4450;           /* TW:460-461 */
  --color-failed-primary: #F0524F;        /* TW:456 */
  --color-success-tint: #212624;          /* TW:453 */
  --color-bg-action: linear-gradient(#212224,#212224);          /* TW:626 (source writes one stop; two stops are the safe form) */
  --color-bg-action-h: none;   /* TW:627-628: self-referencing var resolves to invalid, so background-image:none */
  --color-border-magical: #FFFFFF;        /* border.specific.button.service TW:343 */
  --opacity-card-tag: .3;                 /* TW:637 */
}
.light {
  --color-bg-chat: #FFFFFF;
  --color-bg-float: #F2F0EF;
  --color-bg-btn-secondary-h: #F1F8FF;
  --color-bg-table-header: #FBFBFB;
  --color-bg-nav-link: #D5E7FC;
  --color-bg-nav-rail: transparent;       /* light: gradient image only, border-r on */
  --color-switch-thumb-off: #AAAAAA;  --color-switch-thumb-on: #FFFFFF;
  --color-border-tertiary: #007AFF;
  --color-border-quaternary: #007AFF;
  --color-border-interactive: #CCCCCC;
  --color-border-sidebar: rgba(0,0,0,.1);
  --color-border-avatar: #D5E7FC;
  --color-text-accent: #007AFF;
  --color-text-accent-status: #007AFF;  --color-text-accent-status-h: #4E32FF;
  --color-text-info: #4C4C4C;
  --color-text-error: #F9303C;
  --color-text-nav-hover: #007AFF;
  --color-text-nav-bottom: #FFFFFF;
  --color-icon-nav: #333333;  --color-icon-nav-hover: #007AFF;
  --color-icon-accent: #007AFF;
  --color-icon-radio: #333333;
  --color-danger: #E52530;  --color-danger-h: #D11D28;
  --color-failed-primary: #FE3B4C;
  --color-success-tint: #E6F7E6;
  --color-bg-action: linear-gradient(rgba(0,122,255,.15),rgba(0,122,255,.15));
  --color-bg-action-h: linear-gradient(rgba(0,122,255,.3),rgba(0,122,255,.3));
  --color-border-magical: #CCCCCC;
  --opacity-card-tag: 1;
  /* fixes from 0.1 */
  --color-icon-primary: #47484A;  --color-text-nav: #333333;  --color-cyan-border: #06B6D4;  --color-purple-text: #A78BFA;
  --gradient-magical: linear-gradient(90deg, #336FE8 0%, #C020E3 100%);
}
:root, :root.dark { --color-success-bg: #212624; --status-success-bg: #212624;
  --gradient-magical: linear-gradient(90deg, #672D92 0%, #5373C2 100%); }
```

### 0.3 Resolved semantic map (existing token, then Tailwind name)

| Existing token | TW name | Dark | Light | TW line |
|---|---|---|---|---|
| `--color-bg-page` | surface-base-primary | #1A1A1A | #F9F9F9 | 216 |
| `--color-bg-secondary` | surface-base-secondary | #212224 | #FFFFFF | 217 |
| `--color-bg-tertiary` | surface-base-tertiary | #2E3033 | #FBFBFB | 218 |
| `--color-bg-input` | surface-base-content | #1A1A1A | #FFFFFF | 222 |
| `--color-bg-sidebar` | surface-base-sidebar (app shell, App.tsx:96) | #151515 | #FBFBFB | 224 |
| `--color-bg-nav` | surface-base-navigation | #000000 | #FBFBFB | 221 |
| `--color-bg-card` | surface-specific-card | #151515 | #FFFFFF | 230 |
| `--color-bg-elevated` | surface-elevated | #2E2E2E | #FFFFFF | 209 |
| `--color-bg-hover` | surface-interactive-hover | #212224 | #D5E7FC | 212 |
| `--color-bg-hover-strong` | surface-specific-dropdown-hover | #333436 | #D5E7FC | 279 |
| `--color-bg-input-prefix` | surface-specific-input-prefix | #333436 | #EEEEEE | 299 |
| `--color-bg-btn-primary(-h)` | primary-button(-hover) | #20222E (#262941) | #D5E7FC (#B2D7FF) | 236-237 |
| `--color-bg-header` | page-header | #1C1C1C | #FFFFFF | 311 |
| `--color-text-primary` | text-primary | #FFFFFF | #333333 | 372 |
| `--color-text-secondary` | text-secondary | #F2F0EF | #333333 | 380 |
| `--color-text-tertiary` | text-tertiary | #CCCCCC | #333333 | 381 |
| `--color-text-muted` | text-quaternary | #BBBBBB | #666666 | 382 |
| `--color-text-placeholder` | input placeholder | #CCCCCC | #999999 | 398 |
| `--color-primary-action-text` | text-accent | #F2F0EF | #007AFF | 375 |
| `--color-text-link-hover` | text-accent-hover | #F2F0EF | #0C4DAF | 376 |
| `--color-border-primary` | border-primary | #333436 | #CCCCCC | 316 |
| `--color-border-secondary` | border-secondary | #47484A | #BBBBBB | 317 |
| `--color-border-structural` | border-structural | #333436 | #E5E5E5 | 321 |
| `--color-border-panel` | panel-outline | #333436 | #E5E5E5 | 329 |
| `--color-border-subtle` | border-subtle | #4C4C4C | #999999 | 320 |
| `--color-border-accent` | border-accent | #FFFFFF | #007AFF | 315 |
| `--color-border-focus` | border-focus | #FFFFFF | #000000 | 322 |
| `--color-border-error` | border-error | #F9303C | #F9303C | 323 |
| `--color-error-text` | failed-secondary | #FE3B4C | #FE3B4C | 457 |
| `--gradient-primary-outline` | cta-button-from to primary-button-to | 90deg #993EC7→#5677C8 | #007AFF solid | 331-332, 346 |

---

## 1. Buttons (`C/Button/Button.tsx:56-118`)

**DOM:** `<button class="cm-btn cm-btn--{variant} cm-btn--{size}">[<svg 18px>]Label</button>`.
- The icon comes first and inherits `currentColor`.
- Icon-only buttons are detected when every child is an element (Button.tsx:21-28).
- A loading button gets an overlay `<div class="cm-btn__shimmer">`.

**Base, all variants (lines 61-66):**
- `position:relative; display:flex; align-items:center; justify-content:center`.
- Font: weight 500, then 600 from the size class. GeistMono is inherited.
- `white-space:nowrap; border-radius:8px; border:1px solid; min-width:56px`. Icon-only buttons get `min-width:0`.
- `transition` uses the Tailwind default.

| Size (line) | height | padding | gap | font | line-height | tracking |
|---|---|---|---|---|---|---|
| small (99-100) | 24px | 2px 6px | 4px | 12px / 600 | 20px | -0.025em |
| **medium, default** (101-103) | 28px | 2px 12px. A leading `>svg:first-child` gets `padding-left:8px`. Icon-only: 2px 8px. | 6px | 12px / 600 | 24px | -0.025em |
| large (104-105) | 44px | 6px 16px | 10px | 14px / 600 | 28px | -0.025em |

Default text is the medium size. Modal footers use the medium size.

| Variant (line) | Fill | Border | Text | Hover |
|---|---|---|---|---|
| **primary** (75-76; TW:581-589) | padding-box solid #20222E / #D5E7FC | 1px transparent, border-box `linear-gradient(90deg,#993EC7,#5677C8)` / #007AFF | #F2F0EF / #007AFF | fill becomes #262941 / #B2D7FF, border unchanged |
| **secondary** (83-84) | #212224 / #FFFFFF | #333436 / #007AFF | #F2F0EF / #007AFF | fill #333436 / #F1F8FF, border #BBBBBB / #007AFF |
| **base** (neutral, used for Cancel in ConfirmationModal) (71-72) | #212224 / #FFFFFF | #333436 / #E5E5E5 | #FFFFFF / #333333 | fill #333436 / #E5E5E5 |
| **tertiary / ghost** (91-92) | none | `border:none` | #FFFFFF / #333333 | fill #333436 / #E5E5E5 |
| **delete / danger** (87-88) | `rgba(250,50,62,.1)` / `rgba(229,37,48,.1)` | #FA323E / #E52530 | same as border | border and text #FF4450 / #D11D28, fill same color at 10% |
| action (79-80) | `background-image:linear-gradient(#212224)` / `linear-gradient(rgba(0,122,255,.15))`, ease-in-out | #333436 / #EEEEEE | #F2F0EF / #007AFF | border #FFFFFF / #007AFF; bg-image dark `none` (cyclic var at TW:627-628), light `rgba(0,122,255,.3)` |
| magical (95-96) | `--gradient-magical` | 1px #FFFFFF / #CCCCCC | #FFFFFF | `filter:brightness(.9)`, `transition:all 100ms` |

**States:**

| State | Behavior |
|---|---|
| disabled | `opacity:.5; cursor:not-allowed` (line 108). The hover rules are not guarded in the source, so add `:not(:disabled)` to hover. |
| loading | `cursor:wait` plus the shimmer overlay (line 117): `position:absolute; inset:0; background:linear-gradient(to right,transparent,rgba(255,255,255,.3),transparent); background-size:200% 100%; animation:shimmer 1.5s linear infinite` (TW:507-513: `background-position -200% 0` to `200% 0`). |
| focus-visible | The source sets no rule, so the UA default outline shows. Recommended a11y fill (not in source): `outline:2px solid var(--color-border-accent); outline-offset:2px`. |
| active / pressed | Not defined in the source. |

```css
.cm-btn{position:relative;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;padding:2px 12px;min-width:56px;
  border:1px solid transparent;border-radius:8px;font:600 12px/24px var(--font-ui);letter-spacing:-.025em;white-space:nowrap;cursor:pointer;
  transition:color var(--transition-tw),background-color var(--transition-tw),border-color var(--transition-tw),opacity var(--transition-tw),filter var(--transition-tw);}
.cm-btn:has(>svg:first-child){padding-left:8px}
.cm-btn--icon{min-width:0;padding:2px 8px}
.cm-btn--sm{height:24px;padding:2px 6px;gap:4px;line-height:20px}
.cm-btn--lg{height:44px;padding:6px 16px;gap:10px;font-size:14px;line-height:28px}
.cm-btn--primary{color:var(--color-primary-action-text);
  background:linear-gradient(var(--color-bg-btn-primary),var(--color-bg-btn-primary)) padding-box,var(--gradient-primary-outline) border-box}
.cm-btn--primary:not(:disabled):hover{background:linear-gradient(var(--color-bg-btn-primary-h),var(--color-bg-btn-primary-h)) padding-box,var(--gradient-primary-outline) border-box}
.cm-btn--secondary{background:var(--color-bg-secondary);border-color:var(--color-border-quaternary);color:var(--color-text-accent)}
.cm-btn--secondary:not(:disabled):hover{background:var(--color-bg-btn-secondary-h);border-color:var(--color-border-tertiary)}
.cm-btn--base{background:var(--color-bg-secondary);border-color:var(--color-border-structural);color:var(--color-text-primary)}
.cm-btn--base:not(:disabled):hover,.cm-btn--ghost:not(:disabled):hover{background:var(--color-border-structural)}
.cm-btn--ghost{background:none;border:none;color:var(--color-text-primary)}
.cm-btn--danger{border-color:var(--color-danger);color:var(--color-danger);background:color-mix(in srgb,var(--color-danger) 10%,transparent)}
.cm-btn--danger:not(:disabled):hover{border-color:var(--color-danger-h);color:var(--color-danger-h);background:color-mix(in srgb,var(--color-danger-h) 10%,transparent)}
.cm-btn:disabled{opacity:.5;cursor:not-allowed}
```

---

## 2. Text fields

### 2.1 Input (`C/form/Input/Input.tsx:104-206`)

**DOM:**
```html
div.field (flex col gap 8)
  div.field__label-row
    label.field__label "Label" [span.req "*"] [TooltipButton]
  div.field__box
    [div.field__prefix]
    div.field__inner
      [span.field__icon--left]
      input
      [span.field__icon--right]
  [div.field__error role=alert]
```

| Part | Spec | Line |
|---|---|---|
| label | 12px/16px, `--color-text-muted` (#BBBBBB / #666666). Required `*`: #F9303C, margin-left 2px. Hint icon: info.svg 18px, opacity .6, hover .8, margin-left 4px. | 123-135; C/TooltipButton:59 |
| box | flex; radius 8px; height 32px (`min-h-8 max-h-8`); 1px `--color-border-primary`; bg `--color-bg-input`; transition 150ms | 143 |
| box hover / focus-within | border `--color-border-secondary` (#47484A / #BBBBBB). **No ring, no outline** (`outline-none` on the input). | 146, 186 |
| input | 14px/20px; `--color-text-primary`; transparent; padding **8px** (the later `p-2` overrides the earlier `py-[9px]` through twMerge); height 100% (30px) | 186-187 |
| placeholder | `--color-text-placeholder` (#CCCCCC / #999999) | 186 |
| error | box border #FE3B4C. Message: 14px/20px #FE3B4C, 8px below the box (flex gap). | 109, 144 |
| disabled | opacity .6; hover border stays primary | 147 |
| filled | bg `--color-border-primary` | 148 |
| prefix (`sideLabel`) | 12px, padding 0 8px, radius 8px 0 0 8px, bg `--color-bg-input-prefix`, `outline:1px solid var(--color-border-subtle)` | 153 |
| icon slots | left icon: absolute at left 8px, vertically centered; inner wrapper gets `padding-left:30px` (right icon mirrors this) | 163-172, 196-199 |

**Search input** = Input with left `search.svg` at 16×16, color `--color-text-tertiary` (#CCCCCC / #333333). Example: `pages/settings/administration/usersManagement/components/UsersManagementFilters.tsx:122`. Text starts 38px from the left border.

**Helper text** (`C/form/InfoBox/InfoBox.tsx:34-36`): flex; 12px `--color-text-muted`; info icon 18px at opacity .75 with 8px right margin; text margin-top 2px.

### 2.2 Textarea (`C/form/Textarea/Textarea.tsx:96-138`)

- Radius 8px; 1px `--color-border-primary`; padding 10px 12px; `min-height:48px; max-height:384px`; 14px/20px; bg `--color-bg-input`; `transition` 150ms; placeholder as for Input.
- Hover and focus: border `--color-border-secondary`, `outline:none`.
- **Error:** border **#F9303C** (`border-error`, not #FE3B4C). Message 14px #F9303C.
- **Disabled:** bg `--color-bg-chat` (#1C1C1C / #FFFFFF), opacity .6.
- Uses the `.show-scroll` scrollbar (§9.2).
- Label as for Input; header row is `flex justify-between`; gap 8px.

### 2.3 Select / dropdown trigger (`C/form/Select/Select.tsx:205-289`, `VC:3-66`)

**DOM:**
```html
div.select
  label (12px muted)
  div.select__trigger
    span.select__value
    span.select__chevron (svg 12px)
div.select__panel (portal)
  ul (padding 8px)
    li > p.option
```

| Part | Spec | Cite |
|---|---|---|
| trigger | height 32px; padding 0 8px (`!px-2` beats VC `px-3`); gap 8px; radius 8px; 1px `--color-border-primary`; bg `--color-bg-input`; 14px; `transition:none` (VC:5) | Select:253; VC:4-5 |
| hover / focus / open | border `--color-border-secondary`; `box-shadow:none` (VC:7-13 cancels the LARA ring) | VC:7-13; Select:263 |
| value | 14px GeistMono `--color-text-primary`, margin-right 4px, ellipsis | VC:15-17 |
| placeholder | `--color-text-placeholder` | VC:23-25 |
| chevron | chevron-down.svg 12×12, `--color-text-secondary`; box 18px wide; `transform:rotate(-180deg)` when open, transition 75ms | Select:287-288; VC:27-41 |
| error | border #FE3B4C (!important); message 14px #FE3B4C, margin-top 4px | Select:209, 255 |
| disabled | opacity .6; no pointer events (LARA dropdown:51-53) | |
| panel | margin-top 6px; bg `--color-bg-secondary`; 1px `--color-border-panel`; radius 8px; **padding 0** (VC beats `p-1.5`); `max-width:256px`; `min-width` = trigger width; list padding 8px; max-height 200px with scroll | VC:44-52; Select:259 |
| option | `<p>` padding 6px 10px; 14px/20px; radius 6px; `--color-text-primary`; truncates (tooltip when truncated). Item height 32px. | Select:94; VC:54-63 |
| option hover / keyboard focus | PrimeReact moves focus on hover, so both get bg `--color-bg-hover-strong` (#333436 / #D5E7FC) and text `--color-text-accent` | VC:57-59 |
| selected | No separate style. It shows the focus style because the selected option takes focus when the panel opens. | |

---

## 3. Checkbox and radio

### 3.1 Checkbox (`C/form/Checkbox.tsx:74-131`, `VC:214-238`)

**DOM:**
```html
div (flex col gap 4)
  div (flex center gap 8)
    div.cb-wrap (flex center gap 8; hover color accent)
      div.cb (relative)
        input[type=checkbox] (abs inset 0, opacity 0, z 10)
        div.cb__box > svg
      div > label (14px, ml 8)
  [span.error]
```
The label sits 8px (gap) + 8px (margin) = **16px** from the box.

| State | Box | Icon |
|---|---|---|
| unchecked | 16×16; radius 4px; 1px solid `--color-text-primary` (#FFFFFF / #333333); transparent (VC:221-223 + Checkbox:129) | none |
| checked | bg and border `--color-border-accent` (#FFFFFF / #007AFF) (VC:229-233) | `check-18.svg` path `M4 10L7.21 13.21c.42.42 1.12.38 1.49-.08L16 4`, stroke 1.875, round cap, color `--color-bg-page` (#1A1A1A / #F9F9F9). Rendered at its **intrinsic 18×18** from the box's content origin (not centered; overflows by about 2px). For an equivalent fit, draw it at 14px centered. |
| mixed | same as checked | `checkbox-minus.svg` (12×18) |
| hover | Wrapper and label color become `--color-border-accent`. **The box border does not change**: `!group-hover:` is not a valid Tailwind 3 class and was not generated. | |
| focus-visible | **None in source** (the component pt overrides LARA's `peer-focus-visible:ring-2 ring-border-accent`, LARA checkbox:66). Recommended: `box-shadow:0 0 0 2px var(--color-border-accent)`. | |
| disabled | Wrapper opacity .5, cursor not-allowed (Checkbox:81) | |
| error | 12px `--color-text-error`, margin-left 24px (Checkbox:114) | |

Transition: `transition-colors` 150ms on the box; color transition on the label.

### 3.2 Radio (`C/form/RadioButton/RadioButton.tsx:42-91`, group `C/form/RadioGroup/RadioGroup.tsx:81-103`)

**DOM:**
```html
label.radio (flex center; group; color text-primary, hover accent; transition)
  div (relative flex)
    input.peer (abs, opacity 0, z 10)
    div.radio__box
  span (ml 8, 14px)
```

- **Box:** 18×18, radius 50%, 1px `--color-text-primary`, transition 150ms. `::after` is a 9×9 centered dot with `transform:translate(-50%,-50%) scale(0)` and `transition:transform 100ms ease-in`.
- **Checked:** dot `scale(1)`, dot color `--color-border-accent` (#FFFFFF / #007AFF); border stays `--color-text-primary`.
- **Hover:** border and dot become `--color-border-accent`; label becomes accent.
- **Focus-visible:** `box-shadow:0 0 0 2px var(--color-border-accent)`.
- **Group:** label 12px weight 500 muted; options use a 16px gap, in a row or a column; label-to-options gap 8px.

---

## 4. Switch (`C/form/Switch/Switch.tsx:64-127`, TW:578-579, 618-619, 660-661)

**DOM:**
```html
label.switch (flex center gap 16, cursor pointer, group)
  input.sr-only.peer[type=checkbox][role=switch]
  span.switch__track
  span.switch__label
[p.error]
```

| Part | Dark | Light |
|---|---|---|
| track | 32×16, radius 16px, **no border** | 32×16 (border-box), radius 16px, 1px #CCCCCC; checked border #007AFF |
| track off | `linear-gradient(to right,#BBB,#666)` | `#FFFFFF` (`linear-gradient(#fff,#fff)`) |
| track on | `linear-gradient(to right,#672C92,#547CCC)` | `#007AFF` |
| thumb (`::before`) | 10×10 circle at left 2px (from the padding edge), vertically centered, #FFFFFF in both states | 10×10, off #AAAAAA, on #FFFFFF |
| thumb on | `translateX(16px)` (32 − 16) | same |
| transitions | track `transition: colors 100ms ease-in-out`; thumb `transform 150ms ease-in-out` | same |
| label | 12px `--color-text-tertiary` (#CCCCCC / #333333); hover or focus-visible inside: `--color-border-accent` | same |
| error | track border #FE3B4C; message 14px #FE3B4C, margin-top 4px | same |
| disabled | `cursor:default`. Faded only when `styledDisabled`: opacity .65 and the hover color is suppressed. | same |

The track gets no focus ring; only the label color changes.

```css
.cm-switch__track{position:relative;flex:0 0 var(--switch-w);height:var(--switch-h);border-radius:var(--switch-h);display:flex;align-items:center;
  background:var(--gradient-switch-off);background-origin:border-box;border:1px solid var(--color-border-primary);transition:background-color 100ms ease-in-out,border-color 100ms ease-in-out}
:root:not(.light) .cm-switch__track{border:0}
.cm-switch__track::before{content:'';position:absolute;left:2px;width:10px;height:10px;border-radius:50%;background:var(--color-switch-thumb-off);transition:transform 150ms ease-in-out}
.cm-switch input:checked+.cm-switch__track{background-image:var(--gradient-switch-on);border-color:var(--color-border-accent)}
.cm-switch input:checked+.cm-switch__track::before{transform:translateX(16px);background:var(--color-switch-thumb-on)}
```

---

## 5. Modal / Popup (`C/Popup/Popup.tsx:146-263`) and ConfirmationModal (`C/ConfirmationModal/ConfirmationModal.tsx:66-109`)

| Part | Spec | Line |
|---|---|---|
| overlay | `position:fixed; inset:0; z-index:50; background:rgba(0,0,0,.5)`; **no blur**; flex centered. Below 1024px: padding 16px. | 223-225 |
| panel | bg `--color-bg-secondary` (#212224 / #FFFFFF); 1px `--color-border-panel` (#333436 / #E5E5E5); radius 8px; `shadow-lg` (Tailwind, 0.1 alpha); `max-height:95%`; flex column | 210-212 |
| enter / exit | `scale(.7)` + opacity 0 to `scale(1)`, 150ms `cubic-bezier(0,0,.2,1)`; exit 150ms `cubic-bezier(.4,0,.2,1)` | PrimeReact dialog base CSS |
| header | padding 12px 16px; flex, space-between, gap 16px (when closable); `border-bottom:1px solid var(--color-border-structural)` (when `withBorder`, the default) | 246-248 |
| title | `h4` 16px/24px weight 600; optional description 12px muted with 4px gap | 155-160 |
| close | Bare 18×18 `cross.svg` button. No bg, no padding, color inherits text-primary, no hover style. It is focused on open. | 208 |
| body | padding 16px 16px 0; 14px; `overflow-y:auto; flex:1` | 222, 253 |
| footer | padding 16px; flex, `justify-content:flex-end`, gap 16px; sticky bottom; transparent. `border-top:1px structural` only for the default footer. | 177-195, 254-262 |
| footer buttons | Cancel = **secondary**, Submit = **primary**, both medium (28px) | 179-193 |
| widths | Content-sized by default. `limitWidth`: `max-width:512px; width:100%`. `isFullWidth`: `width:100%; max-width:90vw` (1152px at ≥1280). Common call-site widths: **500px** (×20), 600 (×8), 650 (×7), 480 (×6). Below 1024px: `max-width:100%`. | 211, 214 |

**ConfirmationModal:**
- Popup with `hideClose`, so there is no × and Esc still closes it.
- `min-width:380px; min-height:170px; z-index:60`.
- Header has the border; the footer has **no** border-top.
- Body: `<p>` 14px `--color-text-muted`, margin-bottom 8px.
- Footer: flex end, **gap 12px**. Cancel = **base** variant, Confirm = primary or delete. Delete adds `delete.svg` 18px before the text. Default text is "Delete" / "Cancel".

```html
<div class="cm-modal-mask"><div class="cm-modal" role="dialog" aria-labelledby="t">
  <div class="cm-modal__header"><div><h4 id="t" class="cm-modal__title">Title</h4><div class="cm-modal__desc">…</div></div>
    <button class="cm-modal__close" aria-label="Close"><svg 18/></button></div>
  <div class="cm-modal__body">…</div>
  <div class="cm-modal__footer"><button class="cm-btn cm-btn--secondary">Cancel</button><button class="cm-btn cm-btn--primary">Create</button></div>
</div></div>
```

---

## 6. Tabs and segmented controls

### 6.1 Tabs (`C/Tabs/Tabs.tsx:77-97`, `C/Tabs/Tab.tsx:44-52`)

- **Tablist:** flex stretch; `border-bottom:1px solid var(--color-border-panel)`; margin-bottom 16px.
- **Tab** (`button[role=tab]`): padding 8px 8px 16px; flex, centered, gap 8px; 14px/20px `--color-text-primary`; `border-bottom:2px solid transparent`; transition 150ms. Height ≈ 46px.
- **Hover:** border-bottom color `--color-text-secondary` (#F2F0EF / #333333).
- **Active** (`aria-selected`): border-bottom `--color-text-primary` (#FFFFFF / #333333); weight 600; `cursor:default`.
- **Small:** padding 10px, 12px.
- No focus-visible style in the source.

### 6.2 TabsMenu, underline style (`C/TabsMenu/TabsMenu.tsx:38-62`)

- **Root:** margin-bottom 20px; `::after` is a 1px full-width bottom line in `--color-border-panel`.
- **Item:** margin-right 24px; padding 12px 0; 12px/16px (`text-h5`; the PrimeReact text has `line-height:1`); `border-bottom:1px solid transparent`; `--color-text-primary`.
- **Active:** weight 700; border-bottom `--color-text-primary`; `pointer-events:none`.

### 6.3 Segmented control (SelectButton) (`C/SelectButton/SelectButton.tsx:57-95`)

- **Root:** flex; 1px `--color-border-panel`; radius 8px; 12px/18px weight 600; `overflow:hidden`; bg `--color-bg-secondary`; `--color-text-primary`.
- **Optional caption:** 12px/16px to the left, 8px gap.
- **Segment:** 1px border, radius 8px, `transition` on colors.
  - Unselected: border transparent; padding 4px 16px.
  - **Selected:** padding 5px 17px (the source makes it 2px larger); border `--color-text-accent` (#F2F0EF / #007AFF); bg `--color-bg-table-header` (#333436 / #FBFBFB); color `--color-text-accent`.
  - **Hover:** color `--color-text-accent`, bg `--color-bg-table-header`.
- Optional 16px icon with an 8px gap.

---

## 7. Tooltip, badges, avatar, card, spinner

### 7.1 Tooltip

The global react-tooltip (`src/utils/tooltip.ts:44-59`) and the PrimeReact Tooltip resolve to the same look; PrimeReact's look comes from `MS:301-322`, which beats the component pt classes.

| Property | Value |
|---|---|
| bg | `--color-bg-secondary` (#212224 / #FFFFFF) |
| border | 1px `--color-border-structural` (react-tooltip) or `--color-border-panel` (Prime); both are #333436 / #E5E5E5 |
| radius | 8px |
| padding | 6px 14px (react-tooltip); 4px 14px (Prime) |
| text | `--color-text-primary`. Prime: 14px/20px weight 500. react-tooltip: 90% of 16px = 14.4px, line-height 1.5. `white-space:pre-line`. |
| limits | max-width 500px (react) / 700px (Prime); Prime also `max-height:190px` and a 9-line clamp |
| arrow | none |
| shadow | none |
| motion | opacity 1, `transition:none`; Prime show delay 500ms |
| offset | the Prime wrapper has 8px padding on the placement axis |
| z-index | 10000 |

### 7.2 Status badge (`C/StatusBadge/StatusBadge.tsx:38-72`, `C/StatusBadge.tsx:78-86`)

**DOM:** `div.badge[role=status] > span.badge__dot + text`.

- **Badge:** inline-flex, center; gap 6px; height 17px, line-height 17px; padding 0 8px; radius 9999; 1px border; **10px bold uppercase**; nowrap.
- **Dot:** 7×7 circle. The in-progress dot has `animation:pulse 2s cubic-bezier(.4,0,.6,1) infinite` (opacity 1 to .5 to 1).

| Status | bg (D / L) | text and dot (D / L) | border (D / L) |
|---|---|---|---|
| neutral / not_started | #333333 / #EEEEEE | #A0A0A0 | #4C4C4C / #999999 |
| info / in_progress | #002442 / #D5E7FC | #2297F6 | #003A69 / #2297F6 |
| pending (cyan) | #003942 / #DFFAFF | #06B6D4 | #005866 / #06B6D4 |
| success | **#212624** / #E6F7E6 | #259F4C | #259F4C |
| warning | #492B00 / #FAF2E7 | #F5A534 | #663B00 / #F5A534 |
| error | #262121 / #F0E2E3 | #FE3B4C | #FE3B4C |

These map to the existing `--status-*` tokens, with the success-bg fix from §0.1.

**Solid tag** (LARA tag:19-54):
- 12px bold; padding 4px 8px; radius 6px (or 9999 when rounded); text #FFF.
- bg by severity: neutral #A0A0A0, success #259F4C, info #2297F6, warning #F5A534, danger #F0524F / #FE3B4C.

**Chip** (`C/form/MultiSelect/ChipWrapper.tsx:87-96`):
- inline-flex; gap 6px; height 28px; padding 2px 8px; radius 8px; 1px `--color-border-structural`; bg `--color-bg-secondary`; 12px/24px weight 600 GeistMono; `--color-text-primary`.
- Remove ×: 16px, margin-left 8px; hover color muted; focus-visible 2px ring `--color-border-secondary`.

**Card label tag** (`C/Card/Card.tsx:137`): 12px weight 600; padding 4px 8px; radius 8px; color #FFF; bg `--color-text-accent-status` at opacity `--opacity-card-tag` (.3 dark, 1 light).

**Nav "NEW" badge:** absolute, right 4px; padding 3px 4px; radius 4px; 9px weight 600, line-height 1; bg #9E00FF; text #FFF (`C/Navigation/NavigationSection/NavigationLink.tsx:129`).

### 7.3 Avatar (`C/Avatar/Avatar.tsx:46-70`, `UserAvatar.tsx:28-32`, `src/utils/assistantAvatar.ts:24-58`)

**Common:** radius 50%; bg `rgba(255,255,255,.9)`; border `--color-border-avatar` (#BBBBBB / #D5E7FC); `object-fit:cover`.

| Type | Size | Border |
|---|---|---|
| modal | 176px | 2px |
| default | 96px | 2px |
| medium | 72px | 2px |
| chat | 40px | 1px |
| small | 32px | 1px |
| xs | 24px | 1px |
| dropdown | 20px | 1px |

**User avatar:** sm 24, md 32, lg 40 (px); no border. The nav profile avatar is 36px.

**Fallback initials:** an SVG circle filled with `avatar[hash%21]`.
- Hash: `h=(h*31+charCode)%999983` per character.
- Palette (TW:173-195): #AA47BC #7A1FA2 #6B8592 #465A65 #EC407A #C2175B #5C6BC0 #0288D1 #00579C #0098A6 #00887A #004C3F #689F39 #33691E #8C6E63 #5D4038 #7E57C2 #512DA7 #EF6C00 #F5511E #AA3410.
- Text: white, weight 600, `system-ui` font, size **38%** of the diameter for 2 letters and 44% for 1, centered.
- Initials: first plus last word initial; for a single word, its first 2 alphanumerics; uppercased; `?` when empty.

### 7.4 Card (`C/Card/Card.tsx:86-190`)

**DOM:**
```html
div.card[role=button][tabindex=0] (group)
  [div.card__cover]
  div.card__glow
  div.card__body
    div.card__row
      avatar
      div
        h3.card__title [tag]
        div.card__subtitle
        p.card__desc
    div.card__footer
      actions
      status (ml auto)
```

| Part | Spec |
|---|---|
| surface | radius 12px; bg `--color-bg-card` (#151515 / #FFFFFF); 1px `--color-border-structural`; height 158px (auto below 1024px); `cursor:pointer`; `transition` 150ms |
| body | padding 16px (12px below 640px); flex column, space-between |
| row | gap 16px; min-height 88px |
| title | 16px/24px weight 600, ellipsis, `--color-text-primary` |
| subtitle | 12px muted, gap 6px |
| description | 12px `--color-text-tertiary`; margin-top 16px; 2-line clamp; height 32px |
| footer | margin-top 12px; height 28px; status 12px with 12px gap |
| hover | **Border and bg do not change.** A top-right glow (`card-gradient.svg` / `white-card-gradient.svg`, a 144×107 blurred radial `#200E32→#677AE2→#EC56FF`, light starts #3085E5 at 50% opacity) fades from opacity 0 to 1 over 300ms. |
| focus | none (UA outline) |

### 7.5 Spinner (`C/Spinner/Spinner.tsx:29-38`)

- `output[aria-label=Loading]` with flex centering; a full-page spinner has `min-height:100vh`, an inline one `padding-top:20px`.
- Icon: `loader.svg` at 18px by default (80px for the app boot): 8 spokes with stroke 1.5 and opacities 1, .88, .75, .63, .5, .38, .25, .13; color `--color-text-primary`; `animation:spin 1s linear infinite`.

### 7.6 Callouts

**InfoWarning** (`C/InfoWarning/InfoWarning.tsx:33-48`):
- flex; padding 8px; radius 6px; 1px border; 12px; info icon 18px with 8px right margin; header padding-bottom 8px.

| Type | bg | border |
|---|---|---|
| warning | `rgba(245,165,52,.2)` | #F5A534 |
| info | #002442 / #D5E7FC | #003A69 / #2297F6 |
| error | `rgba(254,59,76,.2)` | #FE3B4C |

**Accordion** (`C/Accordion/Accordion.tsx:55-103`):
- Root: 1px `--color-border-primary`, radius 8px, bg `--color-bg-chat`, `overflow:hidden`.
- Header: padding 16px; bg `--color-bg-secondary`; `box-shadow:0 1px 0 var(--color-border-primary)`; hover opacity .85; title 16px weight 600; description 14px muted, 8px gap.
- Chevron: 12px muted; `rotate(180deg)` when open.
- Body: `grid-template-rows` from 0fr to 1fr over 300ms ease-in-out; padding-top 16px.
- Focus-visible: inset 2px ring `--color-border-accent`.

---

## 8. Navigation, page chrome and typography

### 8.1 Navigation rail (`C/Navigation/Navigation.tsx:227-293`)

**DOM:**
```html
header#navigation-menu (flex col; padding 24 8 16)
  div.logo (px 8)
  div.nav-scroll (flex 1; px 8; overflow auto)
    nav > ul (gap 8) > li > a.nav-link
    div.nav-divider
  div.nav-bottom (gap 12)
    nav (gap 8; px 8)
    profile
    expand-button
```

- **Width:** 72px collapsed, 196px expanded; `transition:width 200ms ease-in-out`.
- **Dark bg:** `linear-gradient(to bottom,#000,rgba(0,0,0,.15))` over the shell bg #151515. Without gradients it is solid #000.
- **Light bg:** transparent over #FBFBFB, plus `border-right:1px solid #E5E5E5`.
- **Logo:** 156×40.
- **Divider:** 1px `--color-border-primary`; margin 16px 8px.
- **Bottom divider:** `rgba(255,255,255,.2)` (`--color-border-primary` when custom appearance is on); margin 0 8px 8px.

**Nav link** (`NavigationLink.tsx:89-136`):
- flex; height 36px; padding 0 11px; gap 16px; radius 8px; 14px/20px `--color-text-nav` (#CCCCCC / #333333); `transition:colors 100ms`.
- Icon: 18×18 `--color-icon-nav` (#FFFFFF / #333333).
- Label: fades `opacity 200ms ease-in-out`, at 0 when collapsed. When collapsed, the tooltip is placed to the right.

| State | bg | text | icon |
|---|---|---|---|
| default | none | #CCCCCC / #333333 | #FFFFFF / #333333 |
| hover | `--color-bg-nav-link` (#212224 / #D5E7FC) | `--color-text-nav-hover` (#F2F0EF / #007AFF) | #F2F0EF / #007AFF |
| active (route match) | #212224 / #D5E7FC | #F2F0EF / #007AFF | #F2F0EF / #007AFF |
| bottom-section link | hover and active `rgba(255,255,255,.15)` | `--color-text-nav-bottom` (#CCCCCC / #FFFFFF); gap 20px | inherits |

**Expand button** (`NavigationExpandButton.tsx:34-49`): height 36px; padding 0 11px; margin 0 8px; radius 8px; gap 24px; 14px; bottom-label color; hover `rgba(255,255,255,.15)`; the 16px `sidebar.svg` is rotated 180° when collapsed.

**Profile popover** (`NavigationProfile.tsx:180-260`):
- 262px wide; bg `--color-bg-secondary`; 1px structural border; radius 8px; `shadow-xl`.
- Rows: padding 8px 16px; 14px; hover `--color-bg-hover-strong`. Dividers: 1px structural.

### 8.2 Secondary sidebar (`C/Sidebar/Sidebar.tsx:72-118`) and its navigation (`C/SidebarNavigation/SidebarNavigation.tsx:76-157`)

- **Width:** 308px; `border-right:1px` `--color-border-sidebar` (or structural when custom appearance is on); `transition:all 150ms ease-in-out`; collapses to width 0.
- **Dark bg:** `bg-sidebar-gradient` = `linear-gradient(#00000033)`, a 20% black tint over #151515. **Light:** `linear-gradient(#F8F8F8AA)` (TW:624, :664). Write these as solid `background-color` `rgba(0,0,0,.2)` / `rgba(248,248,248,.667)`.
- **Layout:** padding-top 40px; horizontal padding 24px. Title `h2` 24px/32px weight 600 `--color-text-primary`. Description 14px weight 600 muted, margin-top 4px. Content margin-top 28px.
- **Section heading:** 13px uppercase weight 600, `letter-spacing:.025em`, `--color-text-muted`, margin-bottom 8px; sections 16px apart.
- **Item:** padding 8px 16px; 14px; radius 6px; margin-bottom 1px; hover and **active** bg `--color-bg-hover-strong` (#333436 / #D5E7FC); 18px icon in `--color-text-accent` with 12px right margin; `transition` 150ms.
- **Item badge:** 10px weight 600; padding 2px 6px; radius 4px.

### 8.3 Page header (`C/Layouts/Layout/PageLayout.tsx:68-152`)

- **`main`:** bg `--color-bg-page`.
- **Header:** height 56px; padding 12px 24px; `border-bottom:1px solid var(--color-border-panel)`; flex, space-between. Optional bg `--color-bg-header` (appearance `pageHeaderElevated`, off by default).
- **Title block:** gap 24px. Back button = secondary medium icon-only (`arrow-left.svg`).
- **Title:** `h1` **18px/28px weight 600** `--color-text-primary` (16px below 1024px). Subtitle 12px muted, ellipsis.
- **Content area:** padding 0 24px; `overflow-y:auto` with `.show-scroll`; optional `max-width:1024px` centered.

The legacy `PageHeader.tsx` (24px weight 400, 2px black bottom border) is not used in the shell.

### 8.4 Typography

**Faces** (`MS:12-26`, `MS:157-161`):
- `body{font-family:"GeistMono",monospace; font-optical-sizing:auto; -webkit-font-smoothing:antialiased}`.
- **Every UI element uses GeistMono**: buttons, inputs, nav, headings, tables and tooltips.
- **Geist (sans)** is used only for chat/markdown prose, thought documents, the terms page and the date-picker calendar (`MS:67`; `C/markdown/Markdown.scss:48`; `src/pages/terms/TermsAndConditionsPage.tsx:83`).
- Both are variable fonts with weights 100–900.
- Root font size 16px; line-height 1.5. Headings have no UA size or weight (Tailwind preflight).

| Role | Size / line-height | Weight | Color | Where |
|---|---|---|---|---|
| Sidebar / page-section title | 24 / 32 | 600 | primary | Sidebar.tsx:101 |
| Catalog page h1 (`text-h2`) | 24 / 24 | 400 | primary | `pages/help/ModelsCatalog/ModelsCatalogPage.tsx:111` |
| Page header title | 18 / 28 | 600 | primary | PageLayout.tsx:109 |
| Modal title / card title / accordion title | 16 / 24 | 600 | primary | Popup:155, Card:118, Accordion:75 |
| Sub-section (`text-h3`) | 16 / 21 | 600 | primary | `pages/help/ModelsCatalog/components/RoutersSection.tsx:54` |
| Body / control text (`text-sm`) | 14 / 20 | 400 | primary | most components (696 uses) |
| Empty-state (`text-h4`) | 14 / 18 | 700 | muted | `C/Table/EmptyList.tsx:39` |
| Section label (uppercase) | 13 / inherit (≈19.5) | 600, +.025em | muted | SidebarNavigation.tsx:79 |
| Toast body (`text-sm-1`) | 13 / 19.5 | 400 | primary | TS:12 |
| Small / caption / field label (`text-xs`) | 12 / 16 | 400 | muted | Input:123 (833 uses) |
| Tab-menu / segmented (`text-h5`) | 12 / 16 (18) | 600–700 | primary | TabsMenu:55 |
| Table | 12 / 1.25 | header 600 | primary | `C/Table/Table.tsx:270` |
| Micro badge (`text-xs-1`) | 10 / 17 | 700 uppercase | status | StatusBadge |
| Markdown h1 / h2 / h3 / p (Geist) | 24/32, 20/28, 18/28, 16/24 | inherit | primary | Markdown.scss:54-64, 135-138 |
| Links | inherit; no underline, underline on hover | – | inherit | MS:175-181 |
| Markdown link | – | – | `--color-text-accent-status` (#C5A9FA / #007AFF), hover #AC94D9 / #4E32FF | Markdown.scss:66-68 |

---

## 9. Menus and scrollbars

### 9.1 Dropdown menu: kebab "more" (`C/NavigationMore/NavigationMore.tsx:157-291`). This is the canonical menu.

| Part | Spec |
|---|---|
| trigger | margin 4px; padding 4px; radius 6px; 1px transparent border; icon `navigation-more.svg` 18px (28px box); hover bg `--color-bg-hover-strong`; disabled opacity .5; focus-visible `box-shadow:0 0 0 1px #fff,0 0 0 3px rgba(147,197,253,.5)` (Tailwind defaults: the ring-offset color is #fff, and the ring color is the default because `ring-primary-500` does not exist) |
| popover | floating-ui, offset **4px**; `width:max-content; min-width:176px; max-width:calc(100vw - 16px)`; padding 8px; radius 8px; 1px `--color-border-structural`; bg `--color-bg-secondary`; **no shadow**; z-index 50 |
| item | flex, center; gap 12px; padding 8px 4px; **12px/16px weight 500**, `letter-spacing:-.025em`; radius 6px; `--color-text-primary`; full width, left-aligned; height 32px; icon slot 20×20 centered |
| item hover | bg `--color-bg-hover-strong` (#333436 / #D5E7FC); color `--color-text-accent` (#F2F0EF / #007AFF) |
| item disabled | opacity .5; `cursor:not-allowed` |
| item focus-visible | 2px ring `rgba(147,197,253,.5)` |
| separator | `<hr>` with margin 4px 0 and `border-top:1px solid var(--color-border-structural)` |

**Other menu skins:**
- **Split-button menu** (`MS:333-341`): bg secondary; padding 4px; radius 6px; `shadow-md`; margin-top 8px. Items: padding 12px 8px; 14px; radius 6px; same hover.
- **Select panel:** §2.3.

### 9.2 Scrollbars (`MS:81-134`)

- **Hidden** everywhere (`::-webkit-scrollbar{display:none}`, `scrollbar-width:none`) except in `textarea` and `.show-scroll`.

```css
.show-scroll{scrollbar-width:thin;scrollbar-color:var(--color-border-structural) transparent}
.show-scroll::-webkit-scrollbar{width:8px;height:8px}
.show-scroll::-webkit-scrollbar-track{background:transparent}
.show-scroll::-webkit-scrollbar-thumb{background-color:var(--color-border-structural);border-radius:8px;border:2px solid transparent;background-clip:content-box} /* visible thumb 4px */
.show-scroll::-webkit-scrollbar-thumb:hover{background-color:var(--color-border-interactive)} /* #47484A / #CCCCCC */
```

---

## 10. Toast (`TS:3-51`, `src/utils/toaster.ts:46-86`, toastify-js 1.12.0)

**DOM:**
```html
div#toast-container
  div.toastify.codemie-toast.codemie-toast-{success|info|err}.on
    h2.codemie-toast-header
    p.codemie-toast-content
    button.toast-close > div.toast-close-icon
```

| Part | Spec |
|---|---|
| container | `position:fixed; right:0; top:55px` (100px on workflow pages); `width:100%; max-width:450px`; z-index 9999; `pointer-events:none` |
| toast | bg `--color-bg-elevated` (#2E2E2E / #FFFFFF); 1px `--color-border-interactive` (#47484A / #CCCCCC); radius 12px; padding 16px 40px 16px 16px; 13px weight 400 `--color-text-primary`; max-width 450px; **no shadow**; `position:absolute` (right 15px, from toastify); glow image `toaster-bg-success.svg` / `toaster-bg-error.svg` top-left, no-repeat (a blurred circle r=44.5 in #22F625 or #FE3B4C at 50%, filter blur 42) |
| motion | opacity 0 to 1, `transition:all .4s cubic-bezier(.215,.61,.355,1)`, slides from top −150px; durations: info and success 3000ms, error 10000ms; hover pauses (`stopOnFocus`) |
| header | block; 14px/20px weight 600. Success **and info**: #259F4C. Error: #FE3B4C. |
| content | margin-top 32px when not empty (`mt-8`) |
| close | absolute at top 7px, right 10px; glyph "✕" 24px weight 300 `--color-text-primary`; hover `--color-text-muted`; `aria-label="Close notification"` |

---

## 11. Table, a short reference (`C/Table/Table.tsx:268-338`, `TableColHeader.tsx:95-106`, `TableCell.tsx:167-181`)

- **Table:** `border-collapse:separate; border-spacing:0`; margin-top 16px; 12px; line-height 1.25.
- **Head (`thead`):** sticky; bg `--color-bg-tertiary` (#2E3033 / #FBFBFB); weight 600. Cells: padding 10px 16px, left-aligned, borders top and bottom 1px structural. The first cell gets a left border and radius 8px top-left; the last gets a right border and radius 8px top-right.
- **Cell:** bg `--color-bg-secondary`; padding 8px 16px; `border-bottom:1px` structural; the outer cells get side borders; the last row gets bottom radii of 8px.
- **Row states:** hover (clickable rows) cells bg `--color-bg-tertiary`; selected `--color-bg-input-prefix` (#333436 / #EEEEEE).
