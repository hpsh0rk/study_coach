-- MinerU token mode is gone: organisations that chose it go back to the token-free agent API.
UPDATE `parser_settings` SET `mineru_mode` = 'agent' WHERE `mineru_mode` = 'token';--> statement-breakpoint
ALTER TABLE `parser_settings` DROP COLUMN `mineru_token_sealed`;--> statement-breakpoint
ALTER TABLE `parser_settings` DROP COLUMN `mineru_token_hint`;
