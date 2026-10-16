const COOKIE = "rp_session";
const SESSION_SECONDS = 60 * 60 * 24 * 7;
const OAUTH_SECONDS = 10 * 60;

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });
      if (url.pathname === "/health") return json({ ok: true, app: "ReelPilot", time: new Date().toISOString() });
      if (url.pathname.startsWith("/api/")) return await handleApi(request, env, ctx, url);
      if (url.pathname === "/auth/callback") return await oauthCallback(request, env, url);
      if (url.pathname === "/logout" && request.method === "POST") return await logout(request, env);
      return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    } catch (err) {
      console.error("Unhandled request error", err);
      return json({ error: "Internal server error. Check Worker logs for details." }, 500);
    }
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(processDueJobs(env));
  }
};

async function handleApi(request, env, ctx, url) {
  if (url.pathname === "/api/login" && request.method === "POST") return login(request, env);
  if (url.pathname === "/api/logout" && request.method === "POST") return logout(request, env);
  const session = await getSession(request, env);
  if (!session) return json({ error: "Please sign in again." }, 401);
  const userId = session.user_id;

  if (url.pathname === "/api/me" && request.method === "GET") return json({ ok: true });
  if (url.pathname === "/api/auth/url" && request.method === "GET") return oauthUrl(env, session);
  if (url.pathname === "/api/accounts" && request.method === "GET") {
    const result = await env.DB.prepare("SELECT id, username, ig_user_id, selected, token_expires_at FROM accounts WHERE user_id=? ORDER BY created_at DESC").bind(userId).all();
    return json({ accounts: result.results || [] });
  }
  const toggleMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/toggle$/);
  if (toggleMatch && request.method === "POST") {
    const body = await readJson(request);
    await env.DB.prepare("UPDATE accounts SET selected=?, updated_at=? WHERE id=? AND user_id=?").bind(body.selected ? 1 : 0, now(), toggleMatch[1], userId).run();
    return json({ ok: true });
  }
  if (url.pathname === "/api/source/reels" && request.method === "GET") return sourceReels(env, userId, url.searchParams.get("accountId"));
  if (url.pathname === "/api/batches" && request.method === "GET") {
    const result = await env.DB.prepare("SELECT b.*, (SELECT COUNT(*) FROM videos v WHERE v.batch_id=b.id) AS video_count FROM batches b WHERE user_id=? ORDER BY updated_at DESC LIMIT 100").bind(userId).all();
    return json({ batches: result.results || [] });
  }
  if (url.pathname === "/api/batches" && request.method === "POST") return createBatch(request, env, userId);
  const batchMatch = url.pathname.match(/^\/api\/batches\/([^/]+)$/);
  if (batchMatch && request.method === "GET") return getBatch(env, userId, batchMatch[1]);
  const videoMatch = url.pathname.match(/^\/api\/videos\/([^/]+)$/);
  if (videoMatch && request.method === "PATCH") return updateVideo(request, env, userId, videoMatch[1]);
  if (url.pathname === "/api/publish" && request.method === "POST") return queueBatch(request, env, userId);
  if (url.pathname === "/api/jobs" && request.method === "GET") {
    const result = await env.DB.prepare("SELECT j.id,j.status,j.attempts,j.last_error,j.created_at,a.username,v.caption,b.title FROM jobs j JOIN accounts a ON a.id=j.account_id JOIN videos v ON v.id=j.video_id JOIN batches b ON b.id=j.batch_id WHERE j.user_id=? ORDER BY j.created_at DESC LIMIT 300").bind(userId).all();
    return json({ jobs: result.results || [] });
  }
  if (url.pathname === "/api/cloudinary/signature" && request.method === "POST") return json({ error: "Use Cloudinary unsigned uploads from the browser with your configured unsigned preset. Do not expose your Cloudinary API secret." }, 400);
  return json({ error: "Not found" }, 404);
}

