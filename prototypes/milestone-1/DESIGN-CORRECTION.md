# CodeMie visual correction

The first implemented workspace did not preserve the approved CodeMie visual system. Matching a few dark colors was insufficient: the sans-serif shell, duplicate light palette, opaque navigation and missing platform gradient layers made it look different.

The corrected implementation uses the CodeMie UI source as a read-only reference at `/Users/Vadym_Vlasenko/AI/projects/codemie-ui`. No changes were made there. The refreshed live preview was also inspected through Chrome in both themes; its original Light preference was restored.

| Role | Source and correction |
|---|---|
| Navigation | `Navigation.tsx`, `NavigationLink.tsx`: 196 px rail, 36 px links, GeistMono 14 px and theme-specific active/hover states |
| Shared gradient | `appLevel/Gradient.tsx`: original `gradient.png` at 450 px in dark, `gradient-light.png` at 600 px in light, anchored bottom-left; dark navigation overlay fades from black to 15% black |
| Main canvas | `PageLayout.tsx`: neutral dark canvas; original `content-gradient.png` in light, contained at the bottom |
| Brand | Original full light/dark SVG logos, 156 × 40 px; no reconstructed wordmark |
| Typography | GeistMono for UI, headings and controls; Geist for longer reading and editable text |
| Primary buttons | `Button.tsx`, Tailwind semantic tokens: 28 px, 12 px semibold, 8 px radius; dark `#20222E` fill with `#993EC7 → #5677C8` outline; light `#D5E7FC` fill and `#007AFF` outline/text |
| Settings | Separate secondary sidebar, translucent theme overlay over the shared gradient, section header, circular heading icons and theme preview assets. Sidebar is 308 px on normal desktop widths and 210 px at compact native widths |
| Shared controls | Workspace styles now consume `ui/codemie-tokens.css` rather than a duplicate palette. Focus, inputs, tabs, cards, dialogs, reading content and embedded legacy controls use those roles |

The native workspace retains its active-workspace toolbar and personal Today/Calendar/Inbox organization. These are Connect capabilities; the visual language comes from CodeMie.

## Verification

- 150 browser checks pass with an explicitly mocked native bridge. These include real computed font, geometry, surface, gradient and primary-button values in both themes, primary routes at 1000/1360/1600 px and all Settings sections at 1000 × 700, including full-height columns and internal scroll containers and scroll preservation during background refresh. Native WKWebView review caught and corrected a content-wrapper height gap before final packaging. Source content escaping, drafts, notes, workspace state and schedule flows remain covered.
- JavaScript regression: 529 passed, 3 Windows-only skips, 0 failures.
- Browser screenshots use synthetic data only, under the ignored `output/playwright/design-correction/` directory. No real account records or credentials were copied.
- Final optimized app and DMG resource/shim assertions pass. The packaged WKWebView was visually checked in light and dark after the last build; the bottom height gap is gone, and the existing installation screen mounts. The app is left open in Settings → Appearance with the original Dark preference restored. Artifact hashes are in [evidence/design-correction-build.json](evidence/design-correction-build.json).
- The backend is unchanged by this correction; the earlier Microsoft read-only evidence and open Windows/write/notification/AI/soak gates remain as recorded in `IMPLEMENTATION-VALIDATION.md`.

Copied platform image assets retain provenance and Apache-2.0 attribution in `ui/workspace/assets/NOTICE.txt`.
