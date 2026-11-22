const path = require('path');
const fs = require('fs');

/**
 * Publish to a social media account
 * @param {Object} account - Account object from DB
 * @param {Object} postData - Post data
 */
async function publish(account, postData) {
  if (account.manual) {
    // Manual accounts - simulate success (useful for testing)
    return { simulated: true, message: 'Manual account - post recorded locally' };
  }

  switch (account.type) {
    case 'youtube':
      return await publishToYouTube(account, postData);
    case 'instagram':
      return await publishToInstagram(account, postData);
    case 'tiktok':
      return await publishToTikTok(account, postData);
    default:
      throw new Error(`Unknown platform: ${account.type}`);
  }
}

async function publishToYouTube(account, postData) {
  const { google } = require('googleapis');
  const { title, description, tags, videoPath } = postData;

  if (!videoPath) throw new Error('Video file required for YouTube');

  const oauth2Client = new google.auth.OAuth2(
    process.env.YOUTUBE_CLIENT_ID,
    process.env.YOUTUBE_CLIENT_SECRET,
    process.env.YOUTUBE_REDIRECT_URI
  );

  oauth2Client.setCredentials({
    access_token: account.accessToken,
    refresh_token: account.refreshToken
  });

  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

  const absolutePath = path.resolve('.' + videoPath);
  if (!fs.existsSync(absolutePath)) throw new Error('Video file not found on server');

  const fileSize = fs.statSync(absolutePath).size;

  const response = await youtube.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title: title.substring(0, 100),
        description: description || '',
        tags: Array.isArray(tags) ? tags : [],
        categoryId: '22' // People & Blogs
      },
      status: {
        privacyStatus: 'public'
      }
    },
    media: {
      body: fs.createReadStream(absolutePath)
    }
  });

  return { videoId: response.data.id, url: `https://youtube.com/watch?v=${response.data.id}` };
}

async function publishToInstagram(account, postData) {
  const axios = require('axios');
  const { title, description, videoPath } = postData;
  const caption = `${title}\n\n${description || ''}`.trim();

  if (!videoPath) throw new Error('Video file required for Instagram Reels');

  // Step 1: Create media container
  const videoUrl = `${process.env.INSTAGRAM_REDIRECT_URI.replace('/api/auth/instagram/callback', '')}${videoPath}`;

  const containerRes = await axios.post(
    `https://graph.instagram.com/v19.0/${account.instagramId}/media`,
    {
      media_type: 'REELS',
      video_url: videoUrl,
      caption,
      access_token: account.accessToken
    }
  );

  const containerId = containerRes.data.id;

  // Step 2: Wait for container to process
  let status = 'IN_PROGRESS';
  let attempts = 0;
  while (status === 'IN_PROGRESS' && attempts < 30) {
    await new Promise(r => setTimeout(r, 10000));
    const statusRes = await axios.get(
      `https://graph.instagram.com/v19.0/${containerId}?fields=status_code&access_token=${account.accessToken}`
    );
    status = statusRes.data.status_code;
    attempts++;
  }

  if (status !== 'FINISHED') throw new Error(`Instagram media processing failed: ${status}`);

  // Step 3: Publish
  const publishRes = await axios.post(
    `https://graph.instagram.com/v19.0/${account.instagramId}/media_publish`,
    { creation_id: containerId, access_token: account.accessToken }
  );

  return { mediaId: publishRes.data.id };
}

async function publishToTikTok(account, postData) {
  const axios = require('axios');
  const { title, videoPath } = postData;

  if (!videoPath) throw new Error('Video file required for TikTok');

  const absolutePath = path.resolve('.' + videoPath);
  if (!fs.existsSync(absolutePath)) throw new Error('Video file not found on server');
  const fileSize = fs.statSync(absolutePath).size;

  // Step 1: Initialize upload
  const initRes = await axios.post(
    'https://open.tiktokapis.com/v2/post/publish/video/init/',
    {
      post_info: {
        title: title.substring(0, 150),
        privacy_level: 'PUBLIC_TO_EVERYONE',
        disable_duet: false,
        disable_comment: false,
        disable_stitch: false
      },
      source_info: {
        source: 'FILE_UPLOAD',
        video_size: fileSize,
        chunk_size: fileSize,
        total_chunk_count: 1
      }
    },
    { headers: { Authorization: `Bearer ${account.accessToken}`, 'Content-Type': 'application/json' } }
  );

  const { publish_id, upload_url } = initRes.data.data;

  // Step 2: Upload video
  const videoBuffer = fs.readFileSync(absolutePath);
  await axios.put(upload_url, videoBuffer, {
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Range': `bytes 0-${fileSize - 1}/${fileSize}`,
      'Content-Length': fileSize
    }
  });

  return { publishId: publish_id };
}

module.exports = { publish };
