const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const { getDb } = require('../services/dbService');
const { v4: uuidv4 } = require('uuid');

// Get all scheduled posts
router.get('/', authMiddleware, (req, res) => {
  const db = getDb();
  const scheduled = db.get('scheduled_posts').value();
  scheduled.sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
  res.json({ scheduled });
});

// Create scheduled post
router.post('/', authMiddleware, (req, res) => {
  const { title, description, tags, platforms, accountIds, videoPath, thumbnailPath, scheduledAt } = req.body;

  if (!title || !accountIds || !accountIds.length || !scheduledAt) {
    return res.status(400).json({ error: 'Title, accounts, and scheduledAt required' });
  }

  const schedDate = new Date(scheduledAt);
  if (schedDate <= new Date()) {
    return res.status(400).json({ error: 'Schedule time must be in the future' });
  }

  const db = getDb();
  const scheduled = {
    id: uuidv4(),
    title,
    description: description || '',
    tags: tags || [],
    platforms: platforms || [],
    accountIds,
    videoPath: videoPath || null,
    thumbnailPath: thumbnailPath || null,
    scheduledAt,
    status: 'pending',
    results: null,
    createdAt: new Date().toISOString()
  };

  db.get('scheduled_posts').push(scheduled).write();
  res.json({ scheduled });
});

// Update scheduled post
router.put('/:id', authMiddleware, (req, res) => {
  const db = getDb();
  const { title, description, tags, scheduledAt, accountIds } = req.body;
  const item = db.get('scheduled_posts').find({ id: req.params.id }).value();
  if (!item) return res.status(404).json({ error: 'Not found' });
  if (item.status !== 'pending') return res.status(400).json({ error: 'Cannot edit non-pending post' });

  db.get('scheduled_posts').find({ id: req.params.id }).assign({
    title: title || item.title,
    description: description !== undefined ? description : item.description,
    tags: tags || item.tags,
    scheduledAt: scheduledAt || item.scheduledAt,
    accountIds: accountIds || item.accountIds,
    updatedAt: new Date().toISOString()
  }).write();

  res.json({ scheduled: db.get('scheduled_posts').find({ id: req.params.id }).value() });
});

// Delete scheduled post
router.delete('/:id', authMiddleware, (req, res) => {
  const db = getDb();
  db.get('scheduled_posts').remove({ id: req.params.id }).write();
  res.json({ message: 'Deleted' });
});

module.exports = router;
