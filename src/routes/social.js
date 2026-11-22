const express = require('express');
const router = express.Router();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const IG_VERSION = 'https://graph.instagram.com/v21.0';
const uploadDir = path.resolve(process.env.UPLOAD_DIR || './uploads');
// Always derive from the incoming request so Render's assigned hostname works
// without having to configure PUBLIC_BASE_URL by hand.
const publicBase = req => `${req.protocol}://${req.get('host')}`.replace(/\/$/, '');
const callbackUrl = req => `${publicBase(req)}/api/social/instagram/callback`;
const tiktokCallbackUrl = req => `${publicBase(req)}/api/social/tiktok/callback`;

function need(res, names) {
  const missing = names.filter(n => !process.env[n]);
  if (missing.length) {
    res.status(500).json({ error: 'Backend missing config', missing });
    return false;
  }
  return true;
}

/* ---------- Media hosting: frontend sends base64, we return a public URL ---------- */
router.post('/media', async (req, res) => {
  try {
    const { data, mime = 'image/jpeg', ext } = req.body;
    if (!data) return res.status(400).json({ error: 'Missing base64 data' });
    const clean = data.replace(/^data:[^;]+;base64,/, '');
    const buf = Buffer.from(clean, 'base64');
    if (!buf.length || buf.length > 50 * 1024 * 1024) {
      return res.status(400).json({ error: 'Empty or too-large file (max 50MB)' });
    }
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    const map = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'video/mp4': '.mp4', 'video/quicktime': '.mov' };
    const suffix = ext || map[mime] || '.bin';
    const name = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${suffix}`;
    fs.writeFileSync(path.join(uploadDir, name), buf);
    res.json({ url: `${publicBase(req)}/uploads/${name}`, size: buf.length, mime });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------- Instagram ---------- */

// Meta's "API setup with Instagram login" dashboard gives a short-lived token.
// Exchange it for a 60-day token at runtime using the app secret — no redirect URI needed.
let cachedIgToken = null;
async function resolvedIgToken() {
  if (process.env.INSTAGRAM_ACCESS_TOKEN) return process.env.INSTAGRAM_ACCESS_TOKEN;
  if (cachedIgToken) return cachedIgToken;
  if (!process.env.INSTAGRAM_SHORT_TOKEN || !process.env.INSTAGRAM_APP_SECRET) return null;
  const r = await axios.get('https://graph.instagram.com/access_token', {
    params: {
      grant_type: 'ig_exchange_token',
      client_secret: String(process.env.INSTAGRAM_APP_SECRET || '').trim(),
      access_token: String(process.env.INSTAGRAM_SHORT_TOKEN || '').trim()
    }
  });
  cachedIgToken = r.data.access_token;
  return cachedIgToken;
}

router.post('/instagram/bootstrap', async (req, res) => {
  try {
    const token = await resolvedIgToken();
    if (!token) return res.status(500).json({ error: 'Set INSTAGRAM_SHORT_TOKEN (or INSTAGRAM_ACCESS_TOKEN) on the backend' });
    const me = await axios.get(`${IG_VERSION}/me`, {
      params: { fields: 'id,username,account_type', access_token: token }
    });
    res.json({ connected: true, userId: me.data.id, username: me.data.username, accountType: me.data.account_type });
  } catch (e) {
    res.status(400).json({ error: e.response?.data?.error?.message || e.message });
  }
});

// Step 1 URL for the user to open (Instagram / Facebook "Unified Login").
// The redirect URI must be one registered in the Meta app dashboard.
router.get('/instagram/auth-url', (req, res) => {
  if (!need(res, ['INSTAGRAM_APP_ID'])) return;
  const state = crypto.randomBytes(12).toString('hex');
  const redirectUri = req.query.redirect_uri
    || (process.env.FRONTEND_URL || `${publicBase(req)}/`).replace(/\/$/, '') + '/';
  const url = new URL('https://www.facebook.com/dialog/oauth');
  url.searchParams.set('client_id', process.env.INSTAGRAM_APP_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', 'instagram_basic,instagram_content_publish');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  res.json({ url: url.toString(), state, redirectUri });
});

// OAuth callback page: hands the code to the SocialHub tab
router.get('/instagram/callback', (req, res) => {
  const code = req.query.code;
  const err = req.query.error;
  const front = (process.env.FRONTEND_URL || 'https://aiatjihad.github.io/social-media-manager/').replace(/\/$/, '');
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>Instagram connected</title></head>
<body style="font:16px sans-serif;text-align:center;padding:40px">
<p>${err ? 'Instagram error: ' + err : 'Connecting Instagram…'}</p>
<script>
  var code = ${JSON.stringify(code || '')};
  try { if (window.opener) { window.opener.postMessage({ type: 'socialhub_ig_code', code: code }, '*'); } } catch(e){}
  location.replace(${JSON.stringify(front)} + '#ig_code=' + encodeURIComponent(code));
</script></body></html>`);
});

