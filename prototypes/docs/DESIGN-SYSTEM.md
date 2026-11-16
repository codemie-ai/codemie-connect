# CodeMie design baseline · v2

Measured on 16 November 2026 in the live https://codemie-preview.lab.epam.com/ app through the Chrome extension. Inspected the Chat, Assistants and Applications surfaces, computed styles and the app's light/dark token definitions. No account records, tokens or real message contents are retained in this proposal.

| Element | Live CodeMie baseline | Prototype adaptation |
|---|---|---|
| UI font | GeistMono, monospace | Local variable font, controls and navigation |
| Reading font | Geist, Arial, Helvetica, sans-serif | Documents, messages, briefing body |
| Navigation | 196 px; 36 px links; radius 8 | Same desktop width, grouped personal workspace destinations |
| Page title | 24 / 32 px, weight 600 | Same |
| Module toolbar | 56 px | Same, with capture, usage and contextual Ask |
| Cards | 1 px border, radius 12, no shadow | Same |
| Main background | #F9F9F9 | Same |
| Sidebar | #FBFBFB | Same, with restrained cyan/violet lower-edge glow |
| Surfaces | #FFFFFF | Same |
| Text | #333333; secondary #666666 | Same |
| Structural border | #E5E5E5; input #CCCCCC | Same |
| Accent / selection | #007AFF / #D5E7FC | Same in light mode |
| Primary action, light | Blue border, tinted blue fill, radius 8 | Same |
| Dark background | #1A1A1A; sidebar #000000; surface #151515 | Same |
| Dark borders | #333436 / #47484A | Same |
| Dark primary / link / status accent | #FFFFFF / #F2F0EF / #C5A9FA | Neutral links; lavender only for status |
| Primary action, dark | #20222E fill; #993EC7 → #5677C8 outline | Same |
| Active dark nav | #212224 | Same |

The live navigation uses roughly 14 px labels. The denser desktop proposal uses 13 px labels and 11–12 px compact controls. This is an intentional workspace adaptation. Larger document prose uses 13–14 px Geist. The lower sidebar glow and blue-violet accents retain CodeMie brand character.

Echo is the functional reference, not the visual system. The proposal removes the earlier faux macOS window strip, lavender page surfaces, generic orbit illustration and large welcome hero. It uses CodeMie's existing list/detail pattern for Inbox, Recipes, Automations and Knowledge review.

## Responsive behavior

At full desktop width, sidebar is 196 px. At narrower desktop widths it becomes an icon rail. At 620 px and below, navigation opens as a drawer. Today stacks cards on mobile; module lists become horizontally scrollable selectors. Tables have their own scroll container. The native desktop is the primary target; narrow views remain usable for review.

## Fonts and plugin UI

The font files are copied unmodified from the local CodeMie UI assets. Original embedded copyright notices are preserved. SIL Open Font License and provenance are included under assets/fonts/.

The production Echo adapter needs a scoped compatibility stylesheet and audited helper markup for unchanged plugin panels. Echo variable/class aliases must live inside the plugin rendering boundary; they must not replace the CodeMie shell's design tokens globally. Packages that assume global Echo DOM structure need explicit conformance checks before compatibility is advertised.

## Milestone 1 correction

The later live dark-theme check distinguished ordinary accent links from the status-accent token. The corrected prototype uses neutral #F2F0EF links, #212224 selection and white focus borders. See [measured roles and evidence](../milestone-1/DARK-THEME.md) and [the implementation plan](../milestone-1/IMPLEMENTATION-PLAN.md).
