CREATE TABLE `slide_locks` (
	`outline_version_id` text NOT NULL,
	`spec_id` text NOT NULL,
	`until` integer NOT NULL,
	PRIMARY KEY(`outline_version_id`, `spec_id`)
);
