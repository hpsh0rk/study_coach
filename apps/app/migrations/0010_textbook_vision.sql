ALTER TABLE `parse_usage` RENAME COLUMN "cost_fen" TO "cost_micro_yuan";--> statement-breakpoint
ALTER TABLE `ai_providers` ADD `vision_model` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `parser_settings` ADD `paid_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `parser_settings` ADD `monthly_budget_micro_yuan` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `parser_settings` ADD `vision_price_micro_yuan` integer;