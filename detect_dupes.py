#!/usr/bin/env python3
import os

import psycopg2
from dotenv import load_dotenv

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
	cur = conn.cursor()

	cur.execute(
		"""
		WITH ranked AS (
			SELECT id, hash, MIN(id) OVER (PARTITION BY hash) AS first_id
			FROM media
		)
		UPDATE media m
		SET duplicate_of_id = r.first_id
		FROM ranked r
		WHERE m.id = r.id AND r.id <> r.first_id
		"""
	)

	print("UPDATED:", cur.rowcount)

	cur.close()
	conn.close()
	return 0


if __name__ == "__main__":
	raise SystemExit(main())
