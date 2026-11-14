# Turning on the Claude features

Three parts of the site use Claude:

- **Explain this in plain English** (under "What's here?" in the viewer)
- **Plain-English search** (the search box on the homepage and in the viewer), so
  "the fastest star in the sky" or "a cold brown dwarf" works, not just coordinates
- **Notes on mover candidates** (in the "Find movers" card)

Until a key is added, the site still works: search takes coordinates and the test
target names, the mover finder still finds and marks movers, and the Claude buttons
show a short "not set up yet" note.

## Who does this

Whoever owns the Vercel account that hosts the site (Namish). It takes about two
minutes. You need an Anthropic API key, which you can create at
<https://console.anthropic.com/settings/keys> (Claude Console > API keys >
Create key). Add a little credit under Billing; the site uses the cheapest model,
Claude Haiku 5.5, and each answer costs a small fraction of a cent.

## Steps in Vercel

1. Go to <https://vercel.com>, sign in, and open the project for this site.
2. Click **Settings** (top bar), then **Environment Variables** (left side).
3. Under **Key**, type `ANTHROPIC_API_KEY`.
4. Under **Value**, paste the key (it starts with `sk-ant-`).
5. Leave all three environments ticked (Production, Preview, Development) and
   click **Save**.
6. Redeploy so the function picks the key up: open **Deployments**, click the
   three dots on the newest deployment, choose **Redeploy**, and confirm.
7. Check it: open `https://<your-site>/api/claude` in a browser. It should
   show `{"ready":true}`. Then open the site, load WISE 0855 and click
   **Explain this in plain English**.

If the site has two Vercel projects, do this on the one that serves the live address.

Optional: add `CLAUDE_DAILY_LIMIT` (a number, default 600) to change how many
Claude answers the site gives per day before it politely stops until tomorrow.

## How the key stays safe

The key only lives in Vercel's settings. The browser talks to our own small
function at `/api/claude` (the file `api/claude.ts`), and only that function talks
to Anthropic. The browser can't send its own prompt either: it picks one of the
three jobs above and sends the facts, and the function writes the prompt. The
function also limits each visitor to 20 answers per 10 minutes, caps the length of
every answer, and stops after the daily limit.

Never put the key in a file in the repo, in `frontend/.env.production`, or in any
variable whose name starts with `VITE_` (those end up in the browser).

## Trying it on your own computer

Create `frontend/.env.local` (it's ignored by git) with one line:

```
ANTHROPIC_API_KEY=sk-ant-...
```

Then run `npm run setup` once and `npm run dev` as usual. The dev server serves
`/api/claude` itself.

## Other hosts

Netlify, Render, Cloudflare Pages and GitHub Pages don't run `api/claude.ts`, so
the Claude features stay off there and everything else works.
