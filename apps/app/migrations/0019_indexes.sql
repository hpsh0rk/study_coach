CREATE INDEX IF NOT EXISTS `lessons_document_idx` ON `lessons` (`document_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ai_calls_user_time_idx` ON `ai_calls` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `sessions_expires_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `slide_locks_until_idx` ON `slide_locks` (`until`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `login_attempts_window_idx` ON `login_attempts` (`window_start`);
