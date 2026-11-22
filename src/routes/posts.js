const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const { getDb } = require('../services/dbService');
const { v4: uuidv4 } = require('uuid');

// Get all posts
router.get('/', authMiddleware, (req, res) => {
  const db = getDb();
  const { status, platform, page = 1, limit = 20 } = req.query;
  let posts = db.get('posts').value();

  if (status) posts = posts.filter(p => p.status === status);
  if (platform) posts = posts.filter(p => p.platforms && p.platforms.includes(platform));

  posts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const total = posts.length;
  const start = (parseInt(page) - 1) * parseInt(limit);
  const paginated = posts.slice(start, start + parseInt(limit));

  res.json({ posts: paginated, total, page: parseInt(page), limit: parseInt(limit) });
});

// Create and publish post immediately
router.post('/publish', authMiddleware, async (req, res) => {
  const { title, description, tags, platforms, accountIds, videoPath, thumbnailPath } = req.body;

  if (!title || !accountIds || !accountIds.length) {
    return res.status(400).json({ error: 'Title and accounts required' });
  }

  const db = getDb();
  const postId = uuidv4();
  const results = [];

  const post = {
    id: postId,
    title,
    description: description || '',
    tags: tags || [],
    platforms: platforms || [],
    accountIds,
    videoPath: videoPath || null,
    thumbnailPath: thumbnailPath || null,
    status: 'publishing',
    results: [],
    createdAt: new Date().toISOString(),
    publishedAt: null
  };

  db.get('posts').push(post).write();

  // Publish to each account
  const publishService = require('../services/publishService');
  for (const accountId of accountIds) {
    const account = db.get('accounts').find({ id: accountId }).value();
    if (!account) {
      results.push({ accountId, status: 'error', error: 'Account not found' });
      continue;
    }
    try {
      const result = await publishService.publish(account, { title, description, tags, videoPath, thumbnailPath });
      results.push({ accountId, accountName: account.name, type: account.type, status: 'success', data: result });
    } catch (err) {
      results.push({ accountId, accountName: account.name, type: account.type, status: 'error', error: err.message });
    }
  }

  const allSuccess = results.every(r => r.status === 'success');
  const anySuccess = results.some(r => r.status === 'success');

  db.get('posts').find({ id: postId }).assign({
    status: allSuccess ? 'published' : (anySuccess ? 'partial' : 'failed'),
    results,
    publishedAt: new Date().toISOString()
  }).write();

  res.json({ post: db.get('posts').find({ id: postId }).value(), results });
});

// Delete post
router.delete('/:id', authMiddleware, (req, res) => {
  const db = getDb();
  db.get('posts').remove({ id: req.params.id }).write();
  res.json({ message: 'Post deleted' });
});

module.exports = router;
