require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

// Upload directory
const uploadDir = path.resolve(process.env.UPLOAD_DIR || './uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// DB (optional, legacy routes)
try {
  const dbService = require('./services/dbService');
  dbService.init();
} catch (e) {
  console.warn('DB init skipped:', e.message);
}

// Middleware
const allowedOrigins = [
  'https://aiatjihad.github.io',
  'http://localhost:3000',
  'http://localhost:5000',
  process.env.FRONTEND_URL
].filter(Boolean);

app.use(require('cors')({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true
}));
app.use(express.json({ limit: '60mb' }));
app.use(express.urlencoded({ extended: true, limit: '60mb' }));

// Static public media (Instagram/TikTok need a publicly reachable URL)
app.use('/uploads', express.static(uploadDir, { maxAge: '7d' }));

// Health
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    time: new Date().toISOString(),
    instagram: !!(process.env.INSTAGRAM_APP_ID && process.env.INSTAGRAM_APP_SECRET),
    tiktok: !!(process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET)
  });
});

// Social OAuth + publishing (stateless, no DB needed)
app.use('/api/social', require('./routes/social'));

// Legacy routes (kept so existing UI still works if backend is used directly)
for (const r of ['auth', 'accounts', 'posts', 'schedule', 'upload', 'dashboard']) {
  try {
    app.use(`/api/${r}`, require(`./routes/${r}`));
  } catch (e) {
    console.warn(`Route ${r} skipped:`, e.message);
  }
}

app.use((err, req, res, next) => {
  console.error(err.message);
  res.status(500).json({ error: err.message || 'Server error' });
});

app.listen(PORT, () => {
  console.log(`SocialHub backend ready on port ${PORT} (${PUBLIC_BASE_URL})`);
});
