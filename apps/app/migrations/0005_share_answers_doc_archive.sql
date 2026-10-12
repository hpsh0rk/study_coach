ALTER TABLE `documents` ADD `archived_at` integer;--> statement-breakpoint
ALTER TABLE `share_links` ADD `answers` text DEFAULT 'hidden' NOT NULL;