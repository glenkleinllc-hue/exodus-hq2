# What to do

Extract this zip. You get exactly two things:

```
index.html      <- a file
api             <- a folder, with hq.js inside it
```

## Then

1. GitHub → your **exodus-hq2** repo
2. **Add file** → **Upload files**
3. Select **both** — the `index.html` file AND the `api` folder — and drag them
   into the box together
4. **Commit changes**

GitHub keeps the folder structure, and uploading something with the same name
replaces what was there. That is the entire job. No pencil, no Notepad.

## Then the key

Vercel → your project → **Settings** → **Environment Variables**

- Key: `ELEVENLABS_API_KEY`
- Value: your ElevenLabs key
- **Save**

## Then redeploy

Vercel → **Deployments** → top one → **⋯** → **Redeploy**

Environment variables only apply to new deployments. Skipping this is why it
would look like nothing happened.

## Then check

`exodus-hq2.vercel.app/api/health` — you want `"voices": true`

Tell me what it says either way and I will take it from there.
