# MeetMinder — Project Memory

A step-by-step record of how this project was built, what was decided, where it stands, and what to do next.
**Update this file at the end of every work session** (sections 1, 4 and 7).

_Last updated: 6 October 2026_

---

## 1. Where we are right now

| | |
| --- | --- |
| **Status** | The app is complete and fully tested on Windows. The Mac build script is ready. **It has not been built or run on a real Mac yet.** |
| **Next action** | On the MacBook: unzip `MeetMinder-Mac.zip`, double-click `Build MeetMinder.command`, install from the `.dmg`, then test it (checklist in section 7). |
| **Project folder** | `D:\moshin` on the Windows PC. It's a git repository (branch `main`, no remote/GitHub). |
| **File to copy to the Mac** | `D:\moshin\MeetMinder-Mac.zip`. Rebuild it with `npm run zip:mac` after any change. |
| **Owner** | Suresh P (git author `suresh.p@botspot.app`) |

---

## 2. What we're building (the original brief)

People attend long customer meetings (about 2 hours each) one after another and can't take notes during them. If they record, they lose another 2 hours re-listening to find the points and follow-ups. The app should fix this.

- **Node.js desktop app for a MacBook**, built with HTML, CSS, JS and Node.js.
- **Sweet, user-friendly UI**: rounded corners and buttons, a business-dashboard look, complete functionality.
- **Two screens:**
  1. **Dashboard**
     - Follow-ups for **this day, this week, within 10 days, this month**.
     - Totals: **number of customers** and **meetings attended**.
     - **Add Customer** button at the top right.
  2. **Meetings**
     - **Record Now** and **Upload Meeting** buttons at the top right.
     - Record Now works like a normal voice recorder.
     - Upload Meeting adds meetings that were recorded elsewhere.
- **Record Now** first asks for the **customer in a dropdown**. If the customer is new, the **Add Customer** form opens right there.
- Each recording is saved **locally, in its own folder**, named **`customername_timestamp`**.
- Later request: **make a `.dmg`**. The owner chose to build it on their MacBook with a double-click script.

---

## 3. Key decisions (and why)

| Topic | Decision | Why |
| --- | --- | --- |
| Framework | **Electron 44.5.1**: HTML/CSS/JS interface + Node.js main process. Packaged with **electron-builder 26.15.3**. | The standard way to ship HTML/JS + Node.js as a real Mac app with microphone, file access and a `.dmg`. |
| App identity | Name **MeetMinder**, appId `com.meetminder.app`, version `1.0.0`. | Neutral working name; changing it touches `package.json`, `electron/main.js` (`APP_NAME`), `index.html` and the README. |
| Storage | A JSON database plus recordings in **`~/Documents/MeetMinder`**. The `MEETMINDER_HOME` env var overrides the location. | Simple, no native modules, and a backup is just copying one folder. |
| File naming | `Customer_Name_YYYY-MM-DD_HH-MM-SS.ext`: spaces become `_`, characters not allowed in file names are removed, no colons. Uploads keep their format and are named with the meeting's date/time. | Matches "customername_timestamp" and works on both macOS and Windows. |
| Recording format | **WebM/Opus at 64 kbps** from the browser's MediaRecorder, **streamed to disk every second**. | Reliable in Chromium, about 29 MB per hour, nothing lost on a crash. |
| Seeking fix | `electron/webm-duration.js` writes the length into the WebM header after recording. | Chromium leaves it out, which breaks seeking in long files. |
| Solving the re-listening problem | **Mark moment** (`⌘B`) bookmarks, live notes and follow-ups while recording. The player jumps to moments at up to 2× speed. | Works offline with no AI cost. AI transcription is listed under "ideas for later". |
| Follow-up windows | Today · This Week (today → Sunday, weeks start Monday) · Within 10 Days (today → +10 days) · This Month (today → last day of the month) · plus a red **Overdue** banner. | Matches the brief; overdue items never silently disappear. |
| "Like billing management software" | Read as the **look** (sidebar + dashboard cards), **not** invoicing. | Confirm with the owner if real billing was meant. |
| Mic settings | Echo cancellation **off**; noise suppression and auto-gain **on**. | Keeps voices that come out of the laptop speakers (online meetings). |
| Deleting | Meetings, customers and recordings go to the **Trash / Recycle Bin**. | Mistakes can be undone. |
| Mac signing | **Ad-hoc**: `"identity": "-"`, `"hardenedRuntime": false`. | No Apple Developer ID yet. An app built on the same Mac opens without warnings. |
| `.dmg` names | `MeetMinder-<version>-arm64.dmg` (Apple Silicon) / `-x64.dmg` (Intel). | Makes it clear which file is for which Mac. |
| How to make the `.dmg` | Build on the MacBook with **`Build MeetMinder.command`**. | electron-builder refuses macOS builds on Windows. The owner declined GitHub CLI login and chose the Mac route. |

