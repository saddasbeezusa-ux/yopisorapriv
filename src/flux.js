/**
 * FLUX 3 video via Synthesia (AI Playground), with disposable accounts.
 *
 * Per generation:
 *   1. temp.tf  -> a throwaway Outlook address
 *   2. Cognito SignUp (pool eu-west-1_7hEawdalF) -> emails a 6-digit code
 *   3. read the code from temp.tf -> ConfirmSignUp
 *   4. USER_SRP_AUTH login -> IdToken (JWT, 5-min TTL) + RefreshToken
 *   5. bootstrap: onboarding + workspace + activate freemium (1200 credits)
 *   6. POST stockFootage/bulk (model fal_flux3_video) -> mediaAssetId
 *   7. poll assets/bulkGet until "ready" (refresh the IdToken on 401 — it
 *      expires mid-render), then download the signed S3 mp4.
 *
 * Synthesia's API takes the RAW IdToken in Authorization (no "Bearer " prefix).
 */
import pkg from 'amazon-cognito-identity-js';
import { createWriteStream } from 'node:fs';
import { unlink, stat, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const { CognitoUserPool, CognitoUser, AuthenticationDetails, CognitoUserAttribute, CognitoRefreshToken } = pkg;

// ─── Config (extracted from the production bundle) ───────────────────────────
const USER_POOL_ID = 'eu-west-1_7hEawdalF';
const CLIENT_ID = '1kvg8re5bgu9ljqnnkjosu477k';
const API_BASE = 'https://api.synthesia.io';
const PRD_API_BASE = 'https://api.prd.synthesia.io';
const TEMP_TF = 'https://temp.tf/api';
const STUDIO_VERSION = '2026-07-02t16h51m45s-git_c6412f9e';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

export const FLUX_MODEL = 'fal_flux3_video';
export const FLUX_DURATIONS = [5, 10, 15, 20];
export const FLUX_DEFAULT_DURATION = 10;
export const FLUX_RATIOS = ['16:9', '9:16'];
export const FLUX_DEFAULT_RATIO = '16:9';

export const DEFAULT_POLL_INTERVAL_MS = 8_000;
export const DEFAULT_VIDEO_TIMEOUT_MS = 1_200_000; // 20 min
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_CONSECUTIVE_POLL_FAILURES = 6;
const BLOCK_RE = /moderat|policy|violat|violence|violent|gore|graphic|inappropriate|sensitive|nsfw|explicit|prohibit|safety|blocked|abuse/i;

// ─── Error ───────────────────────────────────────────────────────────────────
export class FluxError extends Error {
  constructor(message, { code, body, blocked, timedOut } = {}) {
    super(message);
    this.name = 'FluxError';
    this.code = code;
    this.body = body;
    this.blocked = Boolean(blocked);
    this.timedOut = Boolean(timedOut);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// In-memory Storage so amazon-cognito-identity-js runs headless (no localStorage).
class MemStorage {
  constructor() { this.d = {}; }
  getItem(k) { return this.d[k] ?? null; }
  setItem(k, v) { this.d[k] = String(v); }
  removeItem(k) { delete this.d[k]; }
  clear() { this.d = {}; }
}

const FIRST_NAMES = ['Alex', 'Jordan', 'Taylor', 'Casey', 'Morgan', 'Riley', 'Sam', 'Jamie', 'Quinn', 'Avery', 'Drew', 'Cameron', 'Parker', 'Rowan', 'Harper'];
const LAST_NAMES = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Wilson', 'Anderson', 'Thomas', 'Moore', 'Martin', 'Lee', 'Walker'];
const pick = (a) => a[randomBytes(1)[0] % a.length];

function generatePassword() {
  const lo = 'abcdefghijkmnopqrstuvwxyz', up = 'ABCDEFGHJKLMNPQRSTUVWXYZ', dg = '23456789', sp = '!@#$%^&*';
  const all = lo + up + dg + sp;
  const chars = [pick(lo), pick(up), pick(dg), pick(sp)];
  while (chars.length < 16) chars.push(all[randomBytes(1)[0] % all.length]);
  // shuffle
  for (let i = chars.length - 1; i > 0; i--) { const j = randomBytes(1)[0] % (i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join('');
}

const cb2p = (fn) => new Promise((res, rej) => fn((err, r) => (err ? rej(err) : res(r))));

async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}

// ─── temp.tf ─────────────────────────────────────────────────────────────────
async function newTempEmail() {
  const r = await fetchWithTimeout(`${TEMP_TF}/account?plus=1&providers=outlook`);
  if (!r.ok) throw new FluxError('Could not allocate a temp email. Please try again.');
  return (await r.json()).email;
}

function extractCode(msg) {
  let b = msg.body || '';
  if ((msg.bodyContentType || 'html').toLowerCase() === 'html') {
    b = b.replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
         .replace(/<[^>]+>/g, ' ')
         .replace(/&[a-z#0-9]+;/gi, ' ');
  }
  const m = b.match(/(?<![\w#])(\d{6})(?![\w])/);
  return m ? m[1] : null;
}

async function waitForCode(email, { timeoutMs = 150_000, intervalMs = 5_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await fetchWithTimeout(`${TEMP_TF}/check`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }),
    });
    if (r.ok) {
      const d = await r.json();
      const msgs = (d.data || []).slice().sort((a) => (/confirm|verif|code/i.test(a.subject || '') ? -1 : 1));
      for (const m of msgs) { const c = extractCode(m); if (c) return c; }
    }
    await sleep(intervalMs);
  }
  return null;
}

// ─── Client ──────────────────────────────────────────────────────────────────
export class FluxClient {
  // Build the Synthesia headers for a session (raw IdToken, no Bearer prefix).
  #headers(session, extra = {}) {
    return {
      Authorization: session.idToken,
      'Content-Type': 'application/json',
      Accept: '*/*',
      Origin: 'https://app.synthesia.io',
      Referer: 'https://app.synthesia.io/',
      'User-Agent': UA,
      'x-studio-version': STUDIO_VERSION,
      ...extra,
    };
  }

  async #refresh(session) {
    const s = await cb2p((cb) => session.user.refreshSession(new CognitoRefreshToken({ RefreshToken: session.refreshToken }), cb));
    session.idToken = s.getIdToken().getJwtToken();
    return session.idToken;
  }

  // Authenticated fetch that refreshes the (5-min) IdToken once on a 401.
  async #authed(session, url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    let resp = await fetchWithTimeout(url, { ...options, headers: this.#headers(session, options.headers) }, timeoutMs);
    if (resp.status === 401) {
      await this.#refresh(session);
      resp = await fetchWithTimeout(url, { ...options, headers: this.#headers(session, options.headers) }, timeoutMs);
    }
    return resp;
  }

  // ─── 1-5: create a disposable account + workspace + freemium credits ────────
  async createSession() {
    const email = await newTempEmail();
    const password = generatePassword();
    const storage = new MemStorage();
    const pool = new CognitoUserPool({ UserPoolId: USER_POOL_ID, ClientId: CLIENT_ID, Storage: storage });

    const attrs = [
      new CognitoUserAttribute({ Name: 'email', Value: email }),
      new CognitoUserAttribute({ Name: 'given_name', Value: pick(FIRST_NAMES) }),
      new CognitoUserAttribute({ Name: 'family_name', Value: pick(LAST_NAMES) }),
    ];
    await cb2p((cb) => pool.signUp(email, password, attrs, null, cb));

    const code = await waitForCode(email);
    if (!code) throw new FluxError('Verification email did not arrive in time. Please try again.');

    const user = new CognitoUser({ Username: email, Pool: pool, Storage: storage });
    await cb2p((cb) => user.confirmRegistration(code, true, cb));

    const authResult = await new Promise((res, rej) => {
      user.authenticateUser(new AuthenticationDetails({ Username: email, Password: password }), { onSuccess: res, onFailure: rej });
    });

    const session = {
      user,
      email,
      idToken: authResult.getIdToken().getJwtToken(),
      refreshToken: authResult.getRefreshToken().getToken(),
      workspaceId: null,
    };
    session.workspaceId = await this.#bootstrap(session);
    return session;
  }

  // Rebuild a session from a stored refresh token (used on restart/resume).
  async sessionFromRefresh({ email, refreshToken, workspaceId }) {
    const storage = new MemStorage();
    const pool = new CognitoUserPool({ UserPoolId: USER_POOL_ID, ClientId: CLIENT_ID, Storage: storage });
    const user = new CognitoUser({ Username: email, Pool: pool, Storage: storage });
    const session = { user, email, idToken: null, refreshToken, workspaceId };
    await this.#refresh(session);
    return session;
  }

  async #bootstrap(session) {
    // Idempotent: reuse an existing workspace if there is one.
    const existing = await this.#authed(session, `${API_BASE}/workspaces`);
    if (existing.ok) {
      const results = (await existing.json())?.results || [];
      if (results[0]?.id) {
        const wid = results[0].id;
        await this.#activateFreemium(session, wid);
        return wid;
      }
    }

    await this.#authed(session, `${API_BASE}/user/onboarding/initialize`, {
      method: 'POST', body: JSON.stringify({ featureFlags: {}, queryParams: {}, allowReinitialize: true }),
    }).catch(() => {});
    await this.#authed(session, `${API_BASE}/user/questionnaire`, { method: 'POST', body: '{}' }).catch(() => {});

    const wsResp = await this.#authed(session, `${API_BASE}/workspaces`, {
      method: 'POST',
      body: JSON.stringify({ name: 'My Workspace', strict: false, includeDemoVideos: false, isAvatarGeneratorMarketingParticipant: false, partner: null }),
    });
    if (!wsResp.ok) {
      const t = await wsResp.text().catch(() => '');
      throw new FluxError('Could not set up the generation account. Please try again.', { code: 'workspace', body: t });
    }
    const wid = (await wsResp.json())?.workspace?.id;
    if (!wid) throw new FluxError('Could not set up the generation account. Please try again.', { code: 'workspace' });

    await this.#authed(session, `${API_BASE}/user/onboarding/initialize`, {
      method: 'POST', body: JSON.stringify({ featureFlags: {}, queryParams: {}, allowReinitialize: true }),
    }).catch(() => {});
    await this.#activateFreemium(session, wid);
    return wid;
  }

  async #activateFreemium(session, wid) {
    await this.#authed(session, `${API_BASE}/billing/self-serve/${wid}/paywall`, {
      method: 'POST', body: JSON.stringify({ redirectUrl: 'https://app.synthesia.io/', targetPlan: 'freemium' }),
    }).catch(() => {});
  }

  // ─── 6: submit generation ──────────────────────────────────────────────────
  async generate(session, { prompt, duration, ratio }) {
    const body = {
      mediaType: 'video',
      modelRequest: { modelName: FLUX_MODEL, aspectRatio: ratio, generateAudio: true, durationInSeconds: duration },
      userPrompt: prompt,
      workspaceId: session.workspaceId,
      tags: ['source_ai_playground'],
    };
    const resp = await this.#authed(session, `${PRD_API_BASE}/avatarServices/api/generatedMedia/stockFootage/bulk?numberOfResults=1`, {
      method: 'POST', body: JSON.stringify(body),
    });
    const txt = await resp.text().catch(() => '');
    if (!resp.ok) {
      console.error(`[flux.generate] HTTP ${resp.status}: ${txt.slice(0, 500)}`);
      // HTTP 422 is a content-policy rejection at submit (e.g. violence, copyright).
      // Never surface the raw provider text — just a clean generic message.
      const blocked = resp.status === 422 || BLOCK_RE.test(txt);
      const msg = blocked
        ? "Couldn't generate your video. Try a different prompt."
        : "Couldn't generate your video. Please try again.";
      throw new FluxError(msg, { code: String(resp.status), body: txt, blocked });
    }
    let data; try { data = JSON.parse(txt); } catch { data = null; }
    const assetId = Array.isArray(data) && data[0]?.mediaAssetId;
    if (!assetId) throw new FluxError('Generation was accepted but returned no asset id. Please try again.', { body: txt });
    return assetId;
  }

  // ─── 7: poll until ready (refresh IdToken on 401) ──────────────────────────
  async waitForAsset(session, assetId, { intervalMs = DEFAULT_POLL_INTERVAL_MS, timeoutMs = DEFAULT_VIDEO_TIMEOUT_MS, onUpdate } = {}) {
    const deadline = Date.now() + timeoutMs;
    const timeoutMinutes = Math.max(1, Math.round(timeoutMs / 60_000));
    let lastStatus = null;
    let fails = 0;

    while (Date.now() < deadline) {
      let resp;
      try {
        resp = await this.#authed(session, `${API_BASE}/assets/bulkGet`, { method: 'POST', body: JSON.stringify({ ids: [assetId] }) });
      } catch (err) {
        fails += 1;
        console.warn(`[flux.waitForAsset] poll request failed (${fails}/${MAX_CONSECUTIVE_POLL_FAILURES}): ${err?.message ?? err}`);
        if (fails >= MAX_CONSECUTIVE_POLL_FAILURES) throw new FluxError('Could not check generation status. Please try again.');
        await sleep(intervalMs); continue;
      }

      if (!resp.ok) {
        const t = await resp.text().catch(() => '');
        if (resp.status >= 500 || resp.status === 429) {
          fails += 1;
          console.warn(`[flux.waitForAsset] transient HTTP ${resp.status} (${fails}/${MAX_CONSECUTIVE_POLL_FAILURES})`);
          if (fails >= MAX_CONSECUTIVE_POLL_FAILURES) throw new FluxError('Could not check generation status. Please try again.', { code: String(resp.status), body: t });
          await sleep(intervalMs); continue;
        }
        console.error(`[flux.waitForAsset] HTTP ${resp.status}: ${t.slice(0, 300)}`);
        throw new FluxError('Could not check generation status. Please try again.', { code: String(resp.status), body: t });
      }

      fails = 0;
      const data = await resp.json();
      const asset = (data?.results || [])[0];
      if (asset) {
        const status = (asset.uploadMetadata || {}).status || 'unknown';
        if (status !== lastStatus) { lastStatus = status; if (onUpdate) onUpdate(status); }
        if (status === 'ready') {
          const url = asset.url || asset.downloadUrl;
          if (!url) throw new FluxError('Generation finished but no download URL was returned.', { body: asset });
          return { videoUrl: url, raw: asset };
        }
        if (status === 'rejected' || status === 'moderation_rejected' || status === 'blocked') {
          throw new FluxError("Couldn't generate your video. Try a different prompt.", { code: status, body: asset, blocked: true });
        }
        if (['failed', 'error', 'errored', 'cancelled', 'canceled'].includes(status)) {
          throw new FluxError("Couldn't generate your video. Please try again.", { code: status, body: asset, blocked: BLOCK_RE.test(JSON.stringify(asset)) });
        }
      }
      await sleep(intervalMs);
    }
    throw new FluxError(`Generation timed out after ${timeoutMinutes} minutes.`, { timedOut: true });
  }

  // ─── 8: download (clean headers, streamed to disk) ─────────────────────────
  async downloadFile(url, { timeoutMs = 180_000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const filePath = path.join(os.tmpdir(), `flux-${randomBytes(8).toString('hex')}.mp4`);
    try {
      // Signed S3 URL — must NOT carry the JWT Authorization header, or AWS 400s.
      const resp = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA } });
      if (!resp.ok) throw new FluxError('Could not download the result file.', { code: String(resp.status) });
      const contentType = resp.headers.get('content-type') || 'video/mp4';
      if (resp.body && typeof Readable.fromWeb === 'function') {
        await pipeline(Readable.fromWeb(resp.body), createWriteStream(filePath));
      } else {
        await writeFile(filePath, Buffer.from(await resp.arrayBuffer()));
      }
      const { size } = await stat(filePath);
      return { path: filePath, bytes: size, contentType };
    } catch (err) {
      await unlink(filePath).catch(() => {});
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function classifyFluxFailure(err) {
  if (err instanceof FluxError) return { blocked: err.blocked, message: err.message };
  return { blocked: false, message: err?.message || 'An unexpected error occurred.' };
}
