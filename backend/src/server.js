/**
 * 服务启动入口
 * 启动命令：npm start（或 node src/server.js）
 */
const dotenv = require('dotenv');
dotenv.config();

const app = require('./app');

// 启动前校验关键密钥：缺失或过短时直接退出，避免带弱密钥上线后 token 可被伪造
const jwtSecret = process.env.JWT_SECRET || '';
if (jwtSecret.length < 16) {
  console.error('[fatal] JWT_SECRET 未配置或长度不足 16 位，请参考 .env.example 生成随机密钥（如 openssl rand -hex 32）');
  process.exit(1);
}
if (jwtSecret.length < 32) {
  console.warn('[warn] JWT_SECRET 长度不足 32 位，建议更换为强随机密钥（openssl rand -hex 32）');
}

const PORT = Number(process.env.PORT) || 3000;

const server = app.listen(PORT, () => {
  console.log('==========================================');
  console.log('  设备故障报修与维修跟踪管理系统 - 后端服务');
  console.log(`  服务已启动: http://localhost:${PORT}`);
  console.log('==========================================');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[fatal] 端口 ${PORT} 已被占用`);
  } else {
    console.error('[fatal] 服务启动失败:', err.message);
  }
  process.exit(1);
});

// 优雅停机：先停止接收新连接，等待存量请求完成后退出
function shutdown(signal) {
  console.log(`\n收到 ${signal}，正在关闭服务...`);
  server.close(() => {
    console.log('服务已停止');
    process.exit(0);
  });
  // 兜底：10 秒后仍未退出则强制结束，避免进程悬挂
  setTimeout(() => process.exit(1), 10 * 1000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
