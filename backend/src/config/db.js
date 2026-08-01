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
  timezone: '+08:00'          // 中国时区
});

// 简单导出连接池
module.exports = pool;
