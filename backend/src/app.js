/**
 * Express 主入口
 * 配置 CORS、JSON 解析、静态文件服务、路由挂载与全局错误处理
 */
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const express = require('express');
const cors = require('cors');
const multer = require('multer');

// 加载环境变量
dotenv.config();

const app = express();

// CORS 配置：允许跨域访问
app.use(cors());

// 解析 JSON 请求体
app.use(express.json({ limit: '10mb' }));

// 静态文件服务：uploads 目录下的图片可通过 /uploads/xxx 直接访问
const uploadDir = path.join(__dirname, '..', process.env.UPLOAD_DIR || 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
app.use('/uploads', express.static(uploadDir));

// 健康检查接口（供部署/监控探测使用）
app.get('/api/health', (req, res) => {
  res.json({ code: 0, message: 'success', data: { status: 'ok', time: new Date().toISOString() } });
});

// 挂载各业务路由
app.use('/api/auth', require('./routes/auth'));                 // 认证
app.use('/api/users', require('./routes/users'));               // 用户管理（admin）
app.use('/api/locations', require('./routes/locations'));       // 点位管理
app.use('/api/orders', require('./routes/orders'));             // 工单管理
app.use('/api/upload', require('./routes/upload'));             // 图片上传
app.use('/api/statistics', require('./routes/statistics'));     // 统计（admin）
app.use('/api/notifications', require('./routes/notifications')); // 通知

// 404 处理
app.use((req, res) => {
  res.status(404).json({ code: 1, message: '接口不存在' });
});

// 全局错误处理中间件（必须放在最后）
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // 文件上传相关错误
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE'
      ? '图片大小超过 10MB 限制'
      : `文件上传失败：${err.message}`;
    return res.status(400).json({ code: 1, message: msg });
  }
  // 自定义状态码错误（如文件类型过滤）
  if (err.statusCode) {
    return res.status(err.statusCode).json({ code: 1, message: err.message });
  }
  // 其他未预期错误
  console.error('[全局错误]', err);
  res.status(500).json({ code: 1, message: err.message || '服务器内部错误' });
});

module.exports = app;
