# CBT Annotation Check

Expert verification of the TOPAS automatic annotations. Experts read a CBT session in which every therapist turn already shows its two automatic labels, the **macro action** (from the TOPAS phase segmentation) and the **micro action**, and mark the labels they think are wrong. Unmarked turns count as correct.

- **Website:** https://saif-daoud.github.io/CBT-annotation-verif/
- **API:** https://cbt-annotation-verif-api.saif-sedaoud.workers.dev (Cloudflare Worker + D1 database `cbt_annotation_verif`)

This is a companion to the full annotation study ([cbt-annotation](https://github.com/saif-daoud/cbt-annotation)); it reuses its sign-in, profiles, autosave and export.

## What experts do

1. Sign in with email + study access code (experts already registered in earlier studies skip the profile form).
2. Open one of the **2 sessions** (S01 and S02, the same transcripts as in the full annotation study, so expert verdicts can be compared with full expert annotations of the same sessions).
3. A short instruction page explains the task and the two labels.
4. In a single view, each therapist turn shows both labels. Experts tick **Macro action is wrong** and/or **Micro action is wrong**, optionally add a note (e.g. the label they would choose), and submit.

## Data

`scripts/build_data.py` builds the private seed from `../cbt-annotation/data/sessions.json` and the TOPAS automatic annotations in `annotations_topas/` (`annotations_macro_actions.csv`, `annotations_micro_actions.csv`). Each turn takes the macro action of the TOPAS phase it falls in (patient turns between phases go with the preceding phase); therapist turns also take the TOPAS micro action. The script checks that the TOPAS utterance IDs line up with each transcript.

**Transcripts and personal data are never committed:** `data/` is git-ignored and the content lives only in D1.

## Run locally

```bash
python scripts/build_data.py                 # creates data/seed.sql (private)
cd worker && npm install
cp .dev.vars.example .dev.vars
npm run dev:local                            # http://127.0.0.1:8787 (loads data/seed.sql and data/experts.sql)
npm test
```

## Deploy

GitHub Actions publishes `frontend/` to GitHub Pages on every push to `main`, and tests the Worker; it deploys the Worker when the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are set. One-time setup (already done):

```bash
cd worker
npx wrangler secret put ACCESS_CODE && npx wrangler secret put TOKEN_SECRET && npx wrangler secret put ADMIN_TOKEN
npm run db:migrate:remote
npm run db:seed:remote          # data/seed.sql
npm run db:experts:remote       # data/experts.sql (pre-registered experts)
```

## Export

```bash
ADMIN_TOKEN=... node scripts/export.mjs     # exports/cbt-annotation-verif-<time>.json (git-ignored)
```

For every expert and session, `verification.turns` lists each therapist turn with its `utterance_id` (TOPAS numbering), the automatic `macro_action` and `micro_action`, `macro_wrong`, `micro_wrong` and the note. `verification.summary` gives the macro accuracy, the micro accuracy, and the micro accuracy on turns whose macro action was judged correct. A test account can be removed with `POST /api/admin/delete-expert` (`{"admin_token": "...", "email": "..."}`).
