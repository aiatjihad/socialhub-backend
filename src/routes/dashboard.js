const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const { getDb } = require('../services/dbService');

router.get('/', authMiddleware, (req, res) => {
  const db = getDb();
  const accounts = db.get('accounts').value();
  const posts = db.get('posts').value();
  const scheduled = db.get('scheduled_posts').value();
  const uploads = db.get('uploads').value();

  const now = new Date();
  const last7Days = new Date(now - 7 * 24 * 60 * 60 * 1000);

  const recentPosts = posts.filter(p => new Date(p.createdAt) > last7Days);
  const upcomingScheduled = scheduled
    .filter(s => s.status === 'pending' && new Date(s.scheduledAt) > now)
    .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt))
    .slice(0, 5);

  const recentActivity = posts
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 10);

  const platformStats = {
    youtube: accounts.filter(a => a.type === 'youtube').length,
    instagram: accounts.filter(a => a.type === 'instagram').length,
    tiktok: accounts.filter(a => a.type === 'tiktok').length,
  };

  const postStats = {
    total: posts.length,
    published: posts.filter(p => p.status === 'published').length,
    partial: posts.filter(p => p.status === 'partial').length,
    failed: posts.filter(p => p.status === 'failed').length,
    lastWeek: recentPosts.length
  };

  res.json({
    totalAccounts: accounts.length,
    platformStats,
    postStats,
    totalUploads: uploads.length,
    totalScheduled: scheduled.filter(s => s.status === 'pending').length,
    upcomingScheduled,
    recentActivity
  });
});

module.exports = router;
