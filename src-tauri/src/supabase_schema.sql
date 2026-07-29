-- CodeFlow — shared API collections
--
-- Paste this whole script into your Supabase project's SQL editor and run it once. It is
-- idempotent: running it again after an update is safe.
--
-- SECURITY MODEL, in one paragraph, because everything below depends on it.
--
-- The project's anon key is public by design — it identifies the project, it does not authorise
-- anything. What authorises access here is the SHARE TOKEN: a random secret minted per shared
-- collection, sent by the client in the `x-cf-share` header, and compared inside every
-- row-level-security policy. A client holding only the anon key matches no row and reads nothing.
-- Whoever holds a collection's share token can read and write that collection, and nothing else.
-- That is exactly the "anyone with the link can work on this with me" model, made explicit: the
-- token IS the link, so treat it like a password, and rotate it (see cf_rotate_token below) when
-- someone should lose access.
--
-- Nothing here uses Supabase Auth. There are no accounts to manage and no per-user roles — a
-- deliberate trade for a collaboration model whose whole premise is a shareable link.
--
-- WHAT IS SHARED IS ONE COLLECTION. Earlier builds shared a whole workspace, which meant accepting
-- an invitation adopted somebody else's entire sidebar — environments, unrelated collections and
-- all. A collection is the unit a team actually works on together, and it is the unit that can be
-- dropped into a workspace you already have.

-- ---------------------------------------------------------------------------
-- Migration off the workspace-shaped tables
-- ---------------------------------------------------------------------------

-- `create table if not exists` cannot reshape a table that is already there, and the old `cf_items`
-- is keyed on a `workspace_id` that no longer means anything. Dropped rather than migrated: a share
-- is re-created from the host's local copy in one push, so there is nothing here worth the risk of
-- a half-translated rename.
do $$
begin
    if exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'cf_items' and column_name = 'workspace_id'
    ) then
        drop table if exists cf_items cascade;
        drop table if exists cf_workspaces cascade;
    end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists cf_shares (
    -- The collection's own id, so a share and the collection it publishes are the same row
    -- everywhere and no mapping table is needed on either side.
    id           uuid primary key,
    name         text not null,
    -- The credential. Unique so a token can never resolve to two shares.
    share_token  text not null unique,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);

-- One row per collection, folder or request, carrying the record verbatim as CodeFlow stores it.
-- Deliberately not three mirrored tables: the client's shapes change with every new protocol or
-- auth mode, and a schema that mirrored them would need a migration here — run by hand, by every
-- host — each time.
create table if not exists cf_items (
    id           uuid primary key,
    share_id     uuid not null references cf_shares(id) on delete cascade,
    kind         text not null check (kind in ('collection', 'folder', 'request')),
    payload      jsonb not null,
    -- Three-way merge is resolved on this, so it is the client's own timestamp, not now().
    updated_at   timestamptz not null,
    -- When the server saw the row. Paging "what changed since I last looked" on `updated_at` would
    -- be a bug: that clock belongs to whoever wrote the row, so a teammate whose laptop is five
    -- minutes slow writes a record that is already behind everyone's cursor, and nobody ever pulls
    -- it. This column is the server's own clock and only ever moves forward.
    synced_at    timestamptz not null default now(),
    -- Tombstone. A deletion has to be a row: "absent" and "not created yet" are the same thing to
    -- a client that is pulling changes since a point in time.
    deleted      boolean not null default false
);

-- A default only fires on insert, and every write here is an upsert; without the trigger an
-- updated row would keep the `synced_at` of its creation and stay invisible to every peer's cursor.
create or replace function cf_touch() returns trigger
    language plpgsql
    as $$
    begin
        new.synced_at = now();
        return new;
    end
    $$;

drop trigger if exists cf_items_touch on cf_items;
create trigger cf_items_touch before insert or update on cf_items
    for each row execute function cf_touch();

-- Serves both hot paths: the cursor pull (`synced_at > since`) and the watermark probe that runs
-- every few seconds and only ever reads the newest `synced_at` of one share.
create index if not exists cf_items_sync on cf_items (share_id, synced_at desc);

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

-- PostgREST puts every request header into this GUC, lowercased. `true` makes a missing setting
-- return NULL instead of raising, which is what happens on a request with no header at all.
create or replace function cf_token() returns text
    language sql stable
    as $$
        select coalesce(current_setting('request.headers', true)::json ->> 'x-cf-share', '')
    $$;

alter table cf_shares enable row level security;
alter table cf_items enable row level security;

-- Force RLS so that even a privileged role reaching in through PostgREST is held to the policies.
alter table cf_shares force row level security;
alter table cf_items force row level security;

drop policy if exists cf_shares_access on cf_shares;
create policy cf_shares_access on cf_shares
    for all
    -- The empty-token guard is the load-bearing half: without it, a client sending no header and a
    -- row with an empty token would match, and the share would be world-readable.
    using (cf_token() <> '' and share_token = cf_token())
    with check (cf_token() <> '' and share_token = cf_token());

drop policy if exists cf_items_access on cf_items;
create policy cf_items_access on cf_items
    for all
    using (
        cf_token() <> ''
        and exists (
            select 1 from cf_shares s
            where s.id = cf_items.share_id and s.share_token = cf_token()
        )
    )
    with check (
        cf_token() <> ''
        and exists (
            select 1 from cf_shares s
            where s.id = cf_items.share_id and s.share_token = cf_token()
        )
    );

-- ---------------------------------------------------------------------------
-- Rotation
-- ---------------------------------------------------------------------------

-- Revoking access means changing the token: everyone still holding the old one stops matching any
-- policy on their next request. Runs as definer because the caller is, by definition, about to
-- stop being able to see the row it is updating.
create or replace function cf_rotate_token(new_token text) returns void
    language plpgsql security definer
    set search_path = public
    as $$
    declare
        current_token text := cf_token();
    begin
        if current_token = '' then
            raise exception 'no share token was supplied';
        end if;
        update cf_shares set share_token = new_token, updated_at = now()
        where share_token = current_token;
        if not found then
            raise exception 'that share token does not match a shared collection';
        end if;
    end
    $$;

-- Lets a client confirm the schema is installed and the token resolves, in one round trip, without
-- reading any content.
create or replace function cf_ping() returns text
    language sql stable
    as $$
        select coalesce((select name from cf_shares where share_token = cf_token()), '')
    $$;
