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