---

## 4. Step-by-step history

### Step 1: Project setup
- Created `package.json` with Electron 44.5.1 and electron-builder 26.15.3.
- Mac build settings: dmg for arm64 + x64, ad-hoc signing, microphone and Documents-folder permission texts, `build/entitlements.mac.plist`.

### Step 2: The Node.js side (`electron/`)
- **`main.js`**
  - Window with the Mac-style title bar, app menu and shortcuts, single instance.
  - Mic permission via `askForMediaAccess`.
  - Recording: receives audio chunks and writes them to disk, then finishes or discards the recording.
  - Uploads: copies and renames the file. Deletes go to the Trash.
  - Keeps the Mac awake while recording; asks "Stop & Save?" on quit while recording.
  - Recovers interrupted recordings on the next launch.
  - Shows a clear error if macOS blocks the Documents folder.
- **`store.js`**: JSON database with atomic writes and a `.bak` backup taken at every launch.
- **`webm-duration.js`**: the seeking fix for recorded files.
- **`preload.js`**: the small, safe `window.api` bridge between the UI and Node.js.

### Step 3: The interface
- `index.html`: shell with a sidebar and the two tabs.
- `css/styles.css`: design tokens, rounded cards and buttons, automatic dark mode.
- `js/` modules:
  - `app.js`: navigation and top-right buttons
  - `dashboard.js`, `meetings.js`: the two screens
  - `recorder.js`: setup dialog with mic picker and level meter; full-screen recorder with waveform, pause, Mark moment, notes and follow-ups; mini pill when minimized
  - `meeting-detail.js`: player with moment ticks, 1×–2× speed, notes, follow-ups
  - `upload.js`, `customers.js`, `followups.js`
  - `ui.js`: modals, drawer, toasts, menus, searchable customer dropdown with "Add new customer"
  - `store.js`, `utils.js`, `icons.js`

### Step 4: App icon
- Designed `build/icon.svg` and rendered `build/icon.png` (1024×1024) with Electron.

### Step 5: Automated testing on Windows
- Drove the real app with Playwright and Chromium's fake microphone. A separate test library was used, so the real Documents folder was never touched.
- **25 checks passed:**
  - recording and `CustomerName_timestamp` naming
  - paused time excluded from the audio, and the seeking fix
  - moments, notes and follow-ups
  - inline new customer
  - upload with renaming and duration detection
  - follow-up tab counts and the overdue banner
  - search
  - close-while-recording saves the meeting
  - crash recovery
- **10 more checks passed:** playback of a recovered recording, discard, moving a meeting to another customer, deleting a meeting, deleting a customer (with their meetings).
- Reviewed screenshots of every screen in light and dark mode.
- These two suites ran from a temporary folder and are **not in the repo**. The in-repo `scripts/smoke-test.js` covers the core flow.

### Step 6: Polish after review
- Time totals under a minute show seconds.
- Fixed hint-text spacing.
- Mic meter bars ramp up in height.
- Toasts moved to the bottom right, above the recording pill.
- Resume button shows a red dot.
- Meeting drawer focuses the play button, so Space plays.
- Added `scripts/start.js` so `npm start` works even when `ELECTRON_RUN_AS_NODE` is set.

### Step 7: Packaging check
- Built an unpacked Windows app. A packaged smoke test launched it, recorded and saved a file.
- Confirmed `npm start` opens the window.

### Step 8: README
- Features, build/run instructions, data location, shortcuts, follow-up rules, project structure, troubleshooting.

