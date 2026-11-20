# A calmer Today

Prototype: `prototypes/today-calm/` (approved 2026-11-20, "After"). Today had too much red and too much chrome. Scope: the Today page only; Calendar and Meetings keep their colours for now.

## Colour

| What | Was | Now |
|---|---|---|
| Event blocks in Schedule, all-day chips | filled with the Outlook calendar colour | a neutral raised block with a 3 px rail in the calendar colour |
| Tentative events | diagonal stripes in the calendar colour | a dashed outline, faded, a faded rail |
| The event happening now in Schedule | as the others | a light accent tint |
| Now line in Schedule | red (`--ws-now`) | the accent (`--ws-now` set to the accent inside `.ws-today-page`) |
| "Now · ends in …" pill | red | the accent; amber when 5 minutes or less are left (`ws-ending`) |
| Happening now: rail beside the time, progress bar | calendar colour, red | a dot in the calendar colour before the time; the accent |

Red stays for real problems (overdue tasks, Critical messages, failures).

## Chrome

- Card headers: a small faint icon instead of the 28 px tile; the sliders and ⋯ show when the card is hovered, focused or its menu is open (always in Customize, and on touch screens).
- Page header: a 40 px avatar, a 22 px greeting, and two controls: Customize, and a ⋯ menu with the layouts (use, delete, save as new, reset), Add widget and Lock layout. While locked, a lock button shows beside Customize to unlock. Customize mode keeps its edit bar with the layout pill.

## Content

- Happening now / Up next: the meeting title in the sans font; Open in Outlook as a quiet button; the "Later today" chips become one line, `Next · 15:30 Title · in 31 min` (the widget option keeps its key `later`).
- Tasks: the review banner becomes one quiet line, `✦ N tasks from meeting notes to review →`; the quick-add form sits behind a `+ Add task` row (a `details` that renders keep open; opening it focuses the text field). The row is at the top so a long list never hides it.
- Needs your reply: 28 px avatars, the name and the conversation on one line, the preview under it, the AI draft button shown on hover or focus.

## Plan (4 tasks)

1. Colours (`workspace.css`, `view-today.js` for `ws-current` and `ws-ending`) with unit tests.
2. Header ⋯ menu and lock indicator (`today-edit-view.js`, `view-today.js`), card chrome CSS; update the header unit test and the browser steps that click the lock or read the layout pill.
3. Happening now Next line, Tasks review line and add row (`app.js` focuses the field), reply rows; update unit and browser tests.
4. Gates: `npm test`, the full browser run, screenshots checked by eye in both themes.
