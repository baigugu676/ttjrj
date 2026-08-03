/**
 * 图片上传路由（需登录）
 * POST /api/upload — 单文件上传到 uploads/ 目录
 * 若 body 中携带 order_id 与 image_type，自动写入 order_images 表
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const pool = require('../config/db');
const { auth } = require('../middleware/auth');

const router = express.Router();

// 上传目录（backend/uploads）
const uploadDir = path.resolve(__dirname, '..', '..', process.env.UPLOAD_DIR || 'uploads');

// 确保上传目录存在
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Multer 磁盘存储配置：文件名使用时间戳 + 随机数，避免重名覆盖
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  }
});

// 文件类型过滤：允许常见图片格式（兼容微信小程序不同版本的 MIME 上报）
const fileFilter = (req, file, cb) => {
  const allowTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/bmp'];
  // 微信小程序 wx.uploadFile 在某些设备上可能不传 Content-Type 或传 application/octet-stream
  // 此时通过文件扩展名兜底校验
  if (allowTypes.includes(file.mimetype)) {
    cb(null, true);
    return;
  }
  // 兜底：通过文件扩展名判断
  const ext = (file.originalname || '').toLowerCase();
  const allowedExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
  if (allowedExts.some((e) => ext.endsWith(e))) {
    cb(null, true);
    return;
  }
  const err = new Error('只能上传图片文件（jpg/png/gif/webp/bmp），当前类型：' + (file.mimetype || '未知'));
  err.statusCode = 400;
  cb(err);
};

// 单文件上传实例：字段名为 file，大小限制 10MB
const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }
});

/**
 * POST /api/upload — 上传单张图片（需登录）
 * multipart/form-data：file 字段必填
 * 可选字段：order_id（关联工单ID）、image_type（report/repair_before/repair_after）
 */
router.post('/', auth, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.json({ code: 1, message: '请选择要上传的图片' });
    }

    // 生成的图片访问地址（通过静态目录 /uploads 访问）
    const imageUrl = `/uploads/${req.file.filename}`;
    let orderImageId = null;

    // 若传入了 order_id，则校验工单并把图片记录写入 order_images 表
    const { order_id, image_type } = req.body || {};
    if (order_id) {
      const orderId = Number(order_id);
      if (!Number.isInteger(orderId) || orderId <= 0) {
        // 参数不合法：删除已上传的文件再返回错误
        fs.unlink(req.file.path, () => {});
        return res.json({ code: 1, message: 'order_id 不合法' });
      }

      // 校验工单是否存在
      const [orders] = await pool.query(`SELECT id FROM work_orders WHERE id = ?`, [orderId]);
      if (orders.length === 0) {
        fs.unlink(req.file.path, () => {});
        return res.json({ code: 1, message: '工单不存在' });
      }

      // 校验图片类型，非法时默认 report
      const validTypes = ['report', 'repair_before', 'repair_after'];
      const type = validTypes.includes(image_type) ? image_type : 'report';

      // 写入 order_images 表
      const [result] = await pool.query(
        `INSERT INTO order_images (order_id, image_url, image_type, uploader_id)
         VALUES (?, ?, ?, ?)`,
        [orderId, imageUrl, type, req.user.id]
      );
      orderImageId = result.insertId;
    }

    res.json({
      code: 0,
      message: 'success',
      data: { url: imageUrl, order_image_id: orderImageId }
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
