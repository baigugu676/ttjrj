/**
 * 服务启动入口
 * 启动命令：npm start（或 node src/server.js）
 */
const dotenv = require('dotenv');
dotenv.config();

const app = require('./app');

const PORT = Number(process.env.PORT) || 3000;

app.listen(PORT, () => {
  console.log('==========================================');
  console.log('  设备故障报修与维修跟踪管理系统 - 后端服务');
  console.log(`  服务已启动: http://localhost:${PORT}`);
  console.log('==========================================');
});
