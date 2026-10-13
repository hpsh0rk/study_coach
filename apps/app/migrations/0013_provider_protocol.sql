ALTER TABLE `ai_providers` ADD `protocol` text DEFAULT 'openai' NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_providers` ADD `max_tokens` integer;--> statement-breakpoint
ALTER TABLE `ai_providers` ADD `headers_sealed` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_providers` ADD `headers_hint` text DEFAULT '{}' NOT NULL;