// Exchange short-lived code -> long-lived token.
// Supports both Meta "Unified Login" (graph.facebook.com) and legacy
// "Instagram Login" (api.instagram.com) token endpoints.
router.post('/instagram/token', async (req, res) => {
  try {
    if (!need(res, ['INSTAGRAM_APP_ID', 'INSTAGRAM_APP_SECRET'])) return;
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Missing code' });
    const redirectUri = req.body.redirect_uri || callbackUrl(req);

    let token = null;
    let shortData = null;
    const errors = [];

    const appId = String(process.env.INSTAGRAM_APP_ID || '').trim();
    const appSecret = String(process.env.INSTAGRAM_APP_SECRET || '').trim();

    // 1) Unified Login (Facebook Login for Business). Try current + legacy
    // Graph versions because older apps are not always enabled on the newest.
    for (const ver of ['v23.0', 'v21.0', '']) {
      if (token) break;
      try {
        const host = `https://graph.facebook.com${ver ? '/' + ver : ''}/oauth/access_token`;
        const r = await axios.get(host, {
          params: { client_id: appId, client_secret: appSecret, code, redirect_uri: redirectUri }
        });
        token = r.data.access_token;
        shortData = r.data;
      } catch (e) {
        errors.push(`unified(${ver || 'default'}): ` + (e.response?.data?.error?.message || e.message));
      }
    }

    // 2) Legacy Instagram Login
    if (!token) {
      try {
        const r = await axios.post(
          'https://api.instagram.com/oauth/access_token',
          new URLSearchParams({
            client_id: appId,
            client_secret: appSecret,
            grant_type: 'authorization_code',
            redirect_uri: redirectUri,
            code
          }),
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );
        token = r.data.access_token;
        shortData = r.data;
      } catch (e) {
        errors.push('instagram: ' + (e.response?.data?.error_message || e.message));
      }
    }

    if (!token) return res.status(400).json({ error: errors.join(' | ') || 'No access_token returned' });

    // Exchange for a 60-day long-lived token
    let longToken = token;
    let expiresIn = shortData.expires_in;
    try {
      const long = await axios.get('https://graph.instagram.com/access_token', {
        params: {
          grant_type: 'ig_exchange_token',
          client_secret: appSecret,
          access_token: token
        }
      });
      longToken = long.data.access_token;
      expiresIn = long.data.expires_in;
    } catch (e) {
      // Keep the short token if the exchange fails (still usable for ~1 hour).
    }

    res.json({
      accessToken: longToken,
      expiresIn,
      userId: shortData.user_id,
      username: shortData.user && shortData.user.username
    });
  } catch (e) {
    res.status(400).json({ error: e.response?.data?.error?.message || e.message });
  }
});

// Refresh a long-lived token (60 days)
router.post('/instagram/refresh', async (req, res) => {
  try {
    if (!need(res, ['INSTAGRAM_APP_SECRET'])) return;
    const { accessToken } = req.body;
    const r = await axios.get('https://graph.instagram.com/refresh_access_token', {
      params: { grant_type: 'ig_refresh_token', access_token: accessToken }
    });
    res.json({ accessToken: r.data.access_token, expiresIn: r.data.expires_in });
  } catch (e) {
    res.status(400).json({ error: e.response?.data?.error_message || e.message });
  }
});

