const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getDb } = require('../services/dbService');

// Login
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  const db = getDb();
  const user = db.get('users').find({ username }).value();
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const valid = bcrypt.compareSync(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign(
    { id: user.id, username: user.username },
    process.env.JWT_SECRET || 'secret',
    { expiresIn: '7d' }
  );
  res.json({ token, user: { id: user.id, username: user.username, email: user.email } });
});

// Register
router.post('/register', (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'All fields required' });
  }
  const db = getDb();
  const existing = db.get('users').find({ username }).value();
  if (existing) return res.status(400).json({ error: 'Username already exists' });

  const hashed = bcrypt.hashSync(password, 10);
  const { v4: uuidv4 } = require('uuid');
  const newUser = { id: uuidv4(), username, email, password: hashed, createdAt: new Date().toISOString() };
  db.get('users').push(newUser).write();
  res.json({ message: 'User created successfully' });
});

// YouTube OAuth URL
router.get('/youtube/connect', (req, res) => {
  const { google } = require('googleapis');
  const oauth2Client = new google.auth.OAuth2(
    process.env.YOUTUBE_CLIENT_ID,
    process.env.YOUTUBE_CLIENT_SECRET,
    process.env.YOUTUBE_REDIRECT_URI
  );
  const scopes = [
    'https://www.googleapis.com/auth/youtube.upload',
    'https://www.googleapis.com/auth/youtube.readonly',
    'https://www.googleapis.com/auth/userinfo.profile'
  ];
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    state: req.query.accountName || 'youtube_account'
  });
  res.json({ url });
});

// YouTube OAuth callback
router.get('/youtube/callback', async (req, res) => {
  const { code, state } = req.query;
  try {
    const { google } = require('googleapis');
    const { v4: uuidv4 } = require('uuid');
    const oauth2Client = new google.auth.OAuth2(
      process.env.YOUTUBE_CLIENT_ID,
      process.env.YOUTUBE_CLIENT_SECRET,
      process.env.YOUTUBE_REDIRECT_URI
    );
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data: profile } = await oauth2.userinfo.get();

    const db = getDb();
    const existing = db.get('accounts').find({ type: 'youtube', googleId: profile.id }).value();

    if (existing) {
      db.get('accounts').find({ id: existing.id }).assign({
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || existing.refreshToken,
        updatedAt: new Date().toISOString()
      }).write();
    } else {
      db.get('accounts').push({
        id: uuidv4(),
        type: 'youtube',
        name: state || profile.name,
        channelName: profile.name,
        email: profile.email,
        avatar: profile.picture,
        googleId: profile.id,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        connected: true,
        createdAt: new Date().toISOString()
      }).write();
    }
    res.redirect('http://localhost:3000/accounts?connected=youtube');
  } catch (err) {
    console.error('YouTube OAuth error:', err);
    res.redirect('http://localhost:3000/accounts?error=youtube_failed');
  }
});

// Instagram OAuth URL
router.get('/instagram/connect', (req, res) => {
  const url = `https://api.instagram.com/oauth/authorize?client_id=${process.env.INSTAGRAM_CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.INSTAGRAM_REDIRECT_URI)}&scope=user_profile,user_media,instagram_basic,instagram_content_publish&response_type=code&state=${req.query.accountName || 'instagram_page'}`;
  res.json({ url });
});

