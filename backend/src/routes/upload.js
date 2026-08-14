/**
 * 图片上传路由（需登录）
 * POST /api/upload — 单文件上传到 uploads/ 目录
 * 若 body 中携带 order_id 与 image_type，自动写入 order_images 表
 *
 * 安全约束：
 *   - 校验文件魔数（内容确为图片），客户端 MIME/扩展名不可信
 *   - 按角色与工单归属校验：user 仅能给自己的工单传报修图；
 *     repairer 仅能给指派给自己的工单传维修前后图；admin 不受限
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

// 校验文件内容魔数，确认确为图片（防止伪造扩展名上传任意文件）
async function hasImageMagic(filePath) {
  try {
    const fd = await fs.promises.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(16);
      await fd.read(buf, 0, 16, 0);
      // JPEG: FF D8 FF
      if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return true;
      // PNG: 89 50 4E 47
      if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return true;
      // GIF: GIF87a / GIF89a
      const head6 = buf.slice(0, 6).toString('ascii');
      if (head6 === 'GIF87a' || head6 === 'GIF89a') return true;
      // BMP: BM
      if (buf[0] === 0x42 && buf[1] === 0x4D) return true;
      // WebP: RIFF....WEBP
      if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return true;
      return false;
    } finally {
      await fd.close();
    }
  } catch (err) {
    return false;
  }
}

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

    // 魔数校验：文件内容必须是真实图片
    const magicOk = await hasImageMagic(req.file.path);
    if (!magicOk) {
      fs.unlink(req.file.path, () => {});
      return res.json({ code: 1, message: '文件内容不是有效的图片，已拒绝' });
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
      const [orders] = await pool.query(
        `SELECT id, reporter_id, assigned_repairer_id, status FROM work_orders WHERE id = ?`,
        [orderId]
      );
      if (orders.length === 0) {
        fs.unlink(req.file.path, () => {});
        return res.json({ code: 1, message: '工单不存在' });
      }
      const order = orders[0];

      // 校验图片类型，非法时默认 report
      const validTypes = ['report', 'repair_before', 'repair_after'];
      const type = validTypes.includes(image_type) ? image_type : 'report';

      // 归属与角色校验（与云函数 addImage 一致）
      if (req.user.role === 'user') {
        if (order.reporter_id !== req.user.id) {
          fs.unlink(req.file.path, () => {});
          return res.json({ code: 1, message: '无权操作该工单' });
        }
        if (type !== 'report') {
          fs.unlink(req.file.path, () => {});
          return res.json({ code: 1, message: '报修用户仅可上传报修照片' });
        }
      } else if (req.user.role === 'repairer') {
        if (order.assigned_repairer_id !== req.user.id) {
          fs.unlink(req.file.path, () => {});
          return res.json({ code: 1, message: '无权操作该工单' });
        }
        if (type === 'report') {
          fs.unlink(req.file.path, () => {});
          return res.json({ code: 1, message: '维修人员仅可上传维修前后照片' });
        }
        if (['completed', 'rejected'].includes(order.status)) {
          fs.unlink(req.file.path, () => {});
          return res.json({ code: 1, message: '工单已结束，无法上传维修照片' });
        }
      }
      // admin 不受限（可补充证据照片）

      // 写入 order_images 表；DB 写入失败时删除孤儿文件
      try {
        const [result] = await pool.query(
          `INSERT INTO order_images (order_id, image_url, image_type, uploader_id)
           VALUES (?, ?, ?, ?)`,
          [orderId, imageUrl, type, req.user.id]
        );
        orderImageId = result.insertId;
      } catch (dbErr) {
        fs.unlink(req.file.path, () => {});
        throw dbErr;
      }
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
