/**
 * MySQL 数据库连接池
 * 使用 mysql2/promise 提供 Promise 风格 API
 */
const mysql = require('mysql2/promise');
const dotenv = require('dotenv');

// 加载 .env 环境变量
dotenv.config();

// 创建连接池（连接懒加载，只有真正执行查询时才建立连接）
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'repair_system',
  waitForConnections: true,   // 连接用完时排队等待
  connectionLimit: 10,        // 最大连接数
  queueLimit: 0,              // 排队不设上限
  charset: 'utf8mb4',         // 支持中文
  timezone: '+08:00'          // 驱动层日期↔字符串互转使用中国时区
});

// 设置 MySQL 会话时区为 +08:00：
// mysql2 的 timezone 配置只影响驱动层，CURDATE()/NOW() 等服务器端函数仍按会话时区计算，
// 必须显式 SET time_zone，否则「今日/本月」统计边界会跟随服务器时区错位。
pool.on('connection', (conn) => {
  conn.query("SET time_zone = '+08:00'", (err) => {
    if (err) console.warn('[db] 设置会话时区失败:', err.message);
  });
});

// 简单导出连接池
module.exports = pool;