// Instagram OAuth callback
router.get('/instagram/callback', async (req, res) => {
  const { code, state } = req.query;
  try {
    const axios = require('axios');
    const FormData = require('form-data');
    const { v4: uuidv4 } = require('uuid');

    const form = new FormData();
    form.append('client_id', process.env.INSTAGRAM_CLIENT_ID);
    form.append('client_secret', process.env.INSTAGRAM_CLIENT_SECRET);
    form.append('grant_type', 'authorization_code');
    form.append('redirect_uri', process.env.INSTAGRAM_REDIRECT_URI);
    form.append('code', code);

    const tokenRes = await axios.post('https://api.instagram.com/oauth/access_token', form, {
      headers: form.getHeaders()
    });

    const { access_token, user_id } = tokenRes.data;

    // Get long-lived token
    const longRes = await axios.get(`https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${process.env.INSTAGRAM_CLIENT_SECRET}&access_token=${access_token}`);
    const longToken = longRes.data.access_token;

    // Get profile
    const profileRes = await axios.get(`https://graph.instagram.com/me?fields=id,username,account_type,media_count&access_token=${longToken}`);
    const profile = profileRes.data;

    const db = getDb();
    const existing = db.get('accounts').find({ type: 'instagram', instagramId: profile.id }).value();
    if (existing) {
      db.get('accounts').find({ id: existing.id }).assign({
        accessToken: longToken,
        updatedAt: new Date().toISOString()
      }).write();
    } else {
      db.get('accounts').push({
        id: uuidv4(),
        type: 'instagram',
        name: state || profile.username,
        username: profile.username,
        instagramId: profile.id,
        accessToken: longToken,
        connected: true,
        createdAt: new Date().toISOString()
      }).write();
    }
    res.redirect('http://localhost:3000/accounts?connected=instagram');
  } catch (err) {
    console.error('Instagram OAuth error:', err);
    res.redirect('http://localhost:3000/accounts?error=instagram_failed');
  }
});

// TikTok OAuth URL
router.get('/tiktok/connect', (req, res) => {
  const url = `https://www.tiktok.com/v2/auth/authorize/?client_key=${process.env.TIKTOK_CLIENT_KEY}&redirect_uri=${encodeURIComponent(process.env.TIKTOK_REDIRECT_URI)}&response_type=code&scope=user.info.basic,video.upload,video.publish&state=${req.query.accountName || 'tiktok_account'}`;
  res.json({ url });
});

// TikTok OAuth callback
router.get('/tiktok/callback', async (req, res) => {
  const { code, state } = req.query;
  try {
    const axios = require('axios');
    const { v4: uuidv4 } = require('uuid');

    const tokenRes = await axios.post('https://open.tiktokapis.com/v2/oauth/token/', {
      client_key: process.env.TIKTOK_CLIENT_KEY,
      client_secret: process.env.TIKTOK_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: process.env.TIKTOK_REDIRECT_URI,
    });

    const { access_token, open_id } = tokenRes.data.data;

    const profileRes = await axios.post('https://open.tiktokapis.com/v2/user/info/', {
      fields: ['open_id', 'display_name', 'avatar_url']
    }, {
      headers: { Authorization: `Bearer ${access_token}` }
    });

    const profile = profileRes.data.data.user;

    const db = getDb();
    const existing = db.get('accounts').find({ type: 'tiktok', tiktokId: open_id }).value();
    if (existing) {
      db.get('accounts').find({ id: existing.id }).assign({
        accessToken: access_token,
        updatedAt: new Date().toISOString()
      }).write();
    } else {
      db.get('accounts').push({
        id: uuidv4(),
        type: 'tiktok',
        name: state || profile.display_name,
        displayName: profile.display_name,
        avatar: profile.avatar_url,
        tiktokId: open_id,
        accessToken: access_token,
        connected: true,
        createdAt: new Date().toISOString()
      }).write();
    }
    res.redirect('http://localhost:3000/accounts?connected=tiktok');
  } catch (err) {
    console.error('TikTok OAuth error:', err);
    res.redirect('http://localhost:3000/accounts?error=tiktok_failed');
  }
});

// Add account manually (for testing without OAuth)
router.post('/add-manual', (req, res) => {
  const { v4: uuidv4 } = require('uuid');
  const { type, name, username, notes } = req.body;
  if (!type || !name) return res.status(400).json({ error: 'type and name required' });
  const db = getDb();
  const account = {
    id: uuidv4(),
    type,
    name,
    username: username || name,
    connected: true,
    manual: true,
    notes: notes || '',
    createdAt: new Date().toISOString()
  };
  db.get('accounts').push(account).write();
  res.json({ account });
});

module.exports = router;
