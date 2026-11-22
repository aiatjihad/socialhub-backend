const cron = require('node-cron');
const { getDb } = require('./dbService');
const publishService = require('./publishService');

// Run every minute to check scheduled posts
cron.schedule('* * * * *', async () => {
  const db = getDb();
  const now = new Date();

  const pendingPosts = db.get('scheduled_posts')
    .filter(p => p.status === 'pending')
    .value()
    .filter(p => new Date(p.scheduledAt) <= now);

  for (const post of pendingPosts) {
    console.log(`📅 Publishing scheduled post: ${post.title}`);
    db.get('scheduled_posts').find({ id: post.id }).assign({ status: 'publishing' }).write();

    const results = [];
    for (const accountId of post.accountIds) {
      const account = db.get('accounts').find({ id: accountId }).value();
      if (!account) {
        results.push({ accountId, status: 'error', error: 'Account not found' });
        continue;
      }
      try {
        const result = await publishService.publish(account, {
          title: post.title,
          description: post.description,
          tags: post.tags,
          videoPath: post.videoPath,
          thumbnailPath: post.thumbnailPath
        });
        results.push({ accountId, accountName: account.name, type: account.type, status: 'success', data: result });
      } catch (err) {
        results.push({ accountId, accountName: account.name, type: account.type, status: 'error', error: err.message });
      }
    }

    const anySuccess = results.some(r => r.status === 'success');
    const allSuccess = results.every(r => r.status === 'success');

    db.get('scheduled_posts').find({ id: post.id }).assign({
      status: allSuccess ? 'published' : (anySuccess ? 'partial' : 'failed'),
      results,
      publishedAt: new Date().toISOString()
    }).write();

    // Also add to posts history
    const { v4: uuidv4 } = require('uuid');
    db.get('posts').push({
      id: uuidv4(),
      ...post,
      status: allSuccess ? 'published' : (anySuccess ? 'partial' : 'failed'),
      results,
      publishedAt: new Date().toISOString()
    }).write();

    console.log(`✅ Scheduled post published: ${post.title} (${results.length} accounts)`);
  }
});

console.log('⏰ Scheduler started - checking every minute');
