ALTER TABLE `ai_providers` ADD `model` text DEFAULT '' NOT NULL;--> statement-breakpoint
-- One provider + one model replaces capability routing: keep the model of each provider's route
-- (the "default" route first) and leave only the default route's provider enabled.
UPDATE `ai_providers` SET `model` = COALESCE((SELECT r.`primary_model` FROM `ai_routes` r WHERE r.`primary_provider_id` = `ai_providers`.`id` ORDER BY r.`capability` = 'default' DESC LIMIT 1), '');--> statement-breakpoint
UPDATE `ai_providers` SET `enabled` = 0 WHERE `id` NOT IN (SELECT `primary_provider_id` FROM `ai_routes` WHERE `capability` = 'default' AND `org_id` = `ai_providers`.`org_id`);--> statement-breakpoint
DROP TABLE `ai_routes`;--> statement-breakpoint
ALTER TABLE `lessons` ADD `drafting_until` integer;--> statement-breakpoint
ALTER TABLE `outline_versions` ADD `rev` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `outline_versions` DROP COLUMN `total_minutes`;--> statement-breakpoint
ALTER TABLE `share_links` ADD `version_id` text REFERENCES outline_versions(id);--> statement-breakpoint
ALTER TABLE `share_links` ADD `reviewed_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `documents` DROP COLUMN `has_text_layer`;
--> statement-breakpoint
-- Links now freeze a version and re-derive their token from the link id; older links cannot do either.
UPDATE `share_links` SET `revoked_at` = CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE `revoked_at` IS NULL;