async function login(request, env) {
  if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET) return json({ error: "Configure ADMIN_PASSWORD and SESSION_SECRET in Worker secrets first." }, 503);
  const body = await readJson(request);
  if (typeof body.password !== "string" || !constantTimeEqual(body.password, env.ADMIN_PASSWORD)) return json({ error: "Incorrect password." }, 401);
  const userId = "owner";
  const passwordHash = await sha256(env.ADMIN_PASSWORD);
  await env.DB.prepare("INSERT INTO users(id,password_hash,created_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET password_hash=excluded.password_hash").bind(userId, passwordHash, now()).run();
  const sessionId = randomId();
  await env.DB.prepare("INSERT INTO sessions(id,user_id,expires_at,created_at) VALUES(?,?,?,?)").bind(sessionId, userId, now() + SESSION_SECONDS, now()).run();
  return json({ ok: true }, 200, { "set-cookie": cookie(sessionId, SESSION_SECONDS) });
}
async function logout(request, env) {
  const sessionId = parseCookie(request.headers.get("cookie"), COOKIE);
  if (sessionId) await env.DB.prepare("DELETE FROM sessions WHERE id=?").bind(sessionId).run();
  return json({ ok: true }, 200, { "set-cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
}
async function getSession(request, env) {
  const id = parseCookie(request.headers.get("cookie"), COOKIE);
  if (!id) return null;
  const row = await env.DB.prepare("SELECT id,user_id,expires_at FROM sessions WHERE id=? AND expires_at>?").bind(id, now()).first();
  return row || null;
}
async function oauthUrl(env, session) {
  const missing = ["META_APP_ID", "META_APP_SECRET", "META_REDIRECT_URI", "TOKEN_ENCRYPTION_KEY"].filter(k => !env[k]);
  if (missing.length) return json({ error: `Missing Worker secrets/variables: ${missing.join(", ")}` }, 503);
  const state = randomId();
  await env.DB.prepare("INSERT INTO oauth_states(state,session_id,expires_at,created_at) VALUES(?,?,?,?)").bind(state, session.id, now() + OAUTH_SECONDS, now()).run();
  const params = new URLSearchParams({ client_id: env.META_APP_ID, redirect_uri: env.META_REDIRECT_URI, response_type: "code", scope: "instagram_business_basic,instagram_business_content_publish", state, force_reauth: "true" });
  return json({ url: `https://www.instagram.com/oauth/authorize?${params.toString()}` });
}
async function oauthCallback(request, env, url) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error_description") || url.searchParams.get("error");
  if (oauthError) return htmlPage("Instagram connection failed", escapeHtml(oauthError));
  if (!code || !state) return htmlPage("Instagram connection failed", "Missing OAuth code or state. Restart Connect Instagram from the signed-in dashboard.");
  const stateRow = await env.DB.prepare("SELECT state,session_id,expires_at FROM oauth_states WHERE state=? AND expires_at>?").bind(state, now()).first();
  await env.DB.prepare("DELETE FROM oauth_states WHERE state=?").bind(state).run();
  if (!stateRow) return htmlPage("Instagram connection failed", "This login request expired or was already used. Return to ReelPilot and try again.");
  const session = await env.DB.prepare("SELECT id,user_id FROM sessions WHERE id=? AND expires_at>?").bind(stateRow.session_id, now()).first();
  if (!session) return htmlPage("Instagram connection failed", "Your ReelPilot session expired. Sign in again and reconnect.");
  try {
    const tokenResponse = await fetch(`https://api.instagram.com/oauth/access_token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: env.META_APP_ID, client_secret: env.META_APP_SECRET, grant_type: "authorization_code", redirect_uri: env.META_REDIRECT_URI, code }) });
    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok || !tokenData.access_token) throw new Error(tokenData.error_message || tokenData.error?.message || `Token exchange failed (${tokenResponse.status})`);
    const accessToken = tokenData.access_token;
    const profileResponse = await fetch(`https://graph.instagram.com/${env.GRAPH_API_VERSION || "v24.0"}/me?fields=user_id,username&access_token=${encodeURIComponent(accessToken)}`);
    const profile = await profileResponse.json();
    if (!profileResponse.ok || !profile.user_id) throw new Error(profile.error?.message || "Could not read Instagram profile.");
    const encrypted = await encryptToken(accessToken, env.TOKEN_ENCRYPTION_KEY);
    const id = randomId();
    await env.DB.prepare("INSERT INTO accounts(id,user_id,ig_user_id,username,access_token_enc,token_expires_at,selected,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,ig_user_id) DO UPDATE SET username=excluded.username,access_token_enc=excluded.access_token_enc,token_expires_at=excluded.token_expires_at,updated_at=excluded.updated_at").bind(id, session.user_id, String(profile.user_id), profile.username || `instagram_${profile.user_id}`, encrypted, now() + Number(tokenData.expires_in || 5184000), 0, now(), now()).run();
    return htmlPage("Instagram connected", `Connected @${escapeHtml(profile.username || "Instagram account")}. You can close this tab and return to ReelPilot.`, true);
  } catch (err) {
    console.error("OAuth callback error", err);
    return htmlPage("Instagram connection failed", escapeHtml(err.message || "Token exchange failed. Check Worker logs and Meta settings."));
  }
}
async function sourceReels(env, userId, accountId) {
  if (!accountId) return json({ error: "Choose a connected source account." }, 400);
  const account = await env.DB.prepare("SELECT * FROM accounts WHERE id=? AND user_id=?").bind(accountId, userId).first();
  if (!account) return json({ error: "Source account not found." }, 404);
  try {
    const token = await decryptToken(account.access_token_enc, env.TOKEN_ENCRYPTION_KEY);
    const apiVersion = env.GRAPH_API_VERSION || "v24.0";
    const res = await fetch(`https://graph.instagram.com/${apiVersion}/me/media?fields=id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp&limit=100&access_token=${encodeURIComponent(token)}`);
    const data = await res.json();
    if (!res.ok) return json({ error: data.error?.message || "Instagram could not return media for this account." }, 502);
    const reels = (data.data || []).filter(x => x.media_product_type === "REELS" || x.media_type === "VIDEO").map(x => ({ id: x.id, caption: x.caption || "", media_type: x.media_type, media_url: x.media_url || null, thumbnail_url: x.thumbnail_url || null, permalink: x.permalink || null, timestamp: x.timestamp || null }));
    return json({ reels, note: "Instagram may omit video URLs or restrict media visibility. Import only media you have permission to reuse." });
  } catch (err) { return json({ error: err.message || "Could not read source media." }, 502); }
}
async function createBatch(request, env, userId) {
  const body = await readJson(request);
  const items = Array.isArray(body.videos) ? body.videos : [];
  const max = Math.min(300, Number(env.MAX_BATCH_SIZE || 300));
  if (!items.length || items.length > max) return json({ error: `A batch must contain 1–${max} videos.` }, 400);
  if (items.some(v => !isHttpsUrl(v.videoUrl))) return json({ error: "Every video needs a valid HTTPS media URL (for example, a Cloudinary secure_url)." }, 400);
  const batchId = randomId(); const timestamp = now(); const title = String(body.title || `Batch ${new Date().toLocaleDateString("en-CA")}`).slice(0, 120);
  await env.DB.prepare("INSERT INTO batches(id,user_id,title,cover_url,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").bind(batchId, userId, title, isHttpsUrl(body.coverUrl) ? body.coverUrl : null, "draft", timestamp, timestamp).run();
  const stmt = env.DB.prepare("INSERT INTO videos(id,batch_id,source_media_id,video_url,caption,cover_url,position,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)");
  for (let i = 0; i < items.length; i++) {
    const v = items[i];
    await stmt.bind(randomId(), batchId, v.sourceMediaId ? String(v.sourceMediaId).slice(0, 200) : null, v.videoUrl, String(v.caption || "").slice(0, 2200), isHttpsUrl(v.coverUrl) ? v.coverUrl : (isHttpsUrl(body.coverUrl) ? body.coverUrl : null), i, "draft", timestamp).run();
  }
  return json({ ok: true, batchId, count: items.length }, 201);
}
async function getBatch(env, userId, batchId) {
  const batch = await env.DB.prepare("SELECT * FROM batches WHERE id=? AND user_id=?").bind(batchId, userId).first();
  if (!batch) return json({ error: "Batch not found." }, 404);
  const videos = await env.DB.prepare("SELECT id,source_media_id,video_url,caption,cover_url,position,status FROM videos WHERE batch_id=? ORDER BY position").bind(batchId).all();
  return json({ batch, videos: videos.results || [] });
}
async function updateVideo(request, env, userId, videoId) {
  const body = await readJson(request);
  const video = await env.DB.prepare("SELECT v.id,v.batch_id FROM videos v JOIN batches b ON b.id=v.batch_id WHERE v.id=? AND b.user_id=?").bind(videoId, userId).first();
  if (!video) return json({ error: "Video not found." }, 404);
  if (typeof body.caption === "string") await env.DB.prepare("UPDATE videos SET caption=? WHERE id=?").bind(body.caption.slice(0, 2200), videoId).run();
  if (typeof body.coverUrl === "string" && isHttpsUrl(body.coverUrl)) await env.DB.prepare("UPDATE videos SET cover_url=? WHERE id=?").bind(body.coverUrl, videoId).run();
  return json({ ok: true });
}
async function queueBatch(request, env, userId) {
  const body = await readJson(request);
  const batch = await env.DB.prepare("SELECT * FROM batches WHERE id=? AND user_id=?").bind(body.batchId, userId).first();
  if (!batch) return json({ error: "Batch not found." }, 404);
  const accounts = await env.DB.prepare("SELECT id FROM accounts WHERE user_id=? AND selected=1").bind(userId).all();
  if (!accounts.results?.length) return json({ error: "Turn on at least one destination account first." }, 400);
  const videos = await env.DB.prepare("SELECT id FROM videos WHERE batch_id=? ORDER BY position").bind(batch.id).all();
  if (!videos.results?.length) return json({ error: "This batch has no videos." }, 400);
  const timestamp = now();
  for (const video of videos.results) for (const account of accounts.results) {
    await env.DB.prepare("INSERT INTO jobs(id,user_id,batch_id,video_id,account_id,status,attempts,scheduled_at,created_at,updated_at) VALUES(?,?,?,?,?,'queued',0,?,?,?)").bind(randomId(), userId, batch.id, video.id, account.id, timestamp, timestamp, timestamp).run();
  }
  await env.DB.prepare("UPDATE batches SET status='queued',updated_at=? WHERE id=?").bind(timestamp, batch.id).run();
  return json({ ok: true, queued: videos.results.length * accounts.results.length, videos: videos.results.length, accounts: accounts.results.length });
}
async function processDueJobs(env) {
  // Process a small number per cron tick to respect Worker execution limits.
  const due = await env.DB.prepare("SELECT j.*,v.video_url,v.caption,v.cover_url,a.ig_user_id,a.access_token_enc,a.token_expires_at FROM jobs j JOIN videos v ON v.id=j.video_id JOIN accounts a ON a.id=j.account_id WHERE j.status='queued' AND j.scheduled_at<=? ORDER BY j.created_at LIMIT 3").bind(now()).all();
  for (const job of due.results || []) {
    await env.DB.prepare("UPDATE jobs SET status='processing',attempts=attempts+1,updated_at=? WHERE id=? AND status='queued'").bind(now(), job.id).run();
    try {
      const token = await decryptToken(job.access_token_enc, env.TOKEN_ENCRYPTION_KEY);
      const apiVersion = env.GRAPH_API_VERSION || "v24.0";
      const form = new URLSearchParams({ media_type: "REELS", video_url: job.video_url, caption: job.caption || "", access_token: token });
      if (job.cover_url) form.set("cover_url", job.cover_url);
      const createRes = await fetch(`https://graph.instagram.com/${apiVersion}/${job.ig_user_id}/media`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form });
      const created = await createRes.json();
      if (!createRes.ok || !created.id) throw new Error(created.error?.message || "Instagram media container creation failed.");
      await env.DB.prepare("UPDATE jobs SET ig_creation_id=?,updated_at=? WHERE id=?").bind(created.id, now(), job.id).run();
      let ready = false;
      for (let i = 0; i < 6; i++) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        const statusRes = await fetch(`https://graph.instagram.com/${apiVersion}/${created.id}?fields=status_code&access_token=${encodeURIComponent(token)}`);
        const status = await statusRes.json();
        if (status.status_code === "FINISHED") { ready = true; break; }
        if (status.status_code === "ERROR" || status.status_code === "EXPIRED") throw new Error("Instagram reported the Reel container as failed or expired.");
      }
      if (!ready) throw new Error("Instagram container is still processing. Retry this job later.");
      const publishRes = await fetch(`https://graph.instagram.com/${apiVersion}/${job.ig_user_id}/media_publish`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ creation_id: created.id, access_token: token }) });
      const published = await publishRes.json();
      if (!publishRes.ok || !published.id) throw new Error(published.error?.message || "Instagram publish call failed.");
      await env.DB.prepare("UPDATE jobs SET status='published',ig_media_id=?,last_error=NULL,updated_at=? WHERE id=?").bind(published.id, now(), job.id).run();
    } catch (err) {
      console.error("Publish job failed", job.id, err);
      const retry = Number(job.attempts || 0) < 2;
      await env.DB.prepare("UPDATE jobs SET status=?,last_error=?,scheduled_at=?,updated_at=? WHERE id=?").bind(retry ? "queued" : "failed", String(err.message || err).slice(0, 1000), now() + 120, now(), job.id).run();
    }
  }
}

