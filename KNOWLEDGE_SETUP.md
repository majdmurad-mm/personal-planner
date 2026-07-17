# Knowledge page — setup

The Knowledge page is a **Google Drive** interface: it browses your files (docs, sheets,
slides, PDFs, images, folders, …) live from Drive. **Nothing is stored in Supabase** — the
app's database is untouched; Drive is the source of truth.

The code is **built and working** (connect/disconnect, folder browsing, breadcrumbs, search,
opening files) — the only thing left is the **Google Cloud setup** below, which you have to do
once in your own Google account before the "connect google drive" button will actually succeed.
Until then, clicking it will fail with an OAuth error, which is expected.

## 1. Google Cloud project

Use the same Google Cloud project the app already uses for Google Photos / Calendar (or create one
at <https://console.cloud.google.com>).

- **Enable APIs** (APIs & Services → Library):
  - **Google Drive API**

## 2. OAuth consent screen

- APIs & Services → **OAuth consent screen**.
- Add this scope (already what the code requests — nothing to change here, just add it to the
  consent screen's scope list):
  - `https://www.googleapis.com/auth/drive.readonly` — read-only browse access to your whole Drive.
- While the app is in "testing", add your Google account as a **test user**.

## 3. OAuth client ID

- APIs & Services → **Credentials** → **OAuth 2.0 Client ID** (type: *Web application*).
- Under **Authorized JavaScript origins** add every origin the app is served from:
  - `https://majdmurad-mm.github.io` (GitHub Pages)
  - `http://localhost:8977` (local preview), if you test locally

## 4. Put the client ID in the app

In `index.html`, find `var GOOGLE_CLIENT_ID = "YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com";`
(shared with Google Calendar — one client ID covers both) and replace it with the real OAuth
client ID from step 3.

This is not a secret — the client ID is a public frontend value (safe in the committed HTML);
access is controlled by the OAuth consent screen + the authorized-origins allowlist, not by
keeping the ID hidden.

## How it works (already built)

- **Auth**: its own token client (`driveTokenClient`), scoped to `drive.readonly` — separate from
  Calendar's token, so connecting/disconnecting one never touches the other. Session-only (in
  memory): reconnect after each page reload, same as Calendar.
- **Browse**: `files.list` against the Drive REST API for whatever folder you're in, rendered as
  tiles in `#knowledgeFiles`. Folders sort first, then alphabetical.
- **Navigate**: clicking a folder tile drills in and pushes onto the breadcrumb trail
  (`driveFolderStack`); clicking any earlier breadcrumb jumps back to that level.
- **Search**: the toolbar's search box (disabled until connected) debounces 350ms then queries
  Drive by name, replacing the current folder view with matches.
- **Open**: clicking a non-folder file opens its `webViewLink` in a new tab (Drive's own viewer).
- **Disconnect**: revokes the token and resets back to the empty "not connected" state.

Not built yet, either of these can be added later if wanted:
- A **Picker**-based "insert from Drive" flow (would need the Picker API + an API key, on top of
  what's here).
- The **Overview** sub-tab — still a placeholder; what goes there is undecided.

See `wireKnowledge()` and the functions just above it in `index.html` (`initDriveClient`,
`connectGoogleDrive`, `loadDriveFolder`, `searchDrive`, `renderKnowledgeFiles`, …) for the code.
