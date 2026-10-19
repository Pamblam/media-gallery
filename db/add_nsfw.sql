-- Adds NSFW detection columns to an existing media table (new installs get them from tables.sql)
-- Run as the table owner, e.g. with the .env connection: set -a; . ./.env; set +a; psql -f db/add_nsfw.sql

ALTER TABLE media ADD COLUMN IF NOT EXISTS nsfw_score		REAL;
ALTER TABLE media ADD COLUMN IF NOT EXISTS nsfw_labels		TEXT[];
ALTER TABLE media ADD COLUMN IF NOT EXISTS nsfw_checked_at	TIMESTAMPTZ;
