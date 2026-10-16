# ReelPilot Fresh

A Cloudflare Worker + D1 starter dashboard for Instagram professional accounts, authorized source-media lookup, manual MP4/MOV uploads through Cloudinary unsigned presets, batch captions, destination-account toggles, and queued Reel publishing.

## Important limitations

- Instagram API access is permission-based. It does not provide unrestricted downloading of every Reel from any account. Source media may be returned without a downloadable `media_url`; upload media you have permission to use when this happens.
- Test with one Reel and one account first. Do not queue a large batch until a single publish succeeds.
- The Worker cron processes up to three jobs per tick. This is intentionally conservative; free-tier quotas, Meta rate limits, video size, and container processing time can constrain large batches.
- Cloudinary unsigned uploads require an unsigned upload preset. Never put a Cloudinary API secret in frontend code.
- Instagram publishing requirements and supported scopes can change. Confirm your Meta app's current API setup and access level before live use.

## File structure

```text
reelpilot-fresh/
├── src/index.js             # Worker routes, OAuth callback, dashboard, queue worker
├── migrations/0001_init.sql # D1 schema
├── docs/DEPLOYMENT.md       # Beginner deployment steps
├── package.json
├── wrangler.toml
└── .gitignore
```

## Local syntax check

Requires Node.js only for developers who choose to run checks locally:

```sh
npm install
npm run check
```

You can deploy from GitHub/Cloudflare without installing Node.js on your personal computer, but the connected build environment must install the declared Wrangler dependency.

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
