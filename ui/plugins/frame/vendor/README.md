# Vendored graph libraries

Loaded into every plugin frame for `ctx.ui.graph` / `ctx.ui.newGraph` (`../graph.js`). Third-party code under the MIT
licence, unchanged; no CDN and no npm at build time.

| File | Package | Licence | SHA-256 |
|---|---|---|---|
| `sigma.min.js` | `sigma@4.0.4` `dist/sigma.min.js` | MIT (`sigma.LICENSE`) | `85fa00f99cccbe6d80aaf16eee21dd42c2aaf3f8b02bb21a81b986649ce27416` |
| `graphology.umd.min.js` | `graphology@0.26.0` `dist/graphology.umd.min.js` | MIT (`graphology.LICENSE`) | `e65803eba4826a52a84ec3fedebda3e2434ff25d86b3e2309bfe6575141ab2ff` |
| `graphology-library.min.js` | `graphology-library@0.8.0` `dist/graphology-library.min.js` (ForceAtlas2 and Noverlap, run in the frame) | MIT, same authors (`graphology.LICENSE`) | `a414340a2feb9e859cba7d983022d9ad0cb4f5892c52c0814ac842ac82cc3a47` |

Copied from Echo's vendored copies (`crates/echoctl/ui/vendor/`), whose hashes match the ones above.
`../fonts/GeistMono.ttf` is Connect’s own UI font (SIL Open Font License, `../fonts/OFL-Geist.txt`).
