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

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this directory.

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
