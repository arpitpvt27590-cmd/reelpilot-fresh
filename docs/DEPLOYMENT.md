# Beginner deployment guide (GitHub + Cloudflare)

## 1. Create a GitHub repository

1. On GitHub, create a new **private** repository named `reelpilot-fresh`.
2. Upload the contents of this folder, keeping the folder layout exactly as shown. Upload the files inside `reelpilot-fresh`, not an extra nested folder.
3. Commit the files to the `main` branch.

## 2. Create the Cloudflare Worker from GitHub

1. Open Cloudflare Dashboard → Workers & Pages → Create → connect to Git.
2. Choose the new repository and `main` branch.
3. Build command: `npm install` (or leave build command blank if the UI installs dependencies automatically).
4. Deploy command: `npm run deploy`.
5. Confirm the deployment logs show success. The first deploy may need the D1 database binding created before it can run.

## 3. Create D1

1. Cloudflare Dashboard → Storage & databases → D1 SQL database → Create database.
2. Name it `reelpilot-db`.
3. Copy its database ID and replace `REPLACE_WITH_D1_DATABASE_ID` in `wrangler.toml`, then commit the change.
4. In the D1 database console, run the full contents of `migrations/0001_init.sql` once. Alternatively, after Wrangler is configured, run `npm run db:remote` from a developer environment.
5. In Worker settings, add a D1 binding named `DB` pointing to `reelpilot-db`.

## 4. Set Worker variables and secrets

Under Worker → Settings → Variables and Secrets, set:

- Variable `APP_BASE_URL`: the actual deployed Worker URL, e.g. `https://reelpilot-fresh.<your-subdomain>.workers.dev`.
- Variable `GRAPH_API_VERSION`: `v24.0` (adjust only if Meta's current supported version differs).
- Variable `MAX_VIDEO_BYTES`: `95000000`.
- Variable `MAX_BATCH_SIZE`: `300`.
- Secret `ADMIN_PASSWORD`: a strong unique dashboard password.
- Secret `SESSION_SECRET`: a long random value. This starter currently uses secure random session IDs; keep this secret configured as a deployment safeguard.
- Variable `META_APP_ID`: the Instagram Login app ID for the Meta app you use.
- Secret `META_APP_SECRET`: the matching secret for that exact Instagram Login app ID.
- Variable `META_REDIRECT_URI`: the exact URL `https://<actual-worker-hostname>/auth/callback`.
- Secret `TOKEN_ENCRYPTION_KEY`: a long random secret used to derive the AES-GCM token encryption key. Back it up securely; changing it means reconnecting accounts whose tokens were encrypted with the old key.
- Variable `CLOUDINARY_CLOUD_NAME`: your Cloudinary cloud name (used in the dashboard upload form).
- Variable `CLOUDINARY_UPLOAD_PRESET`: optional preset label for reference; the dashboard currently accepts the cloud name and unsigned preset in the upload panel.

Do not commit secrets to GitHub.

## 5. Set up Cloudinary uploads

1. Cloudinary Console → Settings → Upload → Upload presets.
2. Create an **unsigned** preset and configure allowed formats and upload limits appropriately.
3. In ReelPilot's upload panel, enter the Cloudinary cloud name and the unsigned preset name.
4. Test with a small video first. Unsigned uploads mean the preset should be scoped carefully; never expose your Cloudinary API secret.

## 6. Configure your existing Meta developer app

Do this only after the new Worker URL is stable:

1. Open Meta for Developers and choose the existing app.
2. Under Instagram → API setup with Instagram Login / Business Login, configure the callback URL exactly as `https://<actual-worker-hostname>/auth/callback`.
3. Under App Settings → Basic, set App Domains to the hostname only, without protocol or path.
4. Ensure `META_APP_ID` and `META_APP_SECRET` belong to the same Instagram Login app configuration. Do not mix an Instagram-specific ID with a different app's secret.
5. Request/configure the minimum permissions required, including `instagram_business_basic` and `instagram_business_content_publish`. Follow Meta's current tester, role, and app-review requirements.
6. Keep valid privacy policy and data-deletion URLs on publicly reachable pages.

## 7. First test

1. Open the Worker URL and sign in with `ADMIN_PASSWORD`.
2. Click Connect Instagram and complete authorization.
3. Confirm the account appears in the account list.
4. Turn on just that one account.
5. Upload one short MP4 via Cloudinary, create a one-video batch, and queue it.
6. Check publishing jobs and Cloudflare Worker logs. Only after this works should you test larger batches.

## Troubleshooting

- Build failure: open the failed deployment → Build logs; fix the first error, not the last cascading error.
- `Missing Worker secrets/variables`: add the exact missing names in Worker settings.
- OAuth redirect mismatch: the callback in Meta and `META_REDIRECT_URI` must match character-for-character.
- `Invalid platform app`: check the Instagram Login product setup, matching App ID/secret, allowed callback URL, app roles/tester status, and current Meta requirements.
- D1 table errors: apply `migrations/0001_init.sql` to the D1 database bound as `DB`.
- Source Reel has no video URL: Instagram did not provide a downloadable media URL; upload an authorized original file instead.
- Publishing failures: inspect the exact Meta error in the job and Worker logs. Token permissions, account eligibility, video URL accessibility, format, duration, rate limits, and Meta review state can all matter.
