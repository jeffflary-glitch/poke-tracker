# Pokémon tracker dashboards

Two home-screen web apps on GitHub Pages, one shared codebase. Jeff has no coding background: explain changes in plain words and push straight to main.

| App | Page | Sheet | Photos |
|---|---|---|---|
| Jeff's | `index.html` → /poke-tracker/ | "Pokemon tracker Jeff" | `sealed/photos.json` |
| Max's (Jeff's son) | `max/index.html` → /poke-tracker/max/ | "Pokemon tracker Max" | `max/photos/photos.json` |

- **All styles are in `app.css` and all code in `app.js`.** A feature change goes there once and both apps get it. Each page only holds its header text and a `window.PKT` settings block (owner, sheet name/ID, `who`, photos folder, `store` prefix).
- **Data:** one Apps Script web app (`apps-script/Code.gs`, deployed from Jeff's Google account). `?data=1` reads Jeff's sheet, `?data=1&who=max` reads Max's. It returns `sheetId`, and `app.js` refuses data from the wrong sheet. Changes to Code.gs only take effect after Jeff pastes them into Apps Script and deploys a new version (Deploy → Manage deployments → edit → New version).
- **Saved data on the phone** is namespaced by `store` (`pkt-…` for Jeff, `pkt-max-…` for Max) because both apps share one web origin. TCGdex picture caches (`pkt-tcg-…`) are shared on purpose.
- **Own photos:** add the image to the app's photos folder and list it in that folder's `photos.json`: sealed items by exact name, single cards as "Name Number" (e.g. "Tyrunt 070").
- **Sheet layout** (both sheets identical): Collection, Storage, Grading, Price & Value Logs, Price History, Settings. Each sheet has its own Sunday price check (scheduled task) that writes prices and appends Price History rows.
- Test changes headlessly against both pages before pushing (Playwright is available; mock `script.google.com` with sample data).
