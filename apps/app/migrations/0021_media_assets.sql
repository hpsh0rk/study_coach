CREATE TABLE `media_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`document_id` text,
	`lesson_id` text,
	`page_no` integer,
	`label` text DEFAULT '' NOT NULL,
	`caption` text DEFAULT '' NOT NULL,
	`mime` text NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`size_bytes` integer NOT NULL,
	`data` blob NOT NULL,
	`sha256` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`lesson_id`) REFERENCES `lessons`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `media_assets_owner_idx` ON `media_assets` (`org_id`,`owner_id`);--> statement-breakpoint
CREATE INDEX `media_assets_doc_page_idx` ON `media_assets` (`document_id`,`page_no`);--> statement-breakpoint
CREATE INDEX `media_assets_lesson_idx` ON `media_assets` (`lesson_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `media_assets_dedup_uq` ON `media_assets` (`org_id`,`owner_id`,COALESCE(`document_id`, ''),COALESCE(`lesson_id`, ''),COALESCE(`page_no`, -1),`sha256`);