// Unified Login returns a Facebook user id; map it to the linked Instagram
// business account. Instagram Login already returns the IG user id directly.
async function resolveIgUserId(accessToken, hint) {
  if (hint) {
    try {
      const r = await axios.get(`${IG_VERSION}/${hint}`, {
        params: { fields: 'id,username', access_token: accessToken }
      });
      if (r.data?.id) return r.data.id;
    } catch { /* try the Facebook Page link below */ }
  }
  try {
    const r = await axios.get(`${IG_VERSION}/me/accounts`, {
      params: { fields: 'instagram_business_account', access_token: accessToken }
    });
    const found = (r.data?.data || []).map(p => p.instagram_business_account?.id).filter(Boolean);
    if (found.length) return found[0];
  } catch { /* ignore */ }
  const me = await axios.get(`${IG_VERSION}/me`, { params: { fields: 'id', access_token: accessToken } });
  return me.data.id;
}

// Verify token / get profile
router.get('/instagram/me', async (req, res) => {
  try {
    const { accessToken } = req.query;
    const r = await axios.get(`${IG_VERSION}/me`, {
      params: { fields: 'id,username,account_type,media_count', access_token: accessToken }
    });
    res.json(r.data);
  } catch (e) {
    res.status(400).json({ error: e.response?.data?.error?.message || e.message });
  }
});

// Publish image or reel using our public media URL
router.post('/instagram/publish', async (req, res) => {
  try {
    let { accessToken, igUserId, mediaUrl, caption = '', mediaType = 'IMAGE', thumbUrl } = req.body;
    if (!mediaUrl) return res.status(400).json({ error: 'mediaUrl is required' });
    accessToken = accessToken || await resolvedIgToken();
    if (!accessToken) return res.status(500).json({ error: 'Instagram token not configured on backend' });
    igUserId = await resolveIgUserId(accessToken, igUserId);
    const params = {
      media_type: mediaType,
      caption,
      access_token: accessToken
    };
    params[mediaType === 'REELS' ? 'video_url' : 'image_url'] = mediaUrl;
    if (mediaType === 'REELS' && thumbUrl) params.thumb_offset = 0;

    const container = await axios.post(`${IG_VERSION}/${igUserId}/media`, null, { params });
    const containerId = container.data.id;

    let status = 'IN_PROGRESS';
    for (let i = 0; i < 30 && status === 'IN_PROGRESS'; i++) {
      await new Promise(r => setTimeout(r, 4000));
      const s = await axios.get(`${IG_VERSION}/${containerId}`, {
        params: { fields: 'status_code,error_message', access_token: accessToken }
      });
      status = s.data.status_code;
      if (s.data.error_message) {
        return res.status(400).json({ error: s.data.error_message, containerId, status });
      }
    }
    if (status !== 'FINISHED') {
      return res.status(408).json({ error: 'Media processing timed out', status, containerId });
    }

    const published = await axios.post(`${IG_VERSION}/${igUserId}/media_publish`, null, {
      params: { creation_id: containerId, access_token: accessToken }
    });
    res.json({ id: published.data.id, url: `https://www.instagram.com/p/${published.data.id}/` });
  } catch (e) {
    res.status(400).json({ error: e.response?.data?.error?.message || e.message });
  }
});

/* ---------- TikTok ---------- */

router.get('/tiktok/auth-url', (req, res) => {
  if (!need(res, ['TIKTOK_CLIENT_KEY'])) return;
  const state = crypto.randomBytes(12).toString('hex');
  const csrf = crypto.randomBytes(12).toString('hex');
  const url = new URL('https://www.tiktok.com/v2/auth/authorize/');
  url.searchParams.set('client_key', process.env.TIKTOK_CLIENT_KEY);
  url.searchParams.set('scope', 'video.publish,user.info.basic');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', tiktokCallbackUrl(req));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge_method', 'S256');
  // PKCE would go here; kept simple for now
  res.json({ url: url.toString(), state, csrf });
});