### Step 9: `.dmg` investigation
- electron-builder refuses macOS builds on Windows (`node_modules/app-builder-lib/out/packager.js`, around line 368).
- Its DMG step needs Apple's `hdiutil` and a macOS-only `dmgbuild` bundle.
- Options offered: GitHub's Mac machines, build on the MacBook, or an unofficial cross-build.

### Step 10: GitHub Actions route (prepared, not used)
- Added `.github/workflows/build-mac.yml`. It builds both `.dmg` files, verifies them, installs the app from each and records a test meeting.
- Added `scripts/smoke-test.js`.
- A GitHub CLI login was started, then **cancelled at the owner's request**. Nothing was authorized and no token is stored.
- Web-upload steps were given, then the owner chose to build on the MacBook. The workflow stays in the repo for later.

### Step 11: Git
- Initialized the repository on `main`.
- Commits: `a9f58a4` initial app, `cfe2557` workflow trigger, `6cdecc0` Mac build script. Later commits: see `git log --oneline`.

### Step 12: Double-click Mac build
- Added `Build MeetMinder.command`. It:
  - downloads a private, checksum-verified Node.js 24 into `.tools/` if needed
  - runs `npm ci`
  - builds the `.dmg` for this Mac's chip
  - opens the `.dmg`
- Added `.gitattributes` to keep LF line endings.
- Tested the script's syntax and its Node.js download and checksum step against nodejs.org.
- Created `MeetMinder-Mac.zip` with the script marked executable. Verified with libarchive and .NET, plus a byte-for-byte round trip.

### Step 13: This memory file
- Added `PROJECT_MEMORY.md`, plus `CLAUDE.md` that points Claude Code to it.
- Added `npm run zip:mac` (`scripts/make-mac-zip.js`) to rebuild the Mac zip.

---

## 5. How the app works (quick reference)

**Where things live** (see the README "Project structure" for every file)
- UI: `index.html`, `css/`, `js/`. Node.js side: `electron/`. Icon and Mac settings: `build/`.
- User data: `~/Documents/MeetMinder/`
  - `Recordings/`
  - `meetminder-data.json`
  - `meetminder-data.json.bak`

**Data model** (`meetminder-data.json`)
- **customer**: `id, name, company, phone, email, notes, createdAt, updatedAt`
- **meeting**:
  - identity and source: `id, customerId, title, source (recorded|uploaded)`
  - file: `fileName, originalName, mimeType, sizeBytes`
  - timing and state: `startedAt, durationSec, status (recording|ready), recovered`
  - content: `notes, marks[{ id, t (seconds), note, createdAt }]`
  - `createdAt, updatedAt`
- **followup**: `id, title, dueDate (local YYYY-MM-DD), customerId, meetingId, done, doneAt, createdAt, updatedAt`

**IPC channels** (`electron/main.js` ↔ `electron/preload.js` → `window.api`)
- `app:*`, `data:load`
- `customers:*`, `meetings:*`, `followups:*`
- `recording:start|append|finish|discard`
- `system:*`

**Recording flow**
1. MediaRecorder sends a chunk every second.
2. `recording:append` writes it to disk.
3. On stop, `recording:finish` closes the file and applies the seeking fix.
4. A meeting left in `recording` state at the next launch is recovered automatically.

**Keyboard shortcuts:** `⌘B` mark moment · `⌘⇧R` record · `⌘U` upload · `⌘⇧C` add customer · `⌘1`/`⌘2` switch screens · `Space` play/pause · `←`/`→` skip 5 s · `Esc` close or minimize.

---

## 6. Commands

| Command | What it does |
| --- | --- |
| `npm install` | Installs the dependencies |
| `npm start` | Runs the app from source |
| Double-click `Build MeetMinder.command` (Mac) | Builds the `.dmg` for that Mac and opens it |
| `npm run dist:mac` (Mac only) | Builds both `.dmg` files (arm64 + x64) into `dist/` |
| `npm run dist:win` | Builds a Windows installer |
| `npm run zip:mac` | Creates `MeetMinder-Mac.zip` for copying to a Mac (git-tracked files only) |
| `node scripts/smoke-test.js <app executable> [output folder]` | Launches a packaged build and records a test meeting. Needs `npm install --no-save playwright-core`. |

