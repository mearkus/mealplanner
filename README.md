# Our Meals 🍽

A shared meal planner for a family. Everyone signs in with their own Google account; together you're a **family** that shares recipes, plans and one Dropbox connection.

- **Import recipes** from your Dropbox folder: PDFs (with text inside), Word (.docx), web pages, text and Markdown. You can also upload files, paste a recipe, or add a web link.
- **Plan the week**, and get a **shopping list built automatically**: quantities are added up across meals, sorted by store aisle, and ticks sync live between phones.
- **Remember favourites**: ⭐ a recipe and tap ✅ when you cook it. The app shows favourites you *haven't had in a while*.
- **Choose how healthy the week is**: every recipe gets a 1–5 healthiness rating (Indulgent → Very healthy), set automatically and easy to change. Suggestions follow the goal you pick (Light / Balanced / Comfort / Anything), and richer recipes come with "make it lighter" swap ideas.
- **Batch meals with shared ingredients**: the plan shows which meals to *cook together* (with prep-once tips), suggests recipes that *use up* what you're already buying, and the shopping list marks items used in more than one meal ♻️.

It runs on **Cloudflare Workers' free plan** ($0), with a phone-friendly web app you add to your home screen.

## How it's built

| Piece | Where it runs |
|---|---|
| Screens, shopping-list maths, batching, suggestions, health scores | Your phone's browser (`public/`, `public/lib/`) |
| Reading recipe files (PDF via pdf.js, Word via mammoth) | Your phone, so there's no server cost and files never go to a third party |
| Accounts, families, invites, data | Cloudflare Worker + D1 database (`worker/`, `migrations/`) |
| Live updates between phones | A Durable Object per family (`worker/room.js`) |
| Dropbox connection | Stored on the server per family; tokens are never sent to phones |

Keeping heavy work on the phone keeps every server request inside the free plan's 10 ms CPU limit.

## Deploy to Cloudflare (one-time setup, ~15 minutes)

You'll need: a Cloudflare account, this repo on GitHub, and a Google sign-in client ID.

### 1. Google sign-in client ID
1. Find your Cloudflare **workers.dev subdomain** (Cloudflare dashboard → Workers & Pages). The app will live at `https://mealplanner.<subdomain>.workers.dev` (the worker name comes from `name` in `wrangler.jsonc`).
2. In [Google Cloud Console](https://console.cloud.google.com): create a project → **Google Auth Platform** → *Get started* (app name, your email, Audience: External).
3. **Audience** → *Test users*: add the Gmail address of everyone who'll use the app. While the app is in "Testing", only these people can sign in, which is a nice extra lock.
4. **Clients** → *Create client* → *Web application*. Under **Authorized JavaScript origins**, add `https://mealplanner.<subdomain>.workers.dev` (and `http://localhost:8787` for local testing). Copy the **Client ID**. The client ID isn't secret; ignore the client secret, this app doesn't use it.

### 2. Cloudflare API token
1. Cloudflare dashboard → *My Profile* → **API Tokens** → *Create Token* → start from the **Edit Cloudflare Workers** template and add the permission **Account → D1 → Edit**.
2. Copy the token. Also copy your **Account ID** (Workers & Pages overview, right-hand side).

### 3. GitHub
In the repo: **Settings → Secrets and variables → Actions**:
- *Secrets*: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
- *Variables*: `GOOGLE_CLIENT_ID`

Then push to `main` (or run **Actions → Deploy → Run workflow**). The workflow runs the tests, creates the D1 database on first run, applies migrations and deploys.

### 4. First sign-in
Open `https://mealplanner.<subdomain>.workers.dev`, name your family and sign in with Google. The first person to sign in becomes the family owner. Then **More → Invite someone** and send your wife the link. Also add her Gmail as a Google test user (step 1.3).

## Accounts & families
- Sign-in is **Google only**: no passwords to forget or reset.
- **Invite links** (valid 7 days, cancel them any time) let others join your family. After the first family exists, nobody can create an account without an invite. To let other households start their own family on your server, set `ALLOW_NEW_FAMILIES` to `"true"` in `wrangler.jsonc`.
- **Shared within a family:** recipes, favourites, the plan, shopping list, cooking history and the Dropbox connection. The app shows who added a meal or item and who cooked what.
- **Families are completely separate.** Every query is scoped to your family (tests check this).
- **Owners** can remove members. Anyone can rename the family, leave it, or sign out on all devices.

## Connecting Dropbox
**More → Dropbox recipes**:
1. Create a Dropbox app at <https://www.dropbox.com/developers/apps> → *Scoped access* → *Full Dropbox* (needed to read your existing shared recipe folder).
2. **Permissions** tab → enable `files.content.read` → *Submit*.
3. Paste the **App key**, click *Connect*, approve, and paste back the code Dropbox shows.
4. Set the folder (e.g. `/Shared Recipes`) and press **Import new recipes**. Keep that screen open while it runs; running it again only picks up new files.

The person who connects Dropbox decides the folder. The server only lets the family read files **inside that folder**, never the rest of that person's Dropbox. Each recipe keeps a **📄 Original** button that opens the source file.

**PDFs:** PDFs with real text inside (saved from websites, exported from Word, "Print → Save as PDF") are read on the phone, including two-column layouts and files holding several recipes. **Scanned PDFs** (photos of pages) have no text inside; they're listed as "couldn't be read" for now. Text recognition for them is the next step.

## Local development
```bash
npm install
cp .dev.vars.example .dev.vars   # enables the local-only test sign-in
npm run db:migrate:local
npm run dev                      # http://localhost:8787
npm run seed                     # in another terminal: 7 sample recipes for demo@example.com
npm test                         # unit tests + the real Worker running locally
```
The test sign-in only works when `DEV_LOGIN=true` **and** the request is to `localhost`, so it can't be enabled on the deployed site by accident.

Code layout: `worker/index.js` (API), `worker/db.js` (D1 queries, all family-scoped), `worker/auth.js` (Google token verification, sessions), `worker/dropbox.js`, `worker/room.js` (live updates), `public/app.js` (the app), `public/lib/*` (planning logic and file reading, shared with tests).
