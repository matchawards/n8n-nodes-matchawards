# Review-video recorder

`record.mjs` drives a clean n8n through the Creator Portal review in one continuous Playwright take and records
the browser:
1. Sign in.
2. Install `n8n-nodes-matchawards` from npm (Settings → Community nodes).
3. A manual-trigger workflow running Contract Search (NAICS 541511, federal, limit 5), then the same node on
   Grant and Job.
4. A Get node with ID `{{ $json.id }}`: the full record with description and points of contact.
5. A second workflow where an AI Agent (OpenAI Chat Model) uses the MatchAwards Tool from chat, with NAICS
   defined by the model.

The node has no credentials, so there is no credential step. The take runs about two minutes, with no cuts.

Run it against a throwaway n8n on `localhost:5678` (Docker on a lab box, port-forwarded, or `npx n8n` under
Node 24). `setup.mjs` creates the owner account and dismisses the first-run modals off camera. With
`OPENAI_API_KEY` set, it also stores the OpenAI credential, so the key never appears on screen.

```bash
npm i playwright && npx playwright install chromium
N8N_PW=… OPENAI_API_KEY=… node setup.mjs
N8N_PW=… node record.mjs                          # writes videos/*.webm
DRY=1 NO_CHAT=1 N8N_PW=… node record.mjs          # screenshots only, into shots/; no chat
DRY=1 SKIP_TO_AGENT=1 N8N_PW=… node record.mjs    # iterate on the agent step alone
# trim only the blank lead-in before Chromium's first paint, never anything inside the flow
ffmpeg -ss <lead-in> -i videos/<take>.webm -c:v libx264 -crf 22 -pix_fmt yuv420p -movflags +faststart demo.mp4
```

Notes:
- The real take refuses to start when the package is already installed, because the install is part of the
  review. Use a fresh instance.
- Every `page.goto` repaints white for a second or two and reads as a cut, so after sign-in the script only
  navigates within the app.
- On an empty instance n8n 2.x shows a "Build a workflow" card instead of the "Create workflow" button. The
  script handles both.
- Delete the instance afterwards, because it holds the OpenAI credential.
