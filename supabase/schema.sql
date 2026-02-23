-- Run this in your Supabase SQL editor to set up the pages table.

create table if not exists pages (
  id          bigserial primary key,
  url         text not null unique,
  title       text,
  summary     text,
  keywords    text[],          -- array of keyword strings
  content     text,            -- full plain-text content of the page
  created_at  timestamptz default now()
);

-- Optional: full-text search index on content + title for faster keyword matching.
create index if not exists pages_content_fts
  on pages
  using gin(to_tsvector('english', coalesce(title, '') || ' ' || coalesce(content, '')));

-- ---------------------------------------------------------------------------
-- Suggestions table — stores backlink opportunities found by the analyzer.
-- Run this in your Supabase SQL editor.
--
-- target_url  : the newly published post that needs inbound links
-- source_url  : the existing page where the link should be placed
-- anchor_source: 'title' (phrase taken from post title) or 'variation'
-- status      : 'pending' | 'accepted' | 'dismissed'
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
  created_at            timestamptz default now(),
  constraint suggestions_target_source_unique unique (target_url, source_url)
);