router.get('/tiktok/callback', (req, res) => {
  const code = req.query.code;
  const err = req.query.error;
  const front = (process.env.FRONTEND_URL || 'https://aiatjihad.github.io/social-media-manager/').replace(/\/$/, '');
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>TikTok connected</title></head>
<body style="font:16px sans-serif;text-align:center;padding:40px">
<p>${err ? 'TikTok error: ' + err : 'Connecting TikTok…'}</p>
<script>
  var code = ${JSON.stringify(code || '')};
  try { if (window.opener) { window.opener.postMessage({ type: 'socialhub_tt_code', code: code }, '*'); } } catch(e){}
  location.replace(${JSON.stringify(front)} + '#tt_code=' + encodeURIComponent(code));
</script></body></html>`);
});

router.post('/tiktok/token', async (req, res) => {
  try {
    if (!need(res, ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET'])) return;
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Missing code' });
    const r = await axios.post(
      'https://open.tiktokapis.com/v2/oauth/token/',
      new URLSearchParams({
        client_key: process.env.TIKTOK_CLIENT_KEY,
        client_secret: process.env.TIKTOK_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: tiktokCallbackUrl(req)
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    res.json({
      accessToken: r.data.access_token,
      refreshToken: r.data.refresh_token,
      expiresIn: r.data.expires_in,
      openId: r.data.open_id
    });
  } catch (e) {
    res.status(400).json({ error: e.response?.data?.error_description || e.message });
  }
});

// Publish a video. FILE_UPLOAD works without a verified domain; PULL_FROM_URL
// is kept for callers that own a domain verified with TikTok.
router.post('/tiktok/publish', async (req, res) => {
  try {
    const {
      accessToken, videoUrl, videoBase64, mime = 'video/mp4',
      title = '', privacy = 'PUBLIC_TO_EVERYONE'
    } = req.body;
    if (!accessToken) return res.status(400).json({ error: 'accessToken required' });

    let sourceInfo;
    let fileBuffer;
    if (videoBase64) {
      const base64 = String(videoBase64).replace(/^data:[^,]+,/, '');
      fileBuffer = Buffer.from(base64, 'base64');
      if (!fileBuffer.length) return res.status(400).json({ error: 'Empty video file' });
      const chunkSize = 5 * 1024 * 1024;
      sourceInfo = {
        source: 'FILE_UPLOAD',
        video_size: fileBuffer.length,
        chunk_size: chunkSize,
        total_chunk_count: Math.ceil(fileBuffer.length / chunkSize)
      };
    } else if (videoUrl) {
      sourceInfo = { source: 'PULL_FROM_URL', video_url: videoUrl };
    } else {
      return res.status(400).json({ error: 'videoBase64 or videoUrl required' });
    }

    const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
    const init = await axios.post(
      'https://open.tiktokapis.com/v2/post/publish/video/init/',
      {
        post_info: {
          title: title.substring(0, 150),
          privacy_level: privacy,
          disable_duet: false,
          disable_comment: false,
          disable_stitch: false
        },
        source_info: sourceInfo
      },
      { headers }
    );
    const publishId = init.data?.data?.publish_id;
    const uploadUrl = init.data?.data?.upload_url;

    if (fileBuffer && uploadUrl) {
      const chunkSize = sourceInfo.chunk_size;
      for (let i = 0; i < sourceInfo.total_chunk_count; i++) {
        const start = i * chunkSize;
        const end = Math.min(start + chunkSize, fileBuffer.length) - 1;
        await axios.put(uploadUrl, fileBuffer.subarray(start, end + 1), {
          headers: {
            'Content-Type': mime,
            'Content-Range': `bytes ${start}-${end}/${fileBuffer.length}`
          },
          maxBodyLength: Infinity,
          maxContentLength: Infinity
        });
      }
    }

    res.json({ publishId, status: init.data?.data?.status, uploadUrl: uploadUrl ? true : false });
  } catch (e) {
    res.status(400).json({ error: e.response?.data?.error?.message || e.message });
  }
});

module.exports = router;
