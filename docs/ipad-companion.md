# iPad companion

The iPad companion is a notebook on your iPad for the session open on the desktop. You write and sketch with the Apple Pencil (notes, mind maps, diagrams) or photograph paper notes. **Every answer you send — multiple choice, free-form, dictated, or practice thinking — carries the notebook pages that changed since your previous answer.** The teacher reads them as images. Plain chat messages never carry pages.

Free-form questions and practice problems can also be answered on the iPad: **Answer from notebook** transcribes your pages with the vision model, you correct the text, and **Send answer** submits it with the changed pages attached. Multiple-choice questions stay on the desktop.

## Setup

1. Install [Tailscale](https://tailscale.com) on the computer and the iPad, signed in to the **same account**. HTTPS certificates must be enabled for the tailnet (admin console → DNS → HTTPS Certificates).
2. In LearnHarness: **Settings → iPad companion**, switch it on.
3. Scan the QR code with the iPad camera and open the link in Safari, then **Share → Add to Home Screen**.

The app now runs `tailscale serve --bg --https=8443 http://127.0.0.1:<port>`. LearnHarness itself still listens only on loopback. Switching off removes **only** the 8443 entry (`tailscale serve --https=8443 off`) and invalidates the pairing. Your other `tailscale serve` routes are never touched.

While switched on, the app re-points the serve entry at its current port on every launch (the desktop picks a new port per launch). The pairing survives restarts, but the QR code is only shown again after **New code**, which also logs out the previously paired iPad.

## Using it

- **Pencil draws, fingers scroll.** A resting palm never leaves marks. Turn on **Finger** to draw with a finger.
- Tools: four pen colours, highlighter, stroke eraser, three widths, undo/redo, photos, pages.
- Pages autosave about a second after you stop writing. A blue dot on a page tab means it changed since your last answer. The header says how many pages your next answer will carry.
- The notebook follows the session shown on the desktop. Each session has its own notebook.
- On the desktop, answered cards show previews of the pages that answer carried. Click a preview to open it full size.

## How pages reach the model

- Pages live in `data/notebooks/<chatId>/` (`notebook.json`, the current strokes per ink page, and one immutable image per saved version).
- At answer time the server attaches the pages whose version is newer than the last version sent. It stores **references** in the answer record and marks them sent after the answer is saved. A refused answer attaches nothing.
- Image bytes are loaded only when the request is built (`toLlmMessages`). Only the **three most recent** answers that carried pages keep their images in the model context. Older ones become a one-line note, because every turn resends the history.
- If the conversation model can't read images, the answer is sent with a note instead of the images, and the card shows a warning.
- Transcription (iPad answers only) uses the **vision** model slot. Its cost is not yet shown in the session's cost meter.

## Security model

- Requests arriving through Tailscale (a tailnet address, a `*.ts.net` host, or Tailscale identity headers) can reach **only** `/companion`, Next's static assets, and `/api/companion/*` (except `/api/companion/admin/*`). Everything else returns 404. See `proxy.ts` and `src/server/companion/access.ts`.
- Companion API calls need the pairing token (256-bit, stored only as a SHA-256 hash in `data/companion.json`) **and** a `Tailscale-User-Login` equal to the computer owner's login. Devices shared into your tailnet by other people are refused even if they learn the URL.
- The token travels in the QR link's URL fragment, so it never appears in server logs. The page moves it into local storage and removes it from the address bar.
- A remote caller can only touch the session the desktop currently shows. Notebook file names are strictly validated, which rules out path traversal.

## Development

`npm run dev` works too: `next.config.ts` allows `**.ts.net` as a dev origin so the page's scripts load through Tailscale. Tests: `tests/companion-notebook.test.ts`.
