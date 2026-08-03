/**
 * 工单号生成工具
 * 格式：WO + 年月日 + 3位序号，例如：WO20260801001
 * 序号按当天已存在的工单数量自增
 */
const pool = require('../config/db');

async function generateOrderNo() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const prefix = `WO${y}${m}${d}`;

  // 查询当天最大的工单号，取其末尾3位序号 + 1
  const [rows] = await pool.query(
    `SELECT order_no FROM work_orders WHERE order_no LIKE ? ORDER BY order_no DESC LIMIT 1`,
    [`${prefix}%`]
  );

  let seq = 1;
  if (rows.length > 0) {
    const lastSeq = parseInt(rows[0].order_no.slice(-3), 10);
    if (!Number.isNaN(lastSeq)) {
      seq = lastSeq + 1;
    }
  }

  return `${prefix}${String(seq).padStart(3, '0')}`;
}

module.exports = generateOrderNo;
