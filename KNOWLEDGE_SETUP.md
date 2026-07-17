# Knowledge page — setup

The Knowledge page is a **Google Drive** interface: it browses your files (docs, sheets,
slides, PDFs, images, folders, …) live from Drive. **Nothing is stored in Supabase** — the
app's database is untouched; Drive is the source of truth.

The page is currently a **scaffold**: the nav link, the Drive/Overview sub-tabs, the file-grid
shell, and a connect button exist, but the actual Drive connection isn't wired yet. This doc is
the checklist of first actions to make it real. (The integration reuses the same Google Identity
Services the Photos/Calendar widgets already load.)

## 1. Google Cloud project

Use the same Google Cloud project the app already uses for Google Photos / Calendar (or create one
at <https://console.cloud.google.com>).

- **Enable APIs** (APIs & Services → Library):
  - **Google Drive API**
  - **Google Picker API** (for the "open from Drive" picker)

## 2. OAuth consent screen

- APIs & Services → **OAuth consent screen**.
- Add the scope the page needs. Pick the least-privilege one that fits:
  - `https://www.googleapis.com/auth/drive.readonly` — read/browse everything (simplest for a
    read-only knowledge browser), **or**
  - `https://www.googleapis.com/auth/drive.file` — only files the app opens/creates (tighter, but
    can't list your whole Drive).
- While the app is in "testing", add your Google account as a **test user**.

## 3. OAuth client ID + API key

- APIs & Services → **Credentials**:
  - **OAuth 2.0 Client ID** (type: *Web application*). Under **Authorized JavaScript origins** add
    every origin the app is served from:
    - `https://majdmurad-mm.github.io` (GitHub Pages)
    - `http://localhost:8977` (local preview), if you test locally
  - **API key** (needed by the Picker API). Restrict it to the Drive/Picker APIs.

## 4. Put the IDs in the app

In `index.html`:
- Set `GOOGLE_CLIENT_ID` (currently a placeholder) to the OAuth client ID from step 3.
- Add the Drive scope to a token client (the same `google.accounts.oauth2.initTokenClient` pattern
  the Photos widget uses), and the API key where the Picker is initialized.

None of these are secrets — the client ID and API key are public frontend values (they're safe in
the committed HTML); access is controlled by the OAuth consent + the authorized-origins allowlist.

## 5. Then the code (the "worked later" part)

With the above in place, the wiring is:
1. **Connect** button → request a Drive access token via GIS (`initTokenClient` + `requestAccessToken`).
2. **List / browse** → call the Drive API (`files.list`) for the current folder, render each result
   as a `.knowledge-file` tile in `#knowledgeFiles` with a type-appropriate icon.
3. **Open** → open the file's `webViewLink`, or embed a preview.
4. Optionally the **Picker** for an "add from Drive" flow.
5. Define and build the **Overview** sub-tab (the second Knowledge section — TBD).

See the `wireKnowledge()` scaffold in `index.html` for where each of these plugs in.
