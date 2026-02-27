-- Run this in your Supabase SQL editor to set up the pages table.

create table if not exists pages (
  id           bigserial primary key,
  url          text not null unique,
  title        text,
  summary      text,
  keywords     text[],          -- array of keyword strings
  content      text,            -- full plain-text content of the page
  analyzed_at  timestamptz,     -- set after backlink analysis has run for this page
  created_at   timestamptz default now()
);

-- If the table already exists, add the column without recreating it:
alter table pages add column if not exists analyzed_at timestamptz;

-- Optional: full-text search index on content + title for faster keyword matching.
create index if not exists pages_content_fts
  on pages
  using gin(to_tsvector('english', coalesce(title, '') || ' ' || coalesce(content, '')));

-- ---------------------------------------------------------------------------
-- Suggestions table — stores backlink opportunities found by the analyzer.
--
-- target_url   : the newly published post that needs inbound links
-- source_url   : the existing page where the link should be placed
-- anchor_source: 'title' (phrase taken from post title) or 'variation'
-- status       : 'pending' | 'accepted' | 'dismissed'
-- link_checked : true once the source page has been fetched and confirmed
--                not to already link to the target (set by process-suggestions)
-- The unique constraint on (target_url, source_url) means re-running
-- analysis updates existing rows rather than creating duplicates.
-- ---------------------------------------------------------------------------

create table if not exists suggestions (
  id                    bigserial primary key,
  target_url            text not null,
  target_title          text,
  source_url            text not null,
  source_title          text,
  suggested_anchor_text text,
  anchor_source         text,
  context               text,
  reason                text,
  status                text not null default 'pending',
  link_checked          boolean not null default false,
  created_at            timestamptz default now(),
  constraint suggestions_target_source_unique unique (target_url, source_url)
);

-- If the table already exists, add the column without recreating it:
alter table suggestions add column if not exists link_checked boolean not null default false;

-- ---------------------------------------------------------------------------
-- Sentences table — one row per sentence from each indexed page.
-- Queried with ilike to find candidate backlink placements without loading
-- full page content. Populated by the cron indexer and buildSentences.js.
-- ---------------------------------------------------------------------------

-- Trigram extension required for fast ilike searches on sentence text.
create extension if not exists pg_trgm;

create table if not exists sentences (
  id             bigserial primary key,
  page_url       text not null,
  page_title     text,
  sentence       text not null,
  existing_links text[] not null default '{}',  -- normalised hrefs already in this sentence
  created_at     timestamptz default now()
);

-- If the table already exists, add the column without recreating it:
alter table sentences add column if not exists existing_links text[] not null default '{}';

-- Trigram index for fast ilike keyword searches across sentence text.
create index if not exists sentences_sentence_trgm
  on sentences using gin(sentence gin_trgm_ops);

-- Index for fast delete/replace when re-indexing a page.
create index if not exists sentences_page_url_idx
  on sentences (page_url);
