/**
 * 工单号生成工具
 * 格式：WO + 年月日 + 4位序号，例如：WO202608010001
 * 序号按当天已存在的最大工单号自增（解析尾部完整数字，兼容旧 3 位序号）。
 * 固定 4 位宽度，避免 3→4 位切换时字符串字典序错乱导致序号回绕。
 */
const pool = require('../config/db');

async function generateOrderNo() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const prefix = `WO${y}${m}${d}`;

  // 查询当天最大的工单号，解析其尾部完整数字 + 1
  const [rows] = await pool.query(
    `SELECT order_no FROM work_orders WHERE order_no LIKE ? ORDER BY order_no DESC LIMIT 1`,
    [`${prefix}%`]
  );

  let seq = 1;
  if (rows.length > 0) {
    const mch = String(rows[0].order_no).match(/(\d+)$/);
    if (mch) {
      seq = parseInt(mch[1], 10) + 1;
      if (Number.isNaN(seq)) seq = 1;
    }
  }

  if (seq > 9999) seq = 9999; // 溢出保护
  return `${prefix}${String(seq).padStart(4, '0')}`;
}

module.exports = generateOrderNo;
