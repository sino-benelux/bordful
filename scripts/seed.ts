/**
 * Seed script: imports `Grid view.csv` (an Airtable export) into Turso.
 *
 * Usage:
 *   TURSO_DATABASE_URL=libsql://... TURSO_AUTH_TOKEN=... bun run scripts/seed.ts
 *   (or with node + tsx: TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... npx tsx scripts/seed.ts)
 *
 * The CSV columns map 1:1 to the `jobs` table. Multi-select fields are stored
 * as JSON arrays; checkboxes as 0/1; empty strings become NULL.
 */
import { createClient } from '@libsql/client';
import { parse } from 'csv-parse/sync';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;

if (!url) {
  throw new Error('TURSO_DATABASE_URL is required');
}

const CSV_PATH = resolve(process.cwd(), 'Grid view.csv');

const JSON_FIELDS = ['career_level', 'languages'] as const;
const BOOL_FIELDS = ['featured'] as const;

// All columns that exist in the table (matches the CSV header).
const COLUMNS = [
  'title',
  'company',
  'workplace_type',
  'remote_region',
  'timezone_requirements',
  'workplace_city',
  'workplace_country',
  'type',
  'salary_min',
  'salary_max',
  'salary_currency',
  'salary_unit',
  'description',
  'apply_url',
  'job_source_name',
  'posted_date',
  'valid_through',
  'status',
  'career_level',
  'visa_sponsorship',
  'featured',
  'languages',
  'benefits',
  'application_requirements',
  'job_identifier',
  'skills',
  'qualifications',
  'education_requirements',
  'experience_requirements',
  'industry',
  'occupational_category',
  'responsibilities',
  'apply_method',
  'department',
  'travel_required',
  'sourced_at',
  'source_url',
  'airtable_id',
] as const;

function toDbValue(value: string | undefined, field: string): string | number | null {
  if (value === undefined || value === null) {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }

  if ((JSON_FIELDS as readonly string[]).includes(field)) {
    // Airtable exports multi-select as a pipe-separated list.
    const parts = trimmed.split('|').map((part) => part.trim());
    return JSON.stringify(parts);
  }

  if ((BOOL_FIELDS as readonly string[]).includes(field)) {
    // Airtable checkbox exports as 'x' or 'true'.
    return /^(x|true|1|yes)$/i.test(trimmed) ? 1 : 0;
  }

  return trimmed;
}

function buildInsert(row: Record<string, string | undefined>) {
  const values = COLUMNS.map((col) => toDbValue(row[col], col));

  const placeholders = COLUMNS.map(() => '?').join(', ');
  const assignments = COLUMNS.map((col) => `${col} = excluded.${col}`).join(', ');

  const sql = `
    INSERT INTO jobs (${COLUMNS.join(', ')})
    VALUES (${placeholders})
    ON CONFLICT (airtable_id) DO UPDATE SET ${assignments}
  `;

  return { sql, values };
}

async function main() {
  console.log(`Reading ${CSV_PATH} ...`);
  const file = readFileSync(CSV_PATH, 'utf-8');

  const records = parse(file, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
  }) as Array<Record<string, string | undefined>>;

  console.log(`Parsed ${records.length} rows.`);

  const client = createClient({ url, authToken: authToken || undefined });

  console.log('Creating schema (if not exists) ...');
  await client.execute(`
    CREATE TABLE IF NOT EXISTS jobs (
      id                       TEXT PRIMARY KEY,
      title                    TEXT NOT NULL,
      company                  TEXT NOT NULL,
      workplace_type           TEXT,
      remote_region            TEXT,
      timezone_requirements    TEXT,
      workplace_city           TEXT,
      workplace_country        TEXT,
      type                     TEXT,
      salary_min               REAL,
      salary_max               REAL,
      salary_currency          TEXT,
      salary_unit              TEXT,
      description              TEXT,
      apply_url                TEXT,
      job_source_name          TEXT,
      posted_date              TEXT,
      valid_through            TEXT,
      status                   TEXT,
      career_level             TEXT,
      visa_sponsorship         TEXT,
      featured                 INTEGER DEFAULT 0,
      languages                TEXT,
      benefits                 TEXT,
      application_requirements TEXT,
      job_identifier           TEXT,
      skills                   TEXT,
      qualifications           TEXT,
      education_requirements   TEXT,
      experience_requirements  TEXT,
      industry                 TEXT,
      occupational_category    TEXT,
      responsibilities         TEXT,
      apply_method             TEXT,
      department               TEXT,
      travel_required          TEXT,
      sourced_at               TEXT,
      source_url               TEXT,
      airtable_id              TEXT UNIQUE
    );
  `);

  await client.execute(`
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS idx_jobs_posted_date ON jobs(posted_date DESC);
  `);

  console.log('Upserting rows ...');
  for (const row of records) {
    if (!row.airtable_id) {
      continue;
    }
    const { sql, values } = buildInsert(row);
    await client.execute({ sql, args: values });
  }

  const { rows } = await client.execute(`
    SELECT status, COUNT(*) as count FROM jobs GROUP BY status ORDER BY count DESC;
  `);
  console.log('Seed complete. Row counts by status:');
  for (const r of rows) {
    console.log(`  ${String(r.status) || '(no status)'}: ${r.count}`);
  }

  client.close();
}

main().catch((error) => {
  console.error('Seeding failed:', error);
  process.exit(1);
});
