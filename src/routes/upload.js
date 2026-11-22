const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const authMiddleware = require('../middleware/auth');
const { getDb } = require('../services/dbService');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.resolve(process.env.UPLOAD_DIR || './uploads');
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const name = `${uuidv4()}${ext}`;
    cb(null, name);
  }
});

const fileFilter = (req, file, cb) => {
  const videoTypes = /mp4|mov|avi|mkv|webm|flv|wmv/i;
  const imageTypes = /jpeg|jpg|png|gif|webp/i;
  const ext = path.extname(file.originalname).toLowerCase().slice(1);
  if (videoTypes.test(ext) || imageTypes.test(ext)) {
    cb(null, true);
  } else {
    cb(new Error('Only video and image files are allowed'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 500 * 1024 * 1024 } // 500MB
});

// Upload single or multiple files
router.post('/', authMiddleware, upload.array('files', 20), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded' });
  }
  const db = getDb();
  const uploaded = req.files.map(file => {
    const record = {
      id: uuidv4(),
      originalName: file.originalname,
      filename: file.filename,
      path: `/uploads/${file.filename}`,
      size: file.size,
      mimetype: file.mimetype,
      uploadedAt: new Date().toISOString()
    };
    db.get('uploads').push(record).write();
    return record;
  });
  res.json({ files: uploaded });
});

// Get all uploaded files
router.get('/', authMiddleware, (req, res) => {
  const db = getDb();
  const uploads = db.get('uploads').value();
  uploads.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  res.json({ files: uploads });
});

// Delete uploaded file
router.delete('/:id', authMiddleware, (req, res) => {
  const db = getDb();
  const file = db.get('uploads').find({ id: req.params.id }).value();
  if (!file) return res.status(404).json({ error: 'File not found' });

  const fs = require('fs');
  const filePath = path.resolve(`${process.env.UPLOAD_DIR || './uploads'}/${file.filename}`);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  db.get('uploads').remove({ id: req.params.id }).write();
  res.json({ message: 'File deleted' });
});

module.exports = router;
