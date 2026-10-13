-- A text provider's vision model becomes its own `purpose = vision` row with the same address, key, headers and
-- protocol. It is enabled only where it was the one reading pages: its text provider enabled and no separate
-- vision provider enabled (that one always won).
INSERT INTO `ai_providers` (`id`, `org_id`, `kind`, `name`, `base_url`, `api_key_sealed`, `api_key_hint`, `model`, `vision_model`, `purpose`, `protocol`, `max_tokens`, `headers_sealed`, `headers_hint`, `enabled`, `created_at`, `updated_at`)
SELECT 'aip_' || lower(hex(randomblob(8))), t.`org_id`, t.`kind`, t.`name` || ' 看图', t.`base_url`, t.`api_key_sealed`, t.`api_key_hint`, t.`vision_model`, '', 'vision', t.`protocol`, t.`max_tokens`, t.`headers_sealed`, t.`headers_hint`,
  CASE WHEN t.`enabled` = 1 AND t.`model` <> '' AND NOT EXISTS (SELECT 1 FROM `ai_providers` v WHERE v.`org_id` = t.`org_id` AND v.`purpose` = 'vision' AND v.`enabled` = 1) THEN 1 ELSE 0 END,
  t.`created_at`, CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM `ai_providers` t
WHERE t.`purpose` = 'text' AND t.`vision_model` <> '';--> statement-breakpoint
ALTER TABLE `ai_providers` DROP COLUMN `vision_model`;
