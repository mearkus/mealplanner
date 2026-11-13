# Our Meals 🍽

A shared meal planner for two people (or a whole household). You can:

- **Import your recipes** from Dropbox (or by uploading files, pasting text, or adding a web link)
- **Plan the week**, and get a **shopping list built automatically**: quantities are added up across meals, sorted by store aisle, and shared live between your phones
- **Remember favourites**: ⭐ a recipe and tap ✅ when you cook it. The app shows favourites you *haven't had in a while*.
- **Choose how healthy the week is**: every recipe gets a 1–5 healthiness rating (Indulgent → Very healthy), set automatically and easy to change. Suggestions follow the goal you pick (Light / Balanced / Comfort / Anything), and richer recipes come with "make it lighter" swap ideas.
- **Batch meals with shared ingredients**: the plan shows which meals to *cook together* (with prep-once tips), suggests recipes that *use up* what you're already buying, and the shopping list marks items used in more than one meal ♻️.

It's a small Node server with a phone-friendly web app. Add it to your home screen and it works like a regular app.

## Try it locally

Requires Node 22.13+.

```bash
npm install
npm run seed      # optional: 7 sample recipes to play with
npm start         # http://localhost:3000
```

## Put it online so you can both use it

All data lives in one SQLite file, so any host with a persistent disk works. **Always set `APP_PASSWORD`**: it's the one password you both use to log in (once per device).

### Fly.io (about $0–2/month)

```bash
fly launch --copy-config --no-deploy    # pick a unique app name
fly volumes create meals_data --size 1
fly secrets set APP_PASSWORD='something-long' ANTHROPIC_API_KEY='sk-ant-…'   # API key optional
fly deploy
```

Open `https://<your-app>.fly.dev`, log in, and send your wife the link and password.

### Other options
- **Any Docker host** (Railway, Render with a disk, a home server or NAS): `docker build -t meals . && docker run -p 8080:8080 -v meals:/data -e APP_PASSWORD=… meals`
- **A computer at home** with `npm start`, shared through Tailscale (private and free).

## Connecting Dropbox

In the app, go to **More → Dropbox recipes** and follow the three steps:

1. Create a Dropbox app at <https://www.dropbox.com/developers/apps> → *Scoped access* → *Full Dropbox*.
2. On the **Permissions** tab, enable `files.content.read` and click *Submit*.
3. Paste the **App key** into the app, click *Connect*, approve access, and paste back the code Dropbox shows you.

Then set the folder (default `/Recipes`) and press **Import new recipes**. Subfolders are included. Running it again only picks up new files.

**File types read:** `.txt .md .rtf .html .docx .json` always. With `ANTHROPIC_API_KEY` set, also `.pdf .jpg .png .webp` (scans or photos of recipe cards). Claude also handles messy text better than the built-in parser and suggests a healthiness rating.

**Alternative:** if Dropbox syncs to your computer, run `npm run import -- "~/Dropbox/Recipes"` against the database.

## How the smart bits work

| Feature | How |
|---|---|
| Shopping list | Ingredient lines are parsed into amount, unit and name. Synonyms are merged ("scallions" = "green onions"), units are converted (2 tbsp + 1 cup = 1⅛ cups), and amounts scale to the servings you plan. Staples (salt, oil, spices) go in a separate "check the pantry" list. Ticks sync between phones. |
| Healthiness | A score built from ingredients (vegetables, legumes, fish and whole grains raise it; cream, processed meat, cheese and refined carbs lower it), or Claude's rating if enabled. You can always override it. |
| Favourites you haven't had in a while | Favourites sorted by days since you last tapped ✅. |
| Suggestions | Combines your health goal, how long since each favourite was cooked, how many ingredients it shares with the rest of the week, and skips anything cooked in the last 10 days. 🔀 Shuffle gives a new set. |
| Batching | Groups planned meals that share perishable ingredients, so you can prep or buy once, and suggests extra recipes that need little extra shopping. |

## Development

```bash
npm run dev    # restarts on changes
npm test
```

Code layout: `server/ingredients.js` (parsing and units), `server/planner.js` (shopping list, batching, suggestions), `server/health.js`, `server/importer.js` + `server/dropbox.js` + `server/ai.js` (imports), `server/app.js` (API), `public/` (the app). **More → Download backup** exports everything as JSON.
