-- ============================================================
-- 存量库迁移脚本（已初始化过的 repair_system 库执行一次）
-- 新增：维修人员分类、故障原因选择、挂起状态、工单转交
-- 与 database/init.sql 保持一致（新库无需执行本脚本）
-- ============================================================
USE repair_system;

-- 1. 用户表：维修人员分类（器材/网络）
ALTER TABLE users
  ADD COLUMN repair_type ENUM('equipment','network') DEFAULT NULL COMMENT '维修人员分类：equipment器材维修 / network网络维修' AFTER avatar_url;

-- 2. 工单表：故障原因（选填）+ 挂起状态
ALTER TABLE work_orders
  ADD COLUMN fault_cause VARCHAR(100) DEFAULT NULL COMMENT '故障原因（选填，报修时选择）' AFTER fault_description,
  MODIFY COLUMN status ENUM('pending_review','pending_repair','repairing','suspended','pending_accept','completed','rejected','repair_returned')
    NOT NULL DEFAULT 'pending_review'
    COMMENT '状态：待审核/待接单/维修中/已挂起/待验收/已完成/已驳回/返修退回';

-- 3. 转交记录表
CREATE TABLE IF NOT EXISTS transfer_records (
  id                INT UNSIGNED AUTO_INCREMENT PRIMARY KEY COMMENT '转交记录ID',
  order_id          INT UNSIGNED NOT NULL COMMENT '工单ID（work_orders.id）',
  from_repairer_id  INT UNSIGNED NOT NULL COMMENT '转出维修人员ID（users.id）',
  to_repairer_id    INT UNSIGNED NOT NULL COMMENT '接收维修人员ID（users.id）',
  reason            VARCHAR(500) DEFAULT NULL COMMENT '转交原因',
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '转交时间',
  KEY idx_order_id (order_id),
  KEY idx_from_repairer (from_repairer_id),
  KEY idx_to_repairer (to_repairer_id),
  CONSTRAINT fk_tr_order          FOREIGN KEY (order_id)         REFERENCES work_orders (id) ON DELETE CASCADE,
  CONSTRAINT fk_tr_from_repairer  FOREIGN KEY (from_repairer_id) REFERENCES users (id),
  CONSTRAINT fk_tr_to_repairer    FOREIGN KEY (to_repairer_id)   REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='工单转交记录表';
