# ClientClock – Time Zone Converter & World Clock

A Chrome extension for remote workers and VAs who work with clients in other countries.

- Your own time zone, big and readable
- Add your clients' time zones and give each one a name ("Sarah", "NY office")
- See how far ahead or behind each one is, and whether it's tomorrow or yesterday there
- Cards switch to a night look when it's night in that place (6 PM – 6 AM)
- Search by country, city, US state, or abbreviation (EST, PST, WAT, AEST), no time zone names needed
- Five color palettes (Blush, Sage, Slate, Sand, Graphite) and five fonts for client names
- Light, Dark, or Auto (goes dark when it's night where you are)
- 12h or 24h clock

No account, no tracking, no network requests. Settings are stored with Chrome sync storage so they follow you across your signed-in browsers.

## Install (developer mode)

1. Download or clone this repo.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Pin ClientClock from the puzzle-piece menu.

## Files

| File | What it does |
|---|---|
| `manifest.json` | Extension config (Manifest V3, only the `storage` permission) |
| `popup.html` / `popup.css` / `popup.js` | The popup UI and logic |
| `data.js` | Place search data: every IANA time zone plus countries, capitals, major cities, states, and abbreviations |
| `fonts/` | Outfit, Cormorant Garamond, Playfair Display, Fraunces, Dancing Script (SIL Open Font License), bundled locally |
| `icons/` | Toolbar and store icons |

See [CHANGELOG.md](CHANGELOG.md) for what changed in each version.

## License

MIT
