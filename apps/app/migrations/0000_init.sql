CREATE TABLE `ai_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`lesson_id` text,
	`capability` text NOT NULL,
	`prompt_version` text NOT NULL,
	`provider_id` text NOT NULL,
	`model` text NOT NULL,
	`status` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`latency_ms` integer NOT NULL,
	`error` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ai_calls_lesson_idx` ON `ai_calls` (`lesson_id`);--> statement-breakpoint
CREATE INDEX `ai_calls_org_time_idx` ON `ai_calls` (`org_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `ai_providers` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`base_url` text NOT NULL,
	`api_key_sealed` text NOT NULL,
	`api_key_hint` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `ai_routes` (
	`org_id` text NOT NULL,
	`capability` text NOT NULL,
	`primary_provider_id` text NOT NULL,
	`primary_model` text NOT NULL,
	`fallback_provider_id` text,
	`fallback_model` text,
	`temperature` real,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `capability`),
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`org_id` text NOT NULL,
	`actor_id` text,
	`action` text NOT NULL,
	`target` text,
	`detail` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `chapters` (
	`document_id` text NOT NULL,
	`id` text NOT NULL,
	`parent_id` text,
	`ord` integer NOT NULL,
	`level` integer NOT NULL,
	`title` text NOT NULL,
	`page_start` integer NOT NULL,
	`page_end` integer NOT NULL,
	`words` integer NOT NULL,
	PRIMARY KEY(`document_id`, `id`),
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`filename` text NOT NULL,
	`title` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`page_count` integer NOT NULL,
	`pages_received` integer DEFAULT 0 NOT NULL,
	`has_text_layer` integer NOT NULL,
	`has_bookmarks` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `documents_owner_idx` ON `documents` (`org_id`,`owner_id`);--> statement-breakpoint
CREATE TABLE `lessons` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`document_id` text NOT NULL,
	`title` text NOT NULL,
	`scope` text NOT NULL,
	`params` text NOT NULL,
	`theme` text DEFAULT 'classic' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `lessons_owner_idx` ON `lessons` (`org_id`,`owner_id`);--> statement-breakpoint
CREATE TABLE `login_attempts` (
	`key` text PRIMARY KEY NOT NULL,
	`window_start` integer NOT NULL,
	`failures` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `orgs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `outline_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`lesson_id` text NOT NULL,
	`version` integer NOT NULL,
	`outline` text NOT NULL,
	`params` text NOT NULL,
	`scope` text NOT NULL,
	`spec_count` integer NOT NULL,
	`total_minutes` real NOT NULL,
	`ack_over_budget` integer DEFAULT false NOT NULL,
	`confirmed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`lesson_id`) REFERENCES `lessons`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outline_versions_lesson_version_uq` ON `outline_versions` (`lesson_id`,`version`);--> statement-breakpoint
CREATE TABLE `pages` (
	`document_id` text NOT NULL,
	`no` integer NOT NULL,
	`text` text NOT NULL,
	`label` text,
	`words` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`document_id`, `no`),
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`user_agent` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `share_links` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`lesson_id` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`lesson_id`) REFERENCES `lessons`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `share_token_uq` ON `share_links` (`token_hash`);--> statement-breakpoint
CREATE INDEX `share_lesson_idx` ON `share_links` (`lesson_id`);--> statement-breakpoint
CREATE TABLE `slides` (
	`id` text PRIMARY KEY NOT NULL,
	`lesson_id` text NOT NULL,
	`outline_version_id` text NOT NULL,
	`spec_id` text NOT NULL,
	`spec_hash` text NOT NULL,
	`layout` text NOT NULL,
	`page_type` text NOT NULL,
	`minutes` real NOT NULL,
	`content` text NOT NULL,
	`notes` text NOT NULL,
	`sources` text NOT NULL,
	`warnings` text NOT NULL,
	`provider_id` text NOT NULL,
	`prev_content` text,
	`prev_notes` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`lesson_id`) REFERENCES `lessons`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`outline_version_id`) REFERENCES `outline_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `slides_version_spec_uq` ON `slides` (`outline_version_id`,`spec_id`);--> statement-breakpoint
CREATE INDEX `slides_lesson_hash_idx` ON `slides` (`lesson_id`,`spec_hash`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`username` text NOT NULL,
	`display_name` text,
	`password_hash` text NOT NULL,
	`role` text NOT NULL,
	`must_change_password` integer DEFAULT true NOT NULL,
	`disabled_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_uq` ON `users` (`username`);