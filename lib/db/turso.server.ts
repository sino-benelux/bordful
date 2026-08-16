import 'server-only';

import { createClient } from '@libsql/client';
import { cache } from 'react';
import {
  CURRENCY_CODES,
  type CurrencyCode,
  getCurrencyByName,
} from '@/lib/constants/currencies';
import {
  getLanguageByName,
  LANGUAGE_CODES,
  type LanguageCode,
} from '@/lib/constants/languages';
import type { RemoteRegion, WorkplaceType } from '@/lib/constants/workplace';
import { normalizeMarkdown } from '@/lib/utils/markdown';
import type { CareerLevel, Job, SalaryUnit } from '@/lib/db/airtable';

type TursoClient = ReturnType<typeof createClient>;

// Cache the client so it's only created once per server lifetime
const getTursoClient = cache((): TursoClient | null => {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;

  if (!url) {
    return null;
  }

  try {
    return createClient({
      url,
      authToken: authToken || undefined,
    });
  } catch {
    return null;
  }
});

const TABLE_NAME = process.env.TURSO_TABLE_NAME || 'jobs';

// Ensure career level is always returned as an array
function normalizeCareerLevel(value: unknown): CareerLevel[] {
  if (!value) {
    return ['NotSpecified'];
  }

  if (Array.isArray(value)) {
    // Convert Airtable's display values to our enum values
    return value.map((level) => {
      // Handle Airtable's display format (e.g., "Entry Level" -> "EntryLevel")
      const normalized = level.replace(/\s+/g, '');
      return normalized as CareerLevel;
    });
  }

  // Handle single value
  const normalized = (value as string).replace(/\s+/g, '');
  return [normalized as CareerLevel];
}

function normalizeWorkplaceType(value: unknown): WorkplaceType {
  if (
    typeof value === 'string' &&
    ['On-site', 'Hybrid', 'Remote'].includes(value)
  ) {
    return value as WorkplaceType;
  }

  return 'Not specified';
}

function normalizeRemoteRegion(value: unknown): RemoteRegion {
  if (typeof value === 'string') {
    const validRegions = [
      'Worldwide',
      'Americas Only',
      'Europe Only',
      'Asia-Pacific Only',
      'US Only',
      'EU Only',
      'UK/EU Only',
      'US/Canada Only',
    ];
    if (validRegions.includes(value)) {
      return value as RemoteRegion;
    }
  }
  return null;
}

// Normalize language data. Stored as a JSON-encoded array of strings
// (e.g. '["English (en)","Spanish (es)"]') or as a pipe/comma-separated string.
function normalizeLanguages(value: unknown): LanguageCode[] {
  if (!value) {
    return [];
  }

  let items: string[] = [];

  if (Array.isArray(value)) {
    items = value;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return [];
    }

    // Try JSON first (stored as an array)
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        items = parsed;
      }
    } catch {
      // Not JSON - fall through to separator-based parsing
    }

    // Fall back to pipe or comma-separated values
    if (items.length === 0) {
      items = trimmed
        .split(/[|,]/)
        .map((item) => item.trim())
        .filter(Boolean);
    }
  }

  return items
    .map((item) => {
      if (typeof item === 'string') {
        // Extract code from "Language Name (code)" format
        const languageCodeMatch = /.*?\(([a-z]{2})\)$/i.exec(item);
        if (languageCodeMatch?.[1]) {
          const extractedCode = languageCodeMatch[1].toLowerCase();
          if (LANGUAGE_CODES.includes(extractedCode as LanguageCode)) {
            return extractedCode as LanguageCode;
          }
        }

        // String itself is a valid 2-letter code
        if (
          item.length === 2 &&
          LANGUAGE_CODES.includes(item.toLowerCase() as LanguageCode)
        ) {
          return item.toLowerCase() as LanguageCode;
        }

        // Try to look up by language name
        const language = getLanguageByName(item);
        if (language) {
          return language.code as LanguageCode;
        }
      }

      return null;
    })
    .filter((code): code is LanguageCode => code !== null);
}

// Normalize currency data. Stored as a string, e.g. "USD (United States Dollar)".
function normalizeCurrency(value: unknown): CurrencyCode {
  if (!value) {
    return 'USD';
  }

  if (typeof value === 'string') {
    // Extract code from "USD (United States Dollar)" format
    const currencyCodeMatch = /^([A-Z]{2,5})\s*\(.*?\)$/i.exec(value);
    if (currencyCodeMatch?.[1]) {
      const extractedCode = currencyCodeMatch[1].toUpperCase();
      if (CURRENCY_CODES.includes(extractedCode as CurrencyCode)) {
        return extractedCode as CurrencyCode;
      }
    }

    // String itself is a valid currency code
    const upperCaseValue = value.toUpperCase();
    if (CURRENCY_CODES.includes(upperCaseValue as CurrencyCode)) {
      return upperCaseValue as CurrencyCode;
    }

    // Try to look up by currency name
    const currency = getCurrencyByName(value);
    if (currency) {
      return currency.code;
    }
  }

  return 'USD';
}

