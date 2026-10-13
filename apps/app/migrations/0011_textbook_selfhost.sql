ALTER TABLE `parser_settings` ADD `external_choice` text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE `parser_settings` ADD `selfhost_url_sealed` text;--> statement-breakpoint
ALTER TABLE `parser_settings` ADD `selfhost_url_hint` text;--> statement-breakpoint
ALTER TABLE `parser_settings` ADD `selfhost_key_sealed` text;--> statement-breakpoint
ALTER TABLE `parser_settings` ADD `selfhost_key_hint` text;--> statement-breakpoint
-- An admin who switched the parser on keeps it on; "off" rows were the old default and follow the configuration now.
UPDATE `parser_settings` SET `external_choice` = 'on' WHERE `external_enabled` = 1;--> statement-breakpoint
ALTER TABLE `parser_settings` DROP COLUMN `external_enabled`;