async function encryptToken(token, secret) {
  const key = await crypto.subtle.importKey("raw", await sha256Bytes(secret), "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(token));
  return `${toB64(iv)}.${toB64(new Uint8Array(cipher))}`;
}
async function decryptToken(value, secret) {
  const [ivPart, cipherPart] = String(value).split(".");
  if (!ivPart || !cipherPart) throw new Error("Stored token is invalid. Reconnect the Instagram account.");
  const key = await crypto.subtle.importKey("raw", await sha256Bytes(secret), "AES-GCM", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(ivPart) }, key, fromB64(cipherPart));
  return new TextDecoder().decode(plain);
}
async function sha256Bytes(value) { return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))); }
async function sha256(value) { const bytes = await sha256Bytes(value); return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join(""); }
function randomId() { return crypto.randomUUID(); }
function now() { return Math.floor(Date.now() / 1000); }
function isHttpsUrl(value) { try { const u = new URL(value); return u.protocol === "https:"; } catch { return false; } }
function parseCookie(header, name) { const item = (header || "").split(";").map(x => x.trim()).find(x => x.startsWith(`${name}=`)); return item ? decodeURIComponent(item.slice(name.length + 1)) : null; }
function cookie(value, maxAge) { return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`; }
function constantTimeEqual(a, b) { if (a.length !== b.length) return false; let out = 0; for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i); return out === 0; }
function toB64(bytes) { let binary = ""; for (const b of bytes) binary += String.fromCharCode(b); return btoa(binary); }
function fromB64(value) { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
async function readJson(request) { try { return await request.json(); } catch { throw new Error("Request body must be valid JSON."); } }
function json(data, status = 200, headers = {}) { return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...corsHeaders(), ...headers } }); }
function corsHeaders() { return { "access-control-allow-origin": "same-origin", "access-control-allow-methods": "GET,POST,PATCH,OPTIONS", "access-control-allow-headers": "content-type" }; }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function htmlPage(title, message, success = false) { return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><style>body{font:16px system-ui;background:#0b0b0f;color:#f5f5f7;display:grid;place-items:center;min-height:90vh;padding:24px}.card{max-width:560px;background:#17171f;border:1px solid #343441;border-radius:18px;padding:28px}a{color:#ff5c70}</style></head><body><main class="card"><h1>${success ? "✓ " : ""}${escapeHtml(title)}</h1><p>${message}</p><p><a href="/">Return to ReelPilot</a></p></main></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }); }

const HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ReelPilot</title><style>
:root{color-scheme:dark;--bg:#0c0c10;--panel:#17171f;--line:#30303b;--muted:#a6a6b4;--accent:#ff5268}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 80% 0,#26121b 0,transparent 35%),var(--bg);color:#f5f5f7;font:15px system-ui,-apple-system,Segoe UI,sans-serif}button,input,textarea,select{font:inherit}button{cursor:pointer;border:1px solid var(--line);border-radius:10px;padding:10px 14px;background:#262631;color:white}button.primary{background:var(--accent);border-color:var(--accent);color:#19070a;font-weight:700}button:disabled{opacity:.45;cursor:not-allowed}input,textarea,select{background:#0e0e14;border:1px solid var(--line);color:white;border-radius:9px;padding:10px;width:100%}textarea{min-height:72px;resize:vertical}.wrap{max-width:1180px;margin:auto;padding:24px}.top{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:24px}.brand{font-size:26px;font-weight:850;letter-spacing:-1px}.brand span{color:var(--accent)}.muted{color:var(--muted)}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.panel{background:rgba(23,23,31,.94);border:1px solid var(--line);border-radius:16px;padding:18px;min-width:0}.panel h2{font-size:17px;margin:0 0 14px}.row{display:flex;gap:10px;align-items:center}.row>*{min-width:0}.stack{display:grid;gap:10px}.account,.video,.job{border:1px solid var(--line);border-radius:12px;padding:12px;margin-top:9px}.account{display:flex;align-items:center;justify-content:space-between;gap:12px}.switch{width:44px;height:25px;accent-color:var(--accent)}.video-head{display:flex;justify-content:space-between;gap:10px;align-items:center}.tag{font-size:12px;border:1px solid var(--line);border-radius:99px;padding:3px 8px;color:var(--muted)}.full{grid-column:1/-1}.hidden{display:none!important}.error{color:#ff8d9a;white-space:pre-wrap}.success{color:#8fe4b1}.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}.small{font-size:12px}.login{max-width:420px;margin:12vh auto}.video-url{font-size:12px;overflow-wrap:anywhere;color:var(--muted)}.notice{border:1px solid #5c3940;background:#24161b;border-radius:10px;padding:12px;color:#ffc5cc;font-size:13px}@media(max-width:760px){.grid{grid-template-columns:1fr}.full{grid-column:auto}.wrap{padding:14px}.top{align-items:flex-start}.brand{font-size:22px}}
</style></head><body><div class="wrap"><div class="top"><div><div class="brand">Reel<span>Pilot</span></div><div class="muted small">Bulk Reels workspace · private dashboard</div></div><button id="logout" class="hidden">Sign out</button></div>
<section id="loginPanel" class="panel login"><h2>Sign in</h2><p class="muted">Use the ADMIN_PASSWORD configured in your Cloudflare Worker secrets.</p><form id="loginForm" class="stack"><input id="password" type="password" placeholder="Dashboard password" required><button class="primary">Sign in</button><div id="loginError" class="error"></div></form></section>
<section id="app" class="hidden"><div id="globalMessage" class="muted" role="status"></div><div class="grid">
<div class="panel"><h2>1 · Instagram accounts</h2><p class="muted small">Connect each destination account. Toggle accounts that should receive the next batch.</p><button class="primary" id="connect">Connect Instagram</button><div id="accounts" class="stack"></div><div id="accountError" class="error"></div></div>
<div class="panel"><h2>2 · Import source Reels</h2><p class="muted small">Source account must be connected and authorized. API access may not expose every Reel or downloadable video URL.</p><select id="sourceAccount"><option value="">Choose source account</option></select><div class="actions"><button id="fetchReels">Fetch available Reels</button></div><div id="sourceReels" class="stack"></div><div id="sourceError" class="error"></div></div>
<div class="panel full"><h2>3 · Create a batch</h2><div class="grid"><div class="stack"><label>Batch title<input id="batchTitle" placeholder="My Reels batch"></label><label>Shared cover image URL (optional)<input id="coverUrl" placeholder="https://..."></label><label>Upload video files (MP4/MOV, up to 300)<input id="videoFiles" type="file" accept="video/mp4,video/quicktime,.mp4,.mov" multiple></label><label>Upload one shared cover (optional)<input id="coverFile" type="file" accept="image/*"></label><div class="notice">Cloudinary unsigned uploads require an unsigned upload preset. Large uploads can take time. Never put your Cloudinary API secret in browser code.</div><div class="row"><input id="cloudName" placeholder="Cloudinary cloud name"><input id="uploadPreset" placeholder="Unsigned upload preset"></div><button id="uploadFiles">Upload selected files to Cloudinary</button><div id="uploadStatus" class="muted small"></div></div><div class="stack"><div class="row"><strong>Videos ready for batch</strong><span class="tag" id="videoCount">0 / 300</span></div><div id="draftVideos" class="stack"></div><button id="createBatch" class="primary">Create batch</button><div id="batchError" class="error"></div></div></div></div>
<div class="panel"><h2>4 · Batches</h2><button id="refreshBatches">Refresh batches</button><div id="batches" class="stack"></div><div id="batchListError" class="error"></div></div>
<div class="panel"><h2>5 · Publishing jobs</h2><button id="refreshJobs">Refresh jobs</button><div id="jobs" class="stack"></div><div class="muted small">Publishing runs in the background on a scheduled Worker trigger. Start with one test Reel and one destination account.</div></div>
</div></section></div>
<script>
const $=id=>document.getElementById(id);let accounts=[],draftVideos=[],batches=[];
async function api(path,options={}){const r=await fetch(path,{credentials:'same-origin',...options,headers:{'content-type':'application/json',...(options.headers||{})}});let d={};try{d=await r.json()}catch{}if(!r.ok)throw new Error(d.error||('Request failed ('+r.status+')'));return d}
function msg(id,text,ok=false){$(id).textContent=text||'';$(id).className=ok?'success':'error'}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function showApp(){ $('loginPanel').classList.add('hidden');$('app').classList.remove('hidden');$('logout').classList.remove('hidden');loadAccounts();loadBatches();loadJobs() }
async function boot(){try{await api('/api/me');showApp()}catch{$('loginPanel').classList.remove('hidden')}}
$('loginForm').addEventListener('submit',async e=>{e.preventDefault();msg('loginError','');try{await api('/api/login',{method:'POST',body:JSON.stringify({password:$('password').value})});$('password').value='';showApp()}catch(e){msg('loginError',e.message)}});
$('logout').onclick=async()=>{try{await api('/api/logout',{method:'POST'})}finally{location.reload()}};
$('connect').onclick=async()=>{try{const d=await api('/api/auth/url');location.href=d.url}catch(e){msg('accountError',e.message)}};
async function loadAccounts(){try{const d=await api('/api/accounts');accounts=d.accounts||[];$('accounts').innerHTML=accounts.length?accounts.map(a=>\`<div class="account"><div><strong>@\${esc(a.username)}</strong><div class="muted small">ID \${esc(a.ig_user_id)}</div></div><label class="row small">Destination <input class="switch" type="checkbox" data-account="\${esc(a.id)}" \${a.selected?'checked':''}></label></div>\`).join(''):'<p class="muted">No accounts connected yet.</p>';$('sourceAccount').innerHTML='<option value="">Choose source account</option>'+accounts.map(a=>\`<option value="\${esc(a.id)}">@\${esc(a.username)}</option>\`).join('');document.querySelectorAll('[data-account]').forEach(el=>el.onchange=async()=>{try{await api('/api/accounts/'+encodeURIComponent(el.dataset.account)+'/toggle',{method:'POST',body:JSON.stringify({selected:el.checked})})}catch(e){el.checked=!el.checked;msg('accountError',e.message)}})}catch(e){msg('accountError',e.message)}}
$('fetchReels').onclick=async()=>{msg('sourceError','');$('sourceReels').innerHTML='';try{const d=await api('/api/source/reels?accountId='+encodeURIComponent($('sourceAccount').value));$('sourceReels').innerHTML=(d.reels||[]).map(r=>\`<div class="video"><strong>\${esc(r.media_type||'REEL')}</strong><p>\${esc((r.caption||'').slice(0,240))}</p><div class="video-url">\${esc(r.permalink||'Media URL unavailable')}</div><button data-import="\${esc(r.id)}" data-caption="\${esc(r.caption||'')}" data-url="\${esc(r.media_url||'')}" \${r.media_url?'':'disabled'}>Add to batch</button></div>\`).join('')||'<p class="muted">No importable Reels returned by the API.</p>';document.querySelectorAll('[data-import]').forEach(b=>b.onclick=()=>{addDraft({videoUrl:b.dataset.url,caption:b.dataset.caption,sourceMediaId:b.dataset.import});b.disabled=true})}catch(e){msg('sourceError',e.message)}};
function addDraft(v){if(draftVideos.length>=300)return msg('batchError','Batch limit is 300 videos.');draftVideos.push({...v,coverUrl:'',caption:v.caption||''});renderDraft()}
function renderDraft(){$('videoCount').textContent=draftVideos.length+' / 300';$('draftVideos').innerHTML=draftVideos.map((v,i)=>\`<div class="video"><div class="video-head"><strong>Reel \${i+1}</strong><button data-remove="\${i}">Remove</button></div><div class="video-url">\${esc(v.videoUrl)}</div><label class="small">Caption<textarea data-caption-index="\${i}">\${esc(v.caption)}</textarea></label></div>\`).join('');document.querySelectorAll('[data-remove]').forEach(b=>b.onclick=()=>{draftVideos.splice(Number(b.dataset.remove),1);renderDraft()});document.querySelectorAll('[data-caption-index]').forEach(t=>t.onchange=()=>{draftVideos[Number(t.dataset.captionIndex)].caption=t.value})}
async function cloudinaryUpload(file,cloud,preset,resourceType){const endpoint=\`https://api.cloudinary.com/v1_1/\${encodeURIComponent(cloud)}/\${resourceType}/upload\`;const form=new FormData();form.append('file',file);form.append('upload_preset',preset);const res=await fetch(endpoint,{method:'POST',body:form});const d=await res.json();if(!res.ok||!d.secure_url)throw new Error(d.error?.message||'Cloudinary upload failed');return d.secure_url}
$('uploadFiles').onclick=async()=>{const files=Array.from($('videoFiles').files||[]);const cover=$('coverFile').files[0];const cloud=$('cloudName').value.trim(),preset=$('uploadPreset').value.trim();if(!cloud||!preset)return msg('uploadStatus','Enter Cloudinary cloud name and unsigned upload preset.');if(draftVideos.length+files.length>300)return msg('uploadStatus','This would exceed 300 videos.');try{if(cover){$('uploadStatus').textContent='Uploading shared cover…';$('coverUrl').value=await cloudinaryUpload(cover,cloud,preset,'image')}for(let i=0;i<files.length;i++){const file=files[i];if(!/\.(mp4|mov)$/i.test(file.name))throw new Error(file.name+' is not MP4 or MOV');$('uploadStatus').textContent=\`Uploading \${i+1}/\${files.length}: \${file.name}\`;const videoUrl=await cloudinaryUpload(file,cloud,preset,'video');addDraft({videoUrl,caption:'',coverUrl:$('coverUrl').value.trim()})}$('uploadStatus').textContent='Upload complete. Create the batch when ready.'}catch(e){msg('uploadStatus',e.message)}};
$('createBatch').onclick=async()=>{msg('batchError','');if(!draftVideos.length)return msg('batchError','Add at least one video first.');try{const d=await api('/api/batches',{method:'POST',body:JSON.stringify({title:$('batchTitle').value,coverUrl:$('coverUrl').value.trim(),videos:draftVideos})});msg('batchError',\`Created batch \${d.batchId} with \${d.count} videos.\`,true);draftVideos=[];renderDraft();loadBatches()}catch(e){msg('batchError',e.message)}};
async function loadBatches(){try{const d=await api('/api/batches');batches=d.batches||[];$('batches').innerHTML=batches.map(b=>\`<div class="job"><strong>\${esc(b.title)}</strong><div class="muted small">\${b.video_count} videos · \${esc(b.status)}</div><div class="actions"><button data-open-batch="\${esc(b.id)}">View</button><button class="primary" data-publish="\${esc(b.id)}">Queue for selected accounts</button></div><div id="batch-\${esc(b.id)}"></div></div>\`).join('')||'<p class="muted">No batches yet.</p>';document.querySelectorAll('[data-open-batch]').forEach(b=>b.onclick=()=>viewBatch(b.dataset.openBatch));document.querySelectorAll('[data-publish]').forEach(b=>b.onclick=async()=>{if(!confirm('Queue every video in this batch for all toggled-on destination accounts?'))return;try{const d=await api('/api/publish',{method:'POST',body:JSON.stringify({batchId:b.dataset.publish})});alert(\`Queued \${d.queued} publishing jobs.\`);loadJobs();loadBatches()}catch(e){alert(e.message)}})}catch(e){msg('batchListError',e.message)}}
async function viewBatch(id){try{const d=await api('/api/batches/'+encodeURIComponent(id));$('batch-'+id).innerHTML=(d.videos||[]).map((v,i)=>\`<div class="video"><strong>Reel \${i+1}</strong><textarea data-edit-caption="\${esc(v.id)}">\${esc(v.caption)}</textarea><button data-save-caption="\${esc(v.id)}">Save caption</button></div>\`).join('');document.querySelectorAll('[data-save-caption]').forEach(b=>b.onclick=async()=>{const id=b.dataset.saveCaption;const t=document.querySelector('[data-edit-caption="'+CSS.escape(id)+'"]');try{await api('/api/videos/'+encodeURIComponent(id),{method:'PATCH',body:JSON.stringify({caption:t.value})});b.textContent='Saved'}catch(e){alert(e.message)}})}catch(e){alert(e.message)}}
async function loadJobs(){try{const d=await api('/api/jobs');$('jobs').innerHTML=(d.jobs||[]).map(j=>\`<div class="job"><div class="video-head"><strong>@\${esc(j.username)} · \${esc(j.status)}</strong><span class="tag">\${esc(j.attempts)} tries</span></div><div class="muted small">\${esc(j.title)} · \${esc(j.caption||'No caption')}</div>\${j.last_error?\`<div class="error small">\${esc(j.last_error)}</div>\`:''}</div>\`).join('')||'<p class="muted">No publishing jobs yet.</p>'}catch(e){msg('globalMessage',e.message)}}
$('refreshBatches').onclick=loadBatches;$('refreshJobs').onclick=loadJobs;boot();
</script></body></html>`;