function normalizeBenefits(value: unknown): string | null {
  if (!value) {
    return null;
  }

  const benefitsText = String(value).trim();
  if (!benefitsText) {
    return null;
  }

  const MAX_BENEFITS_LENGTH = 1000;
  if (benefitsText.length > MAX_BENEFITS_LENGTH) {
    return benefitsText.substring(0, MAX_BENEFITS_LENGTH).trim();
  }

  return benefitsText;
}

function normalizeApplicationRequirements(value: unknown): string | null {
  if (!value) {
    return null;
  }

  const requirementsText = String(value).trim();
  if (!requirementsText) {
    return null;
  }

  const MAX_REQUIREMENTS_LENGTH = 1000;
  if (requirementsText.length > MAX_REQUIREMENTS_LENGTH) {
    return requirementsText.substring(0, MAX_REQUIREMENTS_LENGTH).trim();
  }

  return requirementsText;
}

function normalizeVisaSponsorship(
  value: unknown
): 'Yes' | 'No' | 'Not specified' {
  if (!value) {
    return 'Not specified';
  }

  if (typeof value === 'string') {
    const normalizedValue = value.trim();
    if (/^yes$/i.test(normalizedValue)) {
      return 'Yes';
    }
    if (/^no$/i.test(normalizedValue)) {
      return 'No';
    }
  }

  return 'Not specified';
}

// Job mapping shared between getJobs and getJob.
// `row` is a snake_case record from the `jobs` table (mirrors the CSV schema).
function rowToJob(row: Record<string, unknown>): Job {
  const salaryMin = row.salary_min ? Number(row.salary_min) : null;
  const salaryMax = row.salary_max ? Number(row.salary_max) : null;
  const rawUnit = (row.salary_unit as string) || '';
  const validUnits: SalaryUnit[] = [
    'hour',
    'day',
    'week',
    'month',
    'year',
    'project',
  ];
  // Guard against an empty salary_unit (the CSV has rows with salary but no unit).
  const salaryUnit: SalaryUnit = validUnits.includes(rawUnit as SalaryUnit)
    ? (rawUnit as SalaryUnit)
    : 'year';

  return {
    id: (row.airtable_id as string) || (row.id as string),
    title: row.title as string,
    company: row.company as string,
    type: row.type as Job['type'],
    salary:
      salaryMin || salaryMax
        ? {
            min: salaryMin,
            max: salaryMax,
            currency: normalizeCurrency(row.salary_currency),
            unit: salaryUnit,
          }
        : null,
    description: normalizeMarkdown(row.description as string),
    benefits: normalizeBenefits(row.benefits),
    application_requirements: normalizeApplicationRequirements(
      row.application_requirements
    ),
    apply_url: row.apply_url as string,
    posted_date: row.posted_date as string,
    valid_through: (row.valid_through as string) || null,
    job_identifier: (row.job_identifier as string) || null,
    job_source_name: (row.job_source_name as string) || null,
    status: row.status as Job['status'],
    career_level: normalizeCareerLevel(row.career_level),
    visa_sponsorship: normalizeVisaSponsorship(row.visa_sponsorship),
    featured: !!row.featured,
    workplace_type: normalizeWorkplaceType(row.workplace_type),
    remote_region: normalizeRemoteRegion(row.remote_region),
    timezone_requirements: (row.timezone_requirements as string) || null,
    workplace_city: (row.workplace_city as string) || null,
    workplace_country: (row.workplace_country as string) || null,
    languages: normalizeLanguages(row.languages),
    skills: (row.skills as string) || null,
    qualifications: (row.qualifications as string) || null,
    education_requirements: (row.education_requirements as string) || null,
    experience_requirements: (row.experience_requirements as string) || null,
    industry: (row.industry as string) || null,
    occupational_category: (row.occupational_category as string) || null,
    responsibilities: (row.responsibilities as string) || null,
  };
}

// Fetch all published jobs, newest first (mirrors the Airtable query).
export const getJobs = cache(async (): Promise<Job[]> => {
  const client = getTursoClient();
  if (!client) {
    return [];
  }

  try {
    const result = await client.execute({
      sql: `SELECT * FROM ${TABLE_NAME} WHERE status = 'active' ORDER BY posted_date DESC`,
      args: [],
    });

    return result.rows.map((row) => rowToJob(row as Record<string, unknown>));
  } catch {
    return [];
  }
});

// Fetch a single job by its stable id (airtable_id).
export const getJob = cache(async (id: string): Promise<Job | null> => {
  const client = getTursoClient();
  if (!client) {
    return null;
  }

  try {
    const result = await client.execute({
      sql: `SELECT * FROM ${TABLE_NAME} WHERE airtable_id = ? LIMIT 1`,
      args: [id],
    });

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    const job = rowToJob(row as Record<string, unknown>);
    if (job.status !== 'active') {
      return null;
    }

    return job;
  } catch {
    return null;
  }
});

export async function testConnection(): Promise<boolean> {
  const client = getTursoClient();
  if (!client) {
    return false;
  }

  try {
    await client.execute({
      sql: `SELECT 1 FROM ${TABLE_NAME} LIMIT 1`,
      args: [],
    });
    return true;
  } catch {
    return false;
  }
}
