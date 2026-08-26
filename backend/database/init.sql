-- ============================================================
-- 设备故障报修与维修跟踪管理系统 - 数据库初始化脚本
-- 数据库版本: MySQL 8.0
-- 使用方法: mysql -u root -p < database/init.sql
-- ============================================================

-- 删除旧库并创建新库（utf8mb4 支持中文与 emoji）
DROP DATABASE IF EXISTS repair_system;
CREATE DATABASE repair_system DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE repair_system;

-- ------------------------------------------------------------
-- 1. 用户表
-- ------------------------------------------------------------
CREATE TABLE users (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY COMMENT '用户ID',
  username      VARCHAR(50)  NOT NULL COMMENT '登录用户名',
  password_hash VARCHAR(255) NOT NULL COMMENT '密码哈希（bcrypt）',
  openid        VARCHAR(100) DEFAULT NULL COMMENT '微信小程序 openid',
  real_name     VARCHAR(50)  DEFAULT NULL COMMENT '真实姓名',
  role          ENUM('admin','user','repairer') NOT NULL DEFAULT 'user' COMMENT '角色：admin管理员 / user报修用户 / repairer维修人员',
  phone         VARCHAR(20)  DEFAULT NULL COMMENT '手机号',
  avatar_url    VARCHAR(500) DEFAULT NULL COMMENT '头像图片地址',
  repair_type   ENUM('equipment','network') DEFAULT NULL COMMENT '维修人员分类：equipment器材维修 / network网络维修',
  status        ENUM('active','disabled') NOT NULL DEFAULT 'active' COMMENT '账号状态：active启用 / disabled禁用',
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  UNIQUE KEY uk_username (username),
  KEY idx_role (role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户表';

-- ------------------------------------------------------------
-- 2. 点位表（故障发生地点/设备）
-- ------------------------------------------------------------
CREATE TABLE locations (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY COMMENT '点位ID',
  name        VARCHAR(100) NOT NULL COMMENT '点位名称',
  area        VARCHAR(100) DEFAULT NULL COMMENT '所属区域',
  device_type VARCHAR(100) DEFAULT NULL COMMENT '设备类型',
  sort_order  INT NOT NULL DEFAULT 0 COMMENT '排序号（越小越靠前）',
  status      ENUM('active','inactive') NOT NULL DEFAULT 'active' COMMENT '状态：active启用 / inactive停用',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  UNIQUE KEY uk_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='点位表';

-- ------------------------------------------------------------
-- 3. 工单表
-- ------------------------------------------------------------
CREATE TABLE work_orders (
  id                    INT UNSIGNED AUTO_INCREMENT PRIMARY KEY COMMENT '工单ID',
  order_no              VARCHAR(20) NOT NULL COMMENT '工单号（WO+年月日+3位序号）',
  reporter_id           INT UNSIGNED NOT NULL COMMENT '报修人ID（users.id）',
  location_id           INT UNSIGNED NOT NULL COMMENT '故障点位ID（locations.id）',
  fault_description     TEXT NOT NULL COMMENT '故障描述',
  fault_cause           VARCHAR(100) DEFAULT NULL COMMENT '故障原因（选填，报修时选择）',
  repair_requirements   TEXT DEFAULT NULL COMMENT '维修要求',
  status                ENUM('pending_review','pending_repair','repairing','suspended','pending_accept','completed','rejected','repair_returned')
                        NOT NULL DEFAULT 'pending_review'
                        COMMENT '状态：待审核/待接单/维修中/已挂起/待验收/已完成/已驳回/返修退回',
  assigned_repairer_id  INT UNSIGNED DEFAULT NULL COMMENT '指派的维修人员ID（users.id）',
  reviewer_id           INT UNSIGNED DEFAULT NULL COMMENT '审核/验收人ID（users.id）',
  review_comment        TEXT DEFAULT NULL COMMENT '审核意见',
  reject_reason         TEXT DEFAULT NULL COMMENT '驳回/退回原因',
  suspend_draft         TEXT DEFAULT NULL COMMENT '挂起时保存的维修草稿(JSON)',
  suspend_reason        VARCHAR(500) DEFAULT NULL COMMENT '挂起原因',
  suspended_at          DATETIME DEFAULT NULL COMMENT '挂起时间',
  reviewed_at           DATETIME DEFAULT NULL COMMENT '审核时间',
  created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  updated_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  UNIQUE KEY uk_order_no (order_no),
  KEY idx_status (status),
  KEY idx_location_status (location_id, status),
  KEY idx_reporter_id (reporter_id),
  KEY idx_location_id (location_id),
  KEY idx_assigned_repairer_id (assigned_repairer_id),
  KEY idx_created_at (created_at, id),
  KEY idx_reporter_created (reporter_id, created_at),
  KEY idx_repairer_created (assigned_repairer_id, created_at),
  CONSTRAINT fk_wo_reporter  FOREIGN KEY (reporter_id)          REFERENCES users (id),
  CONSTRAINT fk_wo_location  FOREIGN KEY (location_id)          REFERENCES locations (id),
  CONSTRAINT fk_wo_repairer  FOREIGN KEY (assigned_repairer_id) REFERENCES users (id),
  CONSTRAINT fk_wo_reviewer  FOREIGN KEY (reviewer_id)          REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='工单表';

-- ------------------------------------------------------------
-- 4. 工单图片表
-- ------------------------------------------------------------
CREATE TABLE order_images (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY COMMENT '图片ID',
  order_id    INT UNSIGNED NOT NULL COMMENT '工单ID（work_orders.id）',
  image_url   VARCHAR(500) NOT NULL COMMENT '图片访问地址',
  image_type  ENUM('report','repair_before','repair_after') NOT NULL DEFAULT 'report'
              COMMENT '图片类型：报修图/维修前/维修后',
  uploader_id INT UNSIGNED DEFAULT NULL COMMENT '上传人ID（users.id）',
  sort_order  INT NOT NULL DEFAULT 0 COMMENT '排序号',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '上传时间',
  KEY idx_order_id (order_id),
  KEY idx_uploader_id (uploader_id),
  CONSTRAINT fk_oi_order    FOREIGN KEY (order_id)    REFERENCES work_orders (id) ON DELETE CASCADE,
  CONSTRAINT fk_oi_uploader FOREIGN KEY (uploader_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='工单图片表';

-- ------------------------------------------------------------
-- 5. 维修记录表
-- ------------------------------------------------------------
CREATE TABLE repair_records (
  id               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY COMMENT '维修记录ID',
  order_id         INT UNSIGNED NOT NULL COMMENT '工单ID（work_orders.id）',
  repairer_id      INT UNSIGNED NOT NULL COMMENT '维修人员ID（users.id）',
  start_time       DATETIME DEFAULT NULL COMMENT '维修开始时间',
  end_time         DATETIME DEFAULT NULL COMMENT '维修结束时间',
  gps_latitude     DECIMAL(10,7) DEFAULT NULL COMMENT '维修地点纬度',
  gps_longitude    DECIMAL(10,7) DEFAULT NULL COMMENT '维修地点经度',
  location_address VARCHAR(500) DEFAULT NULL COMMENT '维修地点地址描述',
  fault_reason     TEXT DEFAULT NULL COMMENT '故障原因分析',
  repair_action    TEXT DEFAULT NULL COMMENT '维修措施',
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  KEY idx_order_id (order_id),
  KEY idx_order_created_at (order_id, created_at),
  KEY idx_repairer_id (repairer_id),
  CONSTRAINT fk_rr_order    FOREIGN KEY (order_id)    REFERENCES work_orders (id) ON DELETE CASCADE,
  CONSTRAINT fk_rr_repairer FOREIGN KEY (repairer_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='维修记录表';

-- ------------------------------------------------------------
-- 6. 验收记录表
-- ------------------------------------------------------------
CREATE TABLE acceptance_records (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY COMMENT '验收记录ID',
  order_id      INT UNSIGNED NOT NULL COMMENT '工单ID（work_orders.id）',
  reviewer_id   INT UNSIGNED NOT NULL COMMENT '验收人ID（users.id）',
  result        ENUM('pass','return') NOT NULL COMMENT '验收结果：pass通过 / return退回返修',
  return_reason VARCHAR(500) DEFAULT NULL COMMENT '退回原因',
  accepted_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '验收时间',
  KEY idx_order_id (order_id),
  KEY idx_order_accepted_at (order_id, accepted_at),
  KEY idx_reviewer_id (reviewer_id),
  KEY idx_result_accepted (result, accepted_at),
  CONSTRAINT fk_ar_order    FOREIGN KEY (order_id)    REFERENCES work_orders (id) ON DELETE CASCADE,
  CONSTRAINT fk_ar_reviewer FOREIGN KEY (reviewer_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='验收记录表';

-- ------------------------------------------------------------
-- 6.5 转交记录表
-- ------------------------------------------------------------
CREATE TABLE transfer_records (
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

-- ------------------------------------------------------------
-- 7. 通知表
-- ------------------------------------------------------------
CREATE TABLE notifications (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY COMMENT '通知ID',
  user_id    INT UNSIGNED NOT NULL COMMENT '接收人ID（users.id）',
  order_id   INT UNSIGNED DEFAULT NULL COMMENT '关联工单ID（work_orders.id）',
  type       VARCHAR(50) NOT NULL DEFAULT 'system' COMMENT '通知类型（order_review/order_assign等）',
  title      VARCHAR(200) NOT NULL COMMENT '通知标题',
  content    TEXT DEFAULT NULL COMMENT '通知内容',
  is_read    TINYINT NOT NULL DEFAULT 0 COMMENT '是否已读：0未读 / 1已读',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  KEY idx_user_id (user_id),
  KEY idx_user_is_read (user_id, is_read),
  KEY idx_order_id (order_id),
  CONSTRAINT fk_nt_user  FOREIGN KEY (user_id)  REFERENCES users (id),
  CONSTRAINT fk_nt_order FOREIGN KEY (order_id) REFERENCES work_orders (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='通知表';

-- ------------------------------------------------------------
-- 用户数据（管理员、报修用户和维修人员）请通过后台创建，避免在代码库中保存凭据。

-- ------------------------------------------------------------
-- 预置300个监控点位
-- ------------------------------------------------------------
INSERT INTO locations (name, area, device_type, sort_order, status) VALUES
('3号楼道摄像头-01',  '3号楼',  '摄像头', 1, 'active'),
('大门入口摄像头-03', '大门',   '摄像头', 2, 'active'),
('停车场摄像头-02',  '停车场', '摄像头', 3, 'active'),
('2号楼道摄像头-01',  '2号楼',  '摄像头', 4, 'active'),
('围墙报警器-05',    '围墙',   '报警器', 5, 'active');

-- 生成第 6-300 个监控点位
INSERT INTO locations (name, area, device_type, sort_order, status)
WITH RECURSIVE seq AS (
  SELECT 6 AS n
  UNION ALL
  SELECT n + 1 FROM seq WHERE n < 300
)
SELECT CONCAT('监控点位-', LPAD(n, 3, '0')),
       CONCAT('区域', ((n - 1) % 10) + 1),
       '摄像头',
       n,
       'active'
FROM seq;
