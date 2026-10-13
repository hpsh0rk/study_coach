-- `on` behaved exactly like `auto` (both wait for the chosen API to be configured): the switch is now auto / off.
UPDATE `parser_settings` SET `external_choice` = 'auto' WHERE `external_choice` = 'on';--> statement-breakpoint
ALTER TABLE `parse_usage` DROP COLUMN `cost_micro_yuan`;--> statement-breakpoint
ALTER TABLE `parser_settings` DROP COLUMN `monthly_budget_micro_yuan`;--> statement-breakpoint
ALTER TABLE `parser_settings` DROP COLUMN `vision_price_micro_yuan`;
