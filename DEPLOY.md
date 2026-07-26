# Putting Exodus HQ on the internet

Everything is built. This is the checklist. Roughly 30–40 minutes end to end,
and steps 1–5 get you a working site — 6 and 7 are extras you can do later.

You do not need to understand any of the code. Follow the steps.

---

## What you are actually doing

Right now the app runs inside Claude and borrows Claude's connections to Google
and Supabase. On your own site there is no Claude to borrow from, so the site
gets its own keys and keeps them on the server where nobody can see them.

Three keys total: Supabase, Anthropic, and a password of your choosing.

---

## Step 1 — Put the code on GitHub

1. Go to **github.com** and sign in (make an account if you need one, it's free).
2. Click the **+** top right → **New repository**.
3. Name it `exodus-hq`. Set it to **Private**. Don't tick anything else.
4. Click **Create repository**.
5. On the next screen click **uploading an existing file**.
6. Drag in the whole `exodus-hq` folder contents — `index.html`, `thanks.html`,
   `package.json`, `vercel.json`, `DEPLOY.md`, and the `api` folder.
7. Click **Commit changes**.

> Do **not** upload a file called `.env`. There isn't one, and there shouldn't be.
> Keys go into Vercel, never into GitHub.

### ⚠️ Check the `api` folder actually made it

This is the one step that goes wrong. After committing, look at your repo file
list. You should see:

```
api/            <- a folder, click it and there are 7 files inside
index.html
package.json
thanks.html
vercel.json
DEPLOY.md
```

**If `api` is missing**, GitHub dropped it — the web uploader sometimes skips
folders. Fix it like this:

1. **Add file** → **Create new file**
2. In the filename box type: `api/db.js` — typing the `/` creates the folder
3. Open `api/db.js` from the extracted zip in Notepad, copy everything, paste it in
4. **Commit changes**
5. Repeat for the other six: `api/chat.js`, `api/login.js`, `api/form.js`,
   `api/health.js`, `api/calendar.js`, `api/_auth.js`

Tedious but it works every time. Alternatively drag the seven files in one at a
time using **Add file → Upload files** while inside the `api` folder.

---

## Step 2 — Connect Vercel

1. Go to **vercel.com** → **Sign up** → **Continue with GitHub**.
2. **Add New** → **Project**.
3. Find `exodus-hq` → **Import**.
4. Leave every setting alone. Framework should say "Other". That's correct —
   there's no build step.
5. Click **Deploy**.

It'll finish in under a minute and give you a URL like
`exodus-hq-abc123.vercel.app`. Open it. You'll get a password box that doesn't
work yet — that's expected, keys come next.

**If the build fails**, read the red box. The usual cause is the `api` folder not
being in the repo — go back and check the box in step 1.

---

## Step 3 — Add the keys

In Vercel: your project → **Settings** → **Environment Variables**.

Add these one at a time. For each, paste the name in the first box and the value
in the second, leave the environment as "All", click **Save**.

### `SUPABASE_URL`
```
https://eeeleawnlcmpgcwqianl.supabase.co
```

### `SUPABASE_SERVICE_ROLE_KEY`
Go to **supabase.com** → your project → **Settings** (gear, bottom left) →
**API Keys**. Find the **`service_role`** key. Click reveal, copy the whole
thing. It's long and starts with `eyJ`.

> This key can do anything to your database. It only ever lives in Vercel.
> Never paste it into a webpage, a message, or GitHub.

### `ANTHROPIC_API_KEY`
1. Go to **console.anthropic.com** → sign in with your Google account.
2. **Settings** → **Billing** → add **$5** of credit. This is separate from your
   Claude subscription and there's no monthly fee — you're topping up a balance.
3. **API Keys** → **Create Key** → name it `exodus-hq` → copy it. Starts with `sk-ant-`.

At your volume — three agents, a few dozen messages a day — expect a couple of
dollars a month. The $5 will last a while. You can set a spend cap in Billing if
you want a hard ceiling.

### `HQ_PASSWORD`
Whatever you want. This is what you type to get into your own site. Pick
something you'll remember and won't guess-able by others.

### `FORM_WEBHOOK_SECRET`
Any random string — mash the keyboard. `x7Kp2mQ9vBn4` is fine. You'll use it in
step 6.

---

## Step 4 — Wake the database up

This is already done. I installed a function called `exodus_sql` in your Supabase
project that the site uses to talk to your tables. Nothing for you to do here —
it's listed so you know it exists.

If you ever need to check it: Supabase → **SQL Editor** → run
`select exodus_sql('select count(*) from leads');`

---

## Step 5 — Redeploy and test

Environment variables only apply to new deployments.

1. Vercel → **Deployments** → the top one → **⋯** → **Redeploy**.
2. When it finishes, open `your-url.vercel.app/api/health`.

You want to see:

```json
{ "supabase": true, "anthropic": true, "gate": true, "dbReachable": true, "leads": 40 }
```

If anything says `false`, the `notes` line tells you which key is missing.

3. Now open the site itself. Type your password. You should land in the building
   with all your leads, and the sync dot in the banner should go green.

**Then test the three things that were broken in Cowork:**

- **Microphone** — click the mic on any agent. It should ask for permission and
  then work. This is the main reason for moving.
- **Links** — the boardroom table (Discord), the record player (Spotify), the
  theatre screen (TalentFlx). All should open properly now.
- **Your phone** — open the same URL on your phone, type the password. It works.

---

## Step 6 — Point your form at the site (optional but worth it)

This kills the Gmail scraping. Submissions land in your database instantly
instead of you waiting on an inbox read.

In your form's HTML, change the action to:

```
https://YOUR-URL.vercel.app/api/form?key=YOUR_FORM_WEBHOOK_SECRET
```

Keep your field names as `name`, `email`, `phone`, `interest` — it also accepts
`message`, `tel`, `mobile`, `fullname` and a few other variations.

Test it by submitting your own form once. It'll appear on the **Front Desk** tab
and you'll get sent to a thank-you page with the Discord invite on it.

---

## Step 7 — Reconnect Google Calendar (optional)

Only needed if you want Claudia booking appointments again. **Read the warning at
the bottom of this step before starting** — there's a trap.

1. **console.cloud.google.com** → create a project called `exodus-hq`.
2. **APIs & Services** → **Library** → search "Google Calendar API" → **Enable**.
3. **OAuth consent screen** → External → fill in the app name and your email.
4. **Scopes** → add `https://www.googleapis.com/auth/calendar.events`.
5. **Credentials** → **Create Credentials** → **OAuth client ID** →
   type **Web application**. Under **Authorized redirect URIs** add:
   ```
   https://developers.google.com/oauthplayground
   ```
6. Copy the **Client ID** and **Client secret** into Vercel as
   `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
7. Go to **developers.google.com/oauthplayground**. Click the gear top right,
   tick **Use your own OAuth credentials**, paste the ID and secret. In the left
   panel enter the scope `https://www.googleapis.com/auth/calendar.events`,
   click **Authorize APIs**, sign in as `glenkleinllc@gmail.com`, then
   **Exchange authorization code for tokens**. Copy the **Refresh token** into
   Vercel as `GOOGLE_REFRESH_TOKEN`.
8. Redeploy.

### ⚠️ The trap — do this or it breaks every week

While your Google app sits in **Testing** mode, **Google deletes your refresh
token every 7 days.** Claudia would stop booking and you'd have to redo step 7
over and over, forever.

**The fix:** Google Cloud Console → **OAuth consent screen** → **Publish app** →
confirm. That's it.

You'll see a "Google hasn't verified this app" warning the first time you sign
in — click **Advanced** → **Go to exodus-hq (unsafe)**. It's your own app, that
warning just means you haven't paid for a security audit. There's a 100-user
lifetime cap on unverified apps, which is irrelevant when the only user is you.

Full verification needs a third-party security audit that costs real money and
takes weeks. Not worth it for an app with one user.

---

## Updating it after it's live

**There is one file.** `index.html` is the whole app, and it works in both places
— it checks where it's running and adapts. Nothing to merge, nothing to keep in
sync, no second copy that drifts.

So the loop is:

1. You ask me for a change. I edit the file and publish it here, and you see it
   in Cowork straight away, same as always.
2. When you want it live on the site, I hand you the file.
3. **GitHub → your repo → click `index.html` → the pencil icon is fine for small
   things, but easier: `Add file` → `Upload files` → drag the new `index.html`
   in → `Commit changes`.** Uploading a file with the same name replaces it.
4. Vercel notices the commit and redeploys on its own. About 30 seconds. No
   button to press.

That's it. Four clicks and a drag.

**A few things worth knowing:**

- **Nothing breaks while it deploys.** Vercel builds the new version first and
  only switches over when it's ready. Your site stays up the whole time.
- **You can roll back.** Vercel → Deployments → find a working one → `⋯` →
  `Promote to Production`. Instant undo if something I ship is wrong.
- **The API routes rarely change.** Those seven files in `/api` are done. Almost
  every future change is `index.html` only.
- **Your data is never touched by a deploy.** Supabase is a separate service.
  Redeploying the site does not affect your leads, your logs, or the agents'
  memory.
- **Test before you commit** if you want — Cowork *is* your preview. If it looks
  right there, it'll look right on the site.

If you'd rather not touch GitHub at all, tell me and I'll set up the Vercel CLI
so it's a single command from your machine instead.

---

## What changed versus the Cowork version

| | Cowork | Your site |
|---|---|---|
| Your data | Supabase | Same Supabase, unchanged |
| Agent memory | Supabase | Same, unchanged |
| Leads source | Drive sheet + Supabase | Supabase only |
| New form leads | Scraped from Gmail | Webhook, instant |
| Microphone | Blocked by the sandbox | Works |
| External links | Blocked by the sandbox | Work |
| Phone access | No | Yes |
| ElevenLabs voices | Impossible | Possible |
| Twilio dialer | Impossible | Possible |

Your Supabase data carries over completely — 23 tables, all three agents' memory,
your whole pipeline. Nothing to migrate.

---

## If something goes wrong

**Password box won't accept anything** — `HQ_PASSWORD` isn't set, or you didn't
redeploy after adding it. Check `/api/health` for `"gate": true`.

**Site loads but no leads** — check `/api/health`. If `dbReachable` is false the
service role key is wrong or missing.

**Agents don't reply** — `/api/health` will show `"anthropic": false` if the key
is missing. If it's true but they still fail, the account is probably out of
credit — check console.anthropic.com → Billing.

**Sync dot is red** — hover it, the tooltip says why.

**Anything else** — open the browser console (F12), and tell me what it says.

---

## Keeping it safe

- The service role key and the Anthropic key only exist in Vercel. The page never
  sees them.
- Every API route checks your password token first, except `/api/form`, which is
  guarded by its own secret because a form has to be able to reach it.
- The database bridge only accepts reads and writes. `drop`, `truncate` and
  `grant` are refused at both the server and the database. I tested all three.
- It's granted to the service role only — a leaked publishable key gets nothing.
- If you ever think a key leaked: regenerate it in Supabase or Anthropic, paste
  the new one into Vercel, redeploy. Two minutes.
