const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const { getDb } = require('../services/dbService');

// Get all accounts
router.get('/', authMiddleware, (req, res) => {
  const db = getDb();
  const accounts = db.get('accounts').value().map(a => ({
    ...a,
    accessToken: undefined,
    refreshToken: undefined
  }));
  res.json({ accounts });
});

// Delete account
router.delete('/:id', authMiddleware, (req, res) => {
  const db = getDb();
  const account = db.get('accounts').find({ id: req.params.id }).value();
  if (!account) return res.status(404).json({ error: 'Account not found' });
  db.get('accounts').remove({ id: req.params.id }).write();
  res.json({ message: 'Account removed' });
});

// Update account name
router.put('/:id', authMiddleware, (req, res) => {
  const { name } = req.body;
  const db = getDb();
  db.get('accounts').find({ id: req.params.id }).assign({ name }).write();
  res.json({ message: 'Updated' });
});

// Get account stats
router.get('/stats', authMiddleware, (req, res) => {
  const db = getDb();
  const accounts = db.get('accounts').value();
  const posts = db.get('posts').value();
  const scheduled = db.get('scheduled_posts').filter({ status: 'pending' }).value();

  const byType = {
    youtube: accounts.filter(a => a.type === 'youtube').length,
    instagram: accounts.filter(a => a.type === 'instagram').length,
    tiktok: accounts.filter(a => a.type === 'tiktok').length,
  };

  res.json({
    total: accounts.length,
    byType,
    totalPosts: posts.length,
    scheduledPending: scheduled.length
  });
});

module.exports = router;
