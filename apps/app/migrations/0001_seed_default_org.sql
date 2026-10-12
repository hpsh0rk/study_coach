-- Single organisation for the friends-and-family beta; every table already carries org_id for later.
INSERT OR IGNORE INTO orgs (id, name, created_at) VALUES ('org_default', 'Default', unixepoch() * 1000);
