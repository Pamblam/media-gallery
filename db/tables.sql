-- Requires pgvector for embeddings
CREATE EXTENSION IF NOT EXISTS vector;

-- Optional: keep media type constrained
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'media_type') THEN
		CREATE TYPE media_type AS ENUM ('image', 'video');
	END IF;
END
$$;

CREATE TABLE IF NOT EXISTS media (
	id				BIGSERIAL PRIMARY KEY,
	path			TEXT NOT NULL UNIQUE,			-- relative path + filename
	type			media_type NOT NULL,
	hash			TEXT NOT NULL,					-- store as hex (sha256, blake3, etc.)
	gps_location	POINT,							-- (lon, lat) if present; else NULL
	original_date	TIMESTAMPTZ,					-- if present; else NULL
	size_bytes		BIGINT,							-- useful for sanity/ops
	mtime			TIMESTAMPTZ,					-- file modified time at ingest
	ingested_at		TIMESTAMPTZ NOT NULL DEFAULT now(),
	parsed_at		TIMESTAMPTZ,
	converted_to_id BIGINT REFERENCES media(id) ON DELETE SET NULL,
	duplicate_of_id BIGINT REFERENCES media(id) ON DELETE SET NULL,
	nsfw_score		REAL,							-- 0-1, highest explicit-label confidence; NULL if not checked
	nsfw_labels		TEXT[],							-- explicit labels found (nudenet class names)
	nsfw_checked_at	TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_media_hash ON media(hash);
CREATE INDEX IF NOT EXISTS idx_media_type ON media(type);

CREATE TABLE IF NOT EXISTS known_faces (
	id				BIGSERIAL PRIMARY KEY,
	name			TEXT NOT NULL UNIQUE,
	notes			TEXT,
	created_at		TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per detected face in an image
-- embedding: 512-d ArcFace-style vector (InsightFace default). Change dimension if you pick a different model.
CREATE TABLE IF NOT EXISTS image_faces (
	id				BIGSERIAL PRIMARY KEY,
	image_id			BIGINT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
	face_boundary		JSONB NOT NULL,				-- {"x":..,"y":..,"w":..,"h":..}
	embedding			VECTOR(512) NOT NULL,
	known_face_id		BIGINT REFERENCES known_faces(id) ON DELETE SET NULL,

	detection_confidence	REAL,
	assigned_by			TEXT NOT NULL DEFAULT 'unassigned',	-- 'manual' | 'auto' | 'unassigned'
	assigned_at			TIMESTAMPTZ,
	model_name			TEXT,
	model_version		TEXT,
	created_at			TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_image_faces_image_id ON image_faces(image_id);
CREATE INDEX IF NOT EXISTS idx_image_faces_known_face_id ON image_faces(known_face_id);

CREATE TABLE datasets (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    known_face_id INTEGER REFERENCES known_faces(id)
);

CREATE TABLE dataset_images (
    id SERIAL PRIMARY KEY,
    dataset_id INTEGER NOT NULL REFERENCES datasets(id),
    image_id INTEGER NOT NULL REFERENCES media(id)
);