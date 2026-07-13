create extension if not exists pgcrypto;

create table if not exists public.table_datasets (
  id uuid primary key default gen_random_uuid(),
  file_name text not null,
  file_hash text not null unique,
  row_count integer not null default 0,
  sheet_names jsonb not null default '[]'::jsonb,
  sheets_json jsonb not null default '[]'::jsonb,
  storage_path text,
  parsed_json_path text,
  created_at timestamptz not null default now()
);

alter table public.table_datasets add column if not exists parsed_json_path text;
alter table public.table_datasets enable row level security;


drop policy if exists "table_datasets_select_public" on public.table_datasets;
create policy "table_datasets_select_public"
on public.table_datasets
for select
using (true);

drop policy if exists "table_datasets_insert_public" on public.table_datasets;
create policy "table_datasets_insert_public"
on public.table_datasets
for insert
with check (true);

drop policy if exists "table_datasets_update_public" on public.table_datasets;
create policy "table_datasets_update_public"
on public.table_datasets
for update
using (true)
with check (true);

insert into storage.buckets (id, name, public)
values ('table-files', 'table-files', true)
on conflict (id) do nothing;

drop policy if exists "storage_table_files_select_public" on storage.objects;
create policy "storage_table_files_select_public"
on storage.objects
for select
using (bucket_id = 'table-files');

drop policy if exists "storage_table_files_insert_public" on storage.objects;
create policy "storage_table_files_insert_public"
on storage.objects
for insert
with check (bucket_id = 'table-files');

drop policy if exists "storage_table_files_update_public" on storage.objects;
create policy "storage_table_files_update_public"
on storage.objects
for update
using (bucket_id = 'table-files')
with check (bucket_id = 'table-files');
