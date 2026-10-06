# MeetMinder

A Mac desktop app for people who spend their day in customer meetings. Record a meeting with one click, tap **Mark moment** whenever something important is said, and jot down follow-ups with a due date. Later, jump straight to the moments that matter instead of replaying two hours of audio, and let the dashboard tell you what is due today, this week, within 10 days and this month.

Built with HTML, CSS and JavaScript for the interface and Node.js (Electron) for the desktop side. Everything is stored locally on the Mac. No account or internet connection is needed.

## Features

**Dashboard**
- Follow-ups grouped into **Today · This Week · Within 10 Days · This Month**, plus a red banner for anything overdue. Tick one off and you get an Undo.
- Key numbers: customers, meetings attended, pending follow-ups, and total time recorded.
- Recent meetings and most-met customers.
- **Add Customer** button at the top right.

**Meetings**
- **Upload Meeting** and **Record Now** buttons at the top right.
- Search across titles, customers, notes and key-moment notes. Filter by customer or by recorded/uploaded. Meetings are grouped by month.

**Recording**
- Pick the customer from a searchable dropdown. If they're new, type their name and choose **Add as a new customer**: a quick form opens and they're selected automatically.
- Microphone picker with a live level meter, so you know it works before you start.
- Big timer, live waveform, pause/resume, and **Mark moment** (or press `⌘B`) for key moments.
- Notes and follow-ups can be added while recording.
- **Minimize** keeps recording with a small floating pill, so you can use the rest of the app.
- The file is saved as **`CustomerName_YYYY-MM-DD_HH-MM-SS.webm`** in its own folder: `~/Documents/MeetMinder/Recordings`.

**Meeting details**
- Player with key-moment markers on the timeline, 1×–2× speed, ±15 s skip, and click-to-jump moments.
- Notes save automatically, and each meeting has its own follow-ups. **Show in Finder** reveals the audio file.

**Safety nets**
- Audio is written to disk every second, so a crash or power loss keeps the meeting. The next launch recovers it automatically.
- Closing or quitting during a recording asks you to stop and save first.
- The Mac is kept awake while recording.
- Deleted recordings go to the Trash, so they can still be recovered.

## Build the Mac app (.dmg)

`.dmg` files can only be built on macOS. You need **macOS 12 (Monterey) or newer**.

### The easy way: double-click on your Mac

1. Copy **`MeetMinder-Mac.zip`** to your Mac (USB stick, AirDrop, Google Drive…) and double-click it to unzip. To create or refresh the zip after changes, run `npm run zip:mac` on the PC. You can copy this whole folder instead; `node_modules` isn't needed.
2. In the unzipped **MeetMinder** folder, double-click **Build MeetMinder.command**. A Terminal window opens and builds everything. The first build takes a few minutes.
   - You don't have to install anything. If Node.js is missing, the script downloads a private copy into the folder's `.tools` folder. No admin password is needed.
   - If macOS asks whether Terminal may access your Downloads, Desktop or Documents folder, click **Allow**.
3. When it finishes, the `.dmg` opens by itself. Drag **MeetMinder** into **Applications**. The `.dmg` is also saved in the `dist` folder, built for your Mac's chip (`-arm64` for Apple Silicon, `-x64` for Intel).

Because the app is built on your own Mac, it opens without security warnings.

**If the script won't open:**
- *"cannot be opened because it is from an unidentified developer"* or *"Apple could not verify…"*: right-click the file → **Open** → **Open**. On macOS 15 or newer, go to **System Settings → Privacy & Security** and click **Open Anyway**.
- *"you do not have appropriate access privileges"*: open **Terminal**, type `bash ` (with a space after it), drag **Build MeetMinder.command** into the Terminal window, and press **Return**.

### Other ways to build

- **From Terminal on a Mac:** `npm run dist:mac` builds both `MeetMinder-1.0.0-arm64.dmg` (Apple Silicon: M1, M2, M3, M4…) and `MeetMinder-1.0.0-x64.dmg` (Intel).
- **Without a Mac (GitHub Actions):** every push or upload to a GitHub repository builds both `.dmg` files on GitHub's Mac machines ([.github/workflows/build-mac.yml](.github/workflows/build-mac.yml)). The workflow also installs the app from each `.dmg` and launches it to record a short test meeting. Download the result from the run page under **Artifacts → MeetMinder-macOS**.

### Sharing the .dmg with other Macs

