/**
 * 数据库初始化脚本（package.json 的 init-db 入口）
 * 读取 backend/database/init.sql 并执行，需先配置 backend/.env（DB_HOST 等）。
 * 用法：npm run init-db
 */
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

async function main() {
  const sqlFile = path.join(__dirname, '..', 'database', 'init.sql');
  if (!fs.existsSync(sqlFile)) {
    console.error('未找到初始化脚本:', sqlFile);
    process.exit(1);
  }
  const sql = fs.readFileSync(sqlFile, 'utf8');

  // 初始化脚本可能含 CREATE DATABASE，需先不带库名连接
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || ''
  });
  try {
    await conn.query("SET time_zone = '+08:00'");
    await conn.query(sql);
    console.log('数据库初始化完成。');
  } catch (err) {
    console.error('初始化失败:', err.message);
    process.exitCode = 1;
  } finally {
    await conn.end();
  }
}

main();
