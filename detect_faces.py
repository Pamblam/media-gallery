#!/usr/bin/env python3
import os

import psycopg2
from dotenv import load_dotenv
from pgvector.psycopg2 import register_vector

from parse_faces import best_match

load_dotenv()

def main() -> int:
	conn = psycopg2.connect(
		host=os.environ["PGHOST"],
		port=os.environ["PGPORT"],
		dbname=os.environ["PGDATABASE"],
		user=os.environ["PGUSER"],
		password=os.environ["PGPASSWORD"],
	)
	conn.autocommit = True
	register_vector(conn)
	cur = conn.cursor()

	cur.execute(
		"""
		SELECT f.id, f.embedding, f.known_face_id
		FROM image_faces f
		JOIN media m ON m.id = f.image_id
		LEFT JOIN known_faces k ON k.id = f.known_face_id
		WHERE m.type = 'image'
			AND m.path NOT ILIKE '%.heic'
			AND (f.known_face_id IS NULL OR f.assigned_by = 'auto')
			AND (f.assigned_by IS NULL OR f.assigned_by != 'skipped')
			AND m.duplicate_of_id IS NULL
		"""
	)
	rows = cur.fetchall()

	updated = 0
	for face_id, embedding, known_face_id in rows:
		match = best_match(cur, embedding)
		if not match:
			continue
		new_known_face_id, _dist = match
		if known_face_id == new_known_face_id:
			continue

		cur.execute(
			"""
			UPDATE image_faces
			SET known_face_id = %s,
				assigned_by = 'auto',
				assigned_at = now()
			WHERE id = %s
			""",
			(new_known_face_id, face_id),
		)
		updated += 1

	print("UPDATED:", updated)

	cur.close()
	conn.close()
	return 0


if __name__ == "__main__":
	raise SystemExit(main())