The app is *ad-hoc signed* because it has no Apple Developer certificate. On a Mac that *downloads* the `.dmg` (instead of building it), macOS warns on first launch:
- Go to System Settings → Privacy & Security and click **Open Anyway** (on older macOS: right-click **MeetMinder → Open → Open**).
- If macOS says the app "is damaged", run `xattr -cr /Applications/MeetMinder.app`.

To distribute it without warnings, get an Apple Developer ID, remove `"identity": "-"` from `package.json`, set `"hardenedRuntime": true`, and notarize the app.

## Run it from source (for development)

You need **[Node.js](https://nodejs.org) 20 or newer**.

```bash
cd path/to/this/folder
npm install
npm start
```

The first time you record, macOS asks for microphone access. Click **Allow**. If you clicked *Don't Allow*, go to **System Settings → Privacy & Security → Microphone** and switch it on. While running with `npm start`, macOS may list it as *Electron* or as your terminal app.

## Where your data lives

```
~/Documents/MeetMinder/
├── Recordings/                      ← audio, e.g. Priya_Sharma_2026-10-06_14-30-05.webm
├── meetminder-data.json             ← customers, meetings, notes, key moments, follow-ups
└── meetminder-data.json.bak         ← automatic backup from the last launch
```

To back up, copy that folder. To keep the library somewhere else, such as an external drive, start the app with `MEETMINDER_HOME=/path/to/folder`.

Recordings are WebM/Opus at 64 kbps, about 29 MB per hour with clear voices. They play in MeetMinder, VLC, IINA and Chrome. QuickTime can't open WebM files. Uploads keep their original format (MP3, M4A, WAV, …) and are renamed the same way.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `⌘B` | Mark a key moment while recording (works even when minimized) |
| `⌘⇧R` | Record a meeting |
| `⌘U` | Upload a meeting |
| `⌘⇧C` | Add a customer |
| `⌘1` / `⌘2` | Dashboard / Meetings |
| `Space` | Play / pause (meeting details) |
| `←` / `→` | Skip 5 seconds |
| `Esc` | Close a dialog, or minimize the recorder |

## How the follow-up windows work

| Tab | Shows pending follow-ups due… |
| --- | --- |
| Today | today |
| This Week | from today until Sunday (weeks start on Monday) |
| Within 10 Days | from today to 10 days from now |
| This Month | from today to the last day of the month |
| Overdue banner | before today and not yet done |

## Project structure

```
index.html              App shell: sidebar + the two screens
css/styles.css          Design system: colors, rounded cards and buttons, dark mode
js/
  app.js                Navigation, top-right buttons, global actions
  dashboard.js          Dashboard screen
  meetings.js           Meetings screen
  recorder.js           Record dialog, recorder screen, mini recording pill
  meeting-detail.js     Meeting drawer: player, key moments, notes, follow-ups
  upload.js             Upload meeting dialog
  customers.js          Add/edit customers, customer list
  followups.js          Follow-up items and form
  ui.js                 Modals, drawer, toasts, menus, customer dropdown
  store.js              In-memory state and calls to the Node.js side
  utils.js, icons.js    Helpers and inline SVG icons
electron/
  main.js               Node.js side: window, menu, files, recording, permissions
  preload.js            The safe bridge (window.api) between the UI and Node.js
  store.js              JSON database
  webm-duration.js      Writes the length into recorded files so seeking works
build/                  App icon and macOS entitlements
Build MeetMinder.command  Double-click on a Mac to build the .dmg
scripts/start.js        `npm start` launcher
scripts/smoke-test.js   Launches a packaged build and records a test meeting
scripts/make-mac-zip.js Packs the project into MeetMinder-Mac.zip (`npm run zip:mac`)
PROJECT_MEMORY.md       Step-by-step history, decisions, status and next steps
```

## Developing on Windows

`npm start` works on Windows too. Recordings go to `Documents\MeetMinder\Recordings`, and `npm run dist:win` builds a Windows installer.

## Troubleshooting

- **Recording won't start / no sound:** check System Settings → Privacy & Security → Microphone, and pick the right microphone in the record dialog. Its level bars should move when you speak.
- **"MeetMinder could not start" mentioning Documents:** allow access in System Settings → Privacy & Security → Files and Folders.
- **Online meetings (Zoom, Meet):** MeetMinder records the microphone. To capture the other side clearly, use the Mac's speakers rather than headphones, or upload the meeting tool's own recording afterwards.
