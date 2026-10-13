CREATE TABLE `parse_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`document_id` text NOT NULL,
	`parser` text NOT NULL,
	`reason` text NOT NULL,
	`pages` text NOT NULL,
	`page_count` integer NOT NULL,
	`cost_fen` integer DEFAULT 0 NOT NULL,
	`state` text DEFAULT 'submitted' NOT NULL,
	`task_id` text NOT NULL,
	`upload_url` text NOT NULL,
	`result_url` text,
	`error` text,
	`day` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `parse_usage_day_idx` ON `parse_usage` (`day`,`user_id`);--> statement-breakpoint
CREATE INDEX `parse_usage_document_idx` ON `parse_usage` (`document_id`);--> statement-breakpoint
CREATE TABLE `parser_settings` (
	`org_id` text PRIMARY KEY NOT NULL,
	`external_enabled` integer DEFAULT false NOT NULL,
	`mineru_mode` text DEFAULT 'agent' NOT NULL,
	`mineru_token_sealed` text,
	`mineru_token_hint` text,
	`updated_at` integer NOT NULL,
	`updated_by` text,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