**Testing tips**
- Set `MEETMINDER_HOME=<folder>` to use a throw-away library.
- Start Electron with `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream` to get a fake microphone (a test tone).

---

## 7. Next steps

### A. First build on the MacBook
- [ ] Copy `MeetMinder-Mac.zip` to the Mac and double-click it to unzip.
- [ ] Double-click `Build MeetMinder.command`. If macOS blocks it, follow the README section "If the script won't open".
- [ ] When the `.dmg` opens, drag MeetMinder into Applications and open it.
- [ ] If anything fails, copy the Terminal output (or take screenshots). Give that, plus this file, to Claude.

### B. Test on the Mac with the real microphone
- [ ] Allow the **Documents folder** and **Microphone** prompts.
- [ ] Dashboard → **Add Customer**.
- [ ] Meetings → **Record Now**:
  - [ ] pick a customer (also try typing a new name → "Add as a new customer")
  - [ ] record 1–2 minutes and press **Mark moment** (`⌘B`)
  - [ ] add a note and a follow-up
  - [ ] **Stop & save**
- [ ] Check `~/Documents/MeetMinder/Recordings` for `Customer_Name_YYYY-MM-DD_HH-MM-SS.webm`.
- [ ] Play it back: jump to a moment and try 1.5× / 2× speed.
- [ ] **Upload Meeting** with a file from another device (e.g. an iPhone Voice Memo `.m4a`).
- [ ] Dashboard: follow-up tabs, overdue banner, tick done / Undo.
- [ ] Minimize the recorder while recording; try quitting while recording (it should offer **Stop & Save**).
- [ ] Look check: title-bar spacing around the traffic lights, dark mode, fonts.

### C. Ideas for later (not started)
- [ ] AI transcription and automatic summary / follow-up extraction (needs a speech-to-text service and API key).
- [ ] Capture the other side of online calls (system audio), not just the microphone.
- [ ] Follow-up reminders as Mac notifications.
- [ ] Export meetings and follow-ups (CSV / PDF).
- [ ] Apple Developer ID signing + notarization, so the `.dmg` can be shared without warnings.
- [ ] Move the full Playwright test suite into the repo.
- [ ] Automatic updates.

---

## 8. Known limitations

- The Mac-specific parts have not run on a real Mac yet: permission prompts, title-bar layout, the `.dmg` build.
- Recordings are WebM. They play in the app, VLC and Chrome, but not in QuickTime.
- Only the microphone is recorded. The other side of a Zoom/Meet call is captured only if it comes through the speakers.
- Ad-hoc signed: a `.dmg` that is *downloaded* onto another Mac shows Gatekeeper warnings (see the README).
- Electron 44 needs macOS 12 (Monterey) or newer.

---

## 9. Gotchas on the Windows development PC

- Shells started by Claude Code / VS Code set `ELECTRON_RUN_AS_NODE=1`, which makes Electron behave like plain Node.js.
  - `npm start` handles this (`scripts/start.js`).
  - When launching `electron.exe` directly, remove the variable first.
- Windows PowerShell 5.1 breaks double quotes inside arguments passed to programs. For git commit messages that contain quotes, use `git commit -F <message file>`.
- electron-builder cannot build macOS targets on Windows (see step 9).
- WSL Ubuntu on this PC is broken: its `ext4.vhdx` disk is missing.
- The Python 3.14 install is broken: `python.exe` is missing.
- The GitHub CLI is not installed, no GitHub login is stored, and the repository has no remote.
- Tests always used temporary libraries via `MEETMINDER_HOME`. The real `Documents\MeetMinder` folder on this PC was never created by them.

---

## 10. How to continue with Claude Code

1. Open `D:\moshin` in VS Code with Claude Code. **`CLAUDE.md` makes Claude read this file automatically.**
2. Say what you want next. For example:
   - *"Continue from PROJECT_MEMORY.md — the Mac build failed, here is the Terminal output: …"*
   - *"Continue from PROJECT_MEMORY.md — add follow-up reminders."*
3. When a step is finished:
   - update **section 1**
   - add an entry in **section 4**
   - tick the boxes in **section 7**
   - after code changes, run `npm run zip:mac` again before copying the project to the Mac
