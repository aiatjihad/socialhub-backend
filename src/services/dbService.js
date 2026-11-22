const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const bcrypt = require('bcryptjs');

const dbFile = process.env.DB_FILE || './db.json';
const adapter = new FileSync(path.resolve(dbFile));
const db = low(adapter);

function init() {
  db.defaults({
    users: [],
    accounts: [],
    posts: [],
    scheduled_posts: [],
    uploads: []
  }).write();

  // Create default admin user if none exists
  const users = db.get('users').value();
  if (users.length === 0) {
    const hashedPassword = bcrypt.hashSync('admin123', 10);
    db.get('users').push({
      id: uuidv4(),
      username: 'admin',
      email: 'admin@socialhub.com',
      password: hashedPassword,
      createdAt: new Date().toISOString()
    }).write();
    console.log('✅ Default user created: admin / admin123');
  }

  // Pre-seed 12 YouTube, 2 Instagram, 1 TikTok accounts if none exist
  const accounts = db.get('accounts').value();
  if (accounts.length === 0) {
    const initialAccounts = [];
    for (let i = 1; i <= 12; i++) {
      initialAccounts.push({
        id: uuidv4(),
        type: 'youtube',
        name: `YouTube Channel ${i}`,
        username: `yt_channel_${i}`,
        connected: true,
        manual: true,
        createdAt: new Date().toISOString()
      });
    }
    for (let i = 1; i <= 2; i++) {
      initialAccounts.push({
        id: uuidv4(),
        type: 'instagram',
        name: `Instagram Page ${i}`,
        username: `ig_page_${i}`,
        connected: true,
        manual: true,
        createdAt: new Date().toISOString()
      });
    }
    initialAccounts.push({
      id: uuidv4(),
      type: 'tiktok',
      name: 'TikTok Main Account',
      username: 'tiktok_main',
      connected: true,
      manual: true,
      createdAt: new Date().toISOString()
    });
    db.set('accounts', initialAccounts).write();
    console.log('✅ Pre-seeded 12 YouTube, 2 Instagram, and 1 TikTok accounts');
  }
}

function getDb() {
  return db;
}

module.exports = { init, getDb };
