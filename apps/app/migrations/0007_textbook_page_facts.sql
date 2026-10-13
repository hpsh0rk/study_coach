ALTER TABLE `pages` ADD `chars` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `pages` ADD `parser` text DEFAULT 'pdfjs/1' NOT NULL;--> statement-breakpoint
ALTER TABLE `pages` ADD `flags` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
UPDATE `pages` SET `chars` = LENGTH(`text`);
