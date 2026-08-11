-- 将现有 repair_system 数据扩容至 300 个启用监控。
-- 可重复执行：username/name 唯一键会跳过已存在的数据。
USE repair_system;

INSERT IGNORE INTO locations (name, area, device_type, sort_order, status)
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
