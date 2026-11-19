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

Deploys use Cloudflare's GitHub integration (**Workers Builds**): every push to the production branch builds and deploys automatically. GitHub Actions only runs the tests.

### 1. Connect the repo (Workers Builds)
Cloudflare dashboard → Workers & Pages → your worker (named `mealplanner`, matching `name` in `wrangler.jsonc`) → **Settings → Build**:
- **Git repository:** this repo, with your production branch (e.g. `main`)
- **Build command:** leave empty (`wrangler deploy` runs `scripts/vendor.js` itself)
- **Deploy command:** the default `npx wrangler deploy` is all it needs. The first deploy creates the D1 database automatically, and the Worker creates or updates its own tables on first use (`worker/migrate.js`).

### 2. Google sign-in client ID
1. The app lives at `https://mealplanner.<subdomain>.workers.dev`.
2. In [Google Cloud Console](https://console.cloud.google.com): create a project → **Google Auth Platform** → *Get started* (app name, your email, Audience: External).
3. **Audience** → *Test users*: add the Gmail address of everyone who'll use the app. While the app is in "Testing", only these people can sign in, which also means nobody else can claim your fresh deployment first.
4. **Clients** → *Create client* → *Web application* → **Authorized JavaScript origins**: `https://mealplanner.<subdomain>.workers.dev` (and `http://localhost:8787` for local testing). Copy the **Client ID**. It isn't secret; ignore the client secret.
5. Put it in `wrangler.jsonc` under `vars.GOOGLE_CLIENT_ID` (or add it as a *Text* variable in Cloudflare → your worker → **Settings → Variables and Secrets**).

### 3. First sign-in
Open the app, name your family and sign in with Google; the first person becomes the family owner. Then **More → Invite someone** and send the link.

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
npm run dev                      # http://localhost:8787
npm run seed                     # in another terminal: 7 sample recipes for demo@example.com
npm test                         # unit tests + the real Worker running locally
```
The test sign-in only works when `DEV_LOGIN=true` **and** the request is to `localhost`, so it can't be enabled on the deployed site by accident.

Code layout: `worker/index.js` (API), `worker/db.js` (D1 queries, all family-scoped), `worker/auth.js` (Google token verification, sessions), `worker/dropbox.js`, `worker/room.js` (live updates), `public/app.js` (the app), `public/lib/*` (planning logic and file reading, shared with tests).
