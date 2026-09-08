# Better Board

A Chrome/Edge extension that rewrites the GitHub Projects **board** view in place, adding two
controls the built-in UI makes you dig through menus for:

- **Team row** — every person assigned to something on this board, as avatar chips directly
  under the filter bar. Click one to filter to them; click again to clear.
  Cmd/Ctrl/Shift-click to select several at once.
- **Column toggles** — one chip per board column. Click to hide or show that column.

Both controls drive the page itself: the team row writes into GitHub's own filter input, so the
URL, the item counts and the Save/Discard buttons all behave exactly as if you had typed the
query by hand. Column visibility is purely local to your browser.

## Install

**Chrome / Edge**

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this directory.

**Firefox** (140+; the manifest asks for 142+)

1. Open `about:debugging#/runtime/this-firefox`.
2. Choose **Load Temporary Add-on** and select `manifest.json`.

Or, with [`web-ext`](https://github.com/mozilla/web-ext) installed:

```
npx web-ext run
```

Open any GitHub Projects board view and the bar appears below the filter input. Toggle the whole
thing off from the extension's popup.

## Notes

Selections are remembered per project. Hidden columns persist across reloads; the assignee
selection is reflected in the filter query, so it also survives sharing the URL.

The team list is built from the assignees on the board's items — it grows as more items load and
never shrinks while you filter, so you can always click your way back to someone.

## Layout

| File | Purpose |
| --- | --- |
| `manifest.json` | MV3 manifest, content script registration |
| `content.js` | Reads board data, renders the bar, drives the filter and column visibility |
| `content.css` | Styles for the bar, themed off GitHub's own CSS variables |
| `popup.html` / `popup.js` | On/off switch |

`content.js` matches GitHub's hashed CSS-module class names by module prefix (the trailing hash
changes between GitHub deploys, the prefix does not). If GitHub renames a module, the selectors
in `SEL` at the top of the file are the only thing to update.

Both browsers run the same code. Firefox exposes the promise-based extension APIs as `browser`
and Chrome as `chrome`, so `content.js` and `popup.js` each pick whichever exists. There is no
build step and no polyfill dependency.

`npx web-ext lint` should stay clean — it is the only check this repo has.
