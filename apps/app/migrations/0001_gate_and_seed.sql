-- Confirmed outline versions are immutable: the generation gate relies on this.
CREATE TRIGGER outline_versions_confirmed_no_update
BEFORE UPDATE ON outline_versions
WHEN OLD.confirmed_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'OUTLINE_VERSION_IMMUTABLE');
END;
--> statement-breakpoint
CREATE TRIGGER outline_versions_confirmed_no_delete
BEFORE DELETE ON outline_versions
WHEN OLD.confirmed_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'OUTLINE_VERSION_IMMUTABLE');
END;
--> statement-breakpoint
-- Slides may only exist for confirmed versions.
CREATE TRIGGER slides_require_confirmed_insert
BEFORE INSERT ON slides
WHEN (SELECT confirmed_at FROM outline_versions WHERE id = NEW.outline_version_id) IS NULL
BEGIN
  SELECT RAISE(ABORT, 'OUTLINE_NOT_CONFIRMED');
END;
--> statement-breakpoint
INSERT OR IGNORE INTO orgs (id, name, created_at) VALUES ('org_default', 'Default', 0);
