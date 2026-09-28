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
-- Rotating is the one thing a token holder may NOT do. Every guest holds the same token as the host,
-- so the token cannot tell them apart; the host's app keeps a second secret of its own, only its
-- SHA-256 reaches this project (cf_shares.owner_hash), and cf_rotate_token refuses anyone who cannot
-- produce the original. Without that, any guest could issue a new code and lock the host out of
-- their own collection. For the same reason nobody can delete a share row through the API: the
-- delete would cascade to every item of the collection, for everyone.
--
-- UPGRADING from an older copy: take the script from the "Copy install SQL" button on the project's
-- row in the app's collaboration settings. That copy ends with a line per collection you already
-- share here, recording you as its host in the same run that introduces hosts — a share with no
-- host recorded goes to whoever claims it first. With a copy from anywhere else, press "Test
-- connection" on the project straight after running it; the app claims your shares then.
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
    -- SHA-256 (hex) of the host's own secret — see the security model above. A hash because every
    -- token holder can read this row; a digest of 256 random bits gives nothing away.
    owner_hash   text,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);

-- A project that ran an earlier copy of this script has the table without the column.
alter table cf_shares add column if not exists owner_hash text;

-- A token holder may update the share row (the host renames it), so without this a guest could write
-- the hash of a secret of their own over the host's and then rotate. Once recorded, the owner stays.
create or replace function cf_guard_owner() returns trigger
    language plpgsql
    as $$
    begin
        if old.owner_hash is not null and new.owner_hash is distinct from old.owner_hash then
            raise exception 'the host of a shared collection cannot be changed';
        end if;
        return new;
    end
    $$;

drop trigger if exists cf_shares_guard_owner on cf_shares;
create trigger cf_shares_guard_owner before update on cf_shares
    for each row execute function cf_guard_owner();

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

-- Read, create and update — and no delete. A share row is the parent of every item in the
-- collection, so deleting it through the API would wipe the collection for everyone; with no policy
-- for it, a delete simply matches nothing. (The owner of the Supabase project can still remove one
-- from the dashboard, which is not bound by these policies.)
--
-- The empty-token guard is the load-bearing half of each: without it, a client sending no header and
-- a row with an empty token would match, and the share would be world-readable.
drop policy if exists cf_shares_access on cf_shares;
drop policy if exists cf_shares_read on cf_shares;
drop policy if exists cf_shares_create on cf_shares;
drop policy if exists cf_shares_change on cf_shares;
create policy cf_shares_read on cf_shares
    for select
    using (cf_token() <> '' and share_token = cf_token());
create policy cf_shares_create on cf_shares
    for insert
    with check (cf_token() <> '' and share_token = cf_token());
create policy cf_shares_change on cf_shares
    for update
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

-- Records the host as the owner of a share that has none: every share created by an earlier copy of
-- this script, and every new one right after it is created. Only the first claim lands (the trigger
-- on cf_shares keeps it), which is why the host's app claims as soon as it sees this version.
-- Answers true when the caller holds the recorded owner secret — a repeat claim by the host is not
-- an error — and false when somebody else's is recorded.
create or replace function cf_claim_owner(owner_key text) returns boolean
    language plpgsql security definer
    set search_path = public
    as $$
    declare
        current_token text := cf_token();
        claimed text := encode(sha256(convert_to(coalesce(owner_key, ''), 'UTF8')), 'hex');
    begin
        if current_token = '' or coalesce(owner_key, '') = '' then
            return false;
        end if;
        update cf_shares set owner_hash = claimed
        where share_token = current_token and owner_hash is null;
        return exists (
            select 1 from cf_shares where share_token = current_token and owner_hash = claimed
        );
    end
    $$;

-- Revoking access means changing the token: everyone still holding the old one stops matching any
-- policy on their next request. Runs as definer because the caller is, by definition, about to
-- stop being able to see the row it is updating.
--
-- Host only: the caller has to present the secret whose hash the share recorded. The one-argument
-- version any token holder could call is dropped first — `create or replace` with a new signature
-- adds an overload beside the old one, and would have left the hole open.
drop function if exists cf_rotate_token(text);
create or replace function cf_rotate_token(new_token text, owner_key text) returns void
    language plpgsql security definer
    set search_path = public
    as $$
    declare
        current_token text := cf_token();
    begin
        if current_token = '' then
            raise exception 'no share token was supplied';
        end if;
        if coalesce(new_token, '') = '' or coalesce(owner_key, '') = '' then
            raise exception 'only the host of a shared collection can issue a new code';
        end if;
        update cf_shares set share_token = new_token, updated_at = now()
        where share_token = current_token
          and owner_hash = encode(sha256(convert_to(owner_key, 'UTF8')), 'hex');
        if not found then
            raise exception 'only the host of a shared collection can issue a new code';
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

-- ---------------------------------------------------------------------------
-- Version
-- ---------------------------------------------------------------------------

-- Which copy of this script the project runs. The app compares it with the version it was built for
-- and asks the host to run the script again when the project's is older. A project without this
-- function runs version 1. Raise it with every change the app depends on.
create or replace function cf_schema_version() returns integer
    language sql immutable
    as $$
        select 2
    $$;
