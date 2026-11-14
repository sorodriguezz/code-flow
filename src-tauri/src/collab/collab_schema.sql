-- CodeFlow: shared workspace chats (collab sessions).
--
-- CodeFlow has no Supabase of its own. Whoever hosts a shared chat runs this script, once, in a
-- Supabase project of their own (a free one is enough), from that project's SQL editor; their guests
-- connect to that project through the invitation link. It stands alone: it needs nothing from the API
-- client's `supabase_schema.sql`, and can share a project with it or have one to itself. Idempotent,
-- so running it again after a CodeFlow update is how the project is brought up to date.
--
-- Not yet run against a real project: see `.claude/plans/multiplayer-chat.md`.
--
-- SECURITY MODEL, in one paragraph.
--
-- There are no accounts. A person is a NICK plus a KEY: 32 random bytes their CodeFlow mints on joining
-- and sends in the `x-cf-person` header. This project stores only the key's SHA-256
-- (cf_collab_people.key_hash), so a dump of it lets nobody act as anyone. Each person has their own key,
-- so the host can remove one person without touching the others. The host additionally holds an OWNER
-- SECRET (its hash in cf_collab_sessions.owner_hash), which is what inviting, removing people,
-- advancing the base and ending the session require. An invitation is a single-use token, also stored
-- only as a hash, that cf_collab_join exchanges for a person row.
--
-- Row-level security is ENABLED but not FORCED on these tables. The security-definer functions below
-- run as the tables' owner and must read past the policies: cf_collab_me reads cf_collab_people,
-- whose own policy calls cf_collab_me. Forcing RLS would hold the owner to the policies and recurse.
-- Every write goes through a function that checks who is asking. The policies only grant reads, plus
-- inserts of blobs and of one's own messages.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists cf_collab_sessions (
    id          uuid primary key,
    name        text not null,
    owner_hash  text not null,
    created_at  timestamptz not null default now(),
    ended_at    timestamptz
);

-- The live channel (version 2): the secret a session's Realtime Broadcast topic is derived from and
-- its messages are encrypted with, on each machine. Only members read it (cf_collab_watermark), and
-- removing a person rotates it, so they stop hearing keystrokes as well as stop syncing files.
-- Two random UUIDs rather than gen_random_bytes, which would need pgcrypto.
alter table cf_collab_sessions add column if not exists channel_key text not null
    default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');

create table if not exists cf_collab_people (
    id          uuid primary key default gen_random_uuid(),
    session_id  uuid not null references cf_collab_sessions(id) on delete cascade,
    nick        text not null check (char_length(nick) between 1 and 40),
    key_hash    text not null unique,
    role        text not null default 'editor' check (role in ('owner', 'editor')),
    joined_at   timestamptz not null default now(),
    last_seen   timestamptz not null default now(),
    removed_at  timestamptz
);
-- One live person per nick per session: the nick is the only way people tell each other apart.
create unique index if not exists cf_collab_people_nick
    on cf_collab_people (session_id, lower(nick)) where removed_at is null;

create table if not exists cf_collab_invites (
    token_hash  text primary key,
    session_id  uuid not null references cf_collab_sessions(id) on delete cascade,
    expires_at  timestamptz not null,
    used_by     uuid references cf_collab_people(id) on delete set null,
    used_at     timestamptz
);

-- A repository in the session, named by its canonical remote (`repo_identity::canonical_remote`) so
-- each peer finds it whatever folder they keep it in. `epoch` moves each time the base advances.
create table if not exists cf_collab_repos (
    session_id  uuid not null references cf_collab_sessions(id) on delete cascade,
    repo_key    text not null,
    name        text not null,
    base_sha    text not null check (base_sha ~ '^[0-9a-f]{40,64}$'),
    epoch       integer not null default 0,
    primary key (session_id, repo_key)
);

-- Each file's state over the base, with a version for optimistic concurrency (cf_collab_put_file).
-- The path rule repeats `collab::worktree::safe_relative` so a modified client still cannot record a
-- path that would escape a peer's worktree.
create table if not exists cf_collab_files (
    session_id  uuid not null,
    repo_key    text not null,
    path        text not null check (
        path <> ''
        and path !~* '(^/|(^|/)\.\.(/|$)|\\|:|(^|/)\.git(/|$))'
    ),
    state       text not null check (state in ('base', 'present', 'deleted')),
    sha         text check (sha is null or sha ~ '^[0-9a-f]{64}$'),
    size        bigint,
    is_binary   boolean not null default false,
    version     bigint not null,
    updated_by  uuid references cf_collab_people(id) on delete set null,
    updated_at  timestamptz not null default now(),
    primary key (session_id, repo_key, path),
    foreign key (session_id, repo_key) references cf_collab_repos(session_id, repo_key) on delete cascade,
    check ((state = 'present') = (sha is not null))
);
create index if not exists cf_collab_files_changed on cf_collab_files (session_id, updated_at);

-- File contents by hash. Clients check the hash on arrival (`write_state`) before writing a byte.
create table if not exists cf_collab_blobs (
    session_id   uuid not null references cf_collab_sessions(id) on delete cascade,
    sha          text not null check (sha ~ '^[0-9a-f]{64}$'),
    content_b64  text not null,
    primary key (session_id, sha)
);

-- The shared thread: chat messages, turn events, joins. `id` makes a retried insert harmless.
create table if not exists cf_collab_messages (
    seq         bigserial primary key,
    id          uuid not null unique,
    session_id  uuid not null references cf_collab_sessions(id) on delete cascade,
    person_id   uuid references cf_collab_people(id) on delete set null,
    kind        text not null,
    body        jsonb not null,
    created_at  timestamptz not null default now()
);
create index if not exists cf_collab_messages_session on cf_collab_messages (session_id, seq);

-- One turn at a time per repository (decision 9): a turn holds every repository in its scope,
-- turns on disjoint repositories run side by side. A lock expires on its own if its holder vanishes.
create table if not exists cf_collab_locks (
    session_id  uuid not null references cf_collab_sessions(id) on delete cascade,
    repo_key    text not null,
    person_id   uuid not null references cf_collab_people(id) on delete cascade,
    turn_id     text not null,
    expires_at  timestamptz not null,
    primary key (session_id, repo_key)
);

-- ---------------------------------------------------------------------------
-- Who is asking
-- ---------------------------------------------------------------------------

create or replace function cf_collab_key() returns text
    language sql stable
    as $$
        select coalesce(current_setting('request.headers', true)::json ->> 'x-cf-person', '')
    $$;

create or replace function cf_collab_hash(secret text) returns text
    language sql immutable
    as $$
        select encode(sha256(convert_to(secret, 'UTF8')), 'hex')
    $$;

-- The person this request comes from in `p_session`, or null. Removed people are nobody.
create or replace function cf_collab_me(p_session uuid) returns uuid
    language sql stable security definer
    set search_path = public
    as $$
        select p.id from cf_collab_people p
        where p.session_id = p_session
          and p.removed_at is null
          and cf_collab_key() <> ''
          and p.key_hash = cf_collab_hash(cf_collab_key())
    $$;

create or replace function cf_collab_is_owner(p_session uuid, p_owner_secret text) returns boolean
    language sql stable security definer
    set search_path = public
    as $$
        select exists (
            select 1 from cf_collab_sessions s
            where s.id = p_session
              and s.ended_at is null
              and coalesce(p_owner_secret, '') <> ''
              and s.owner_hash = cf_collab_hash(p_owner_secret)
        )
    $$;

-- ---------------------------------------------------------------------------
-- Policies: reads for members, inserts of blobs and of one's own messages
-- ---------------------------------------------------------------------------

alter table cf_collab_sessions enable row level security;
alter table cf_collab_people   enable row level security;
alter table cf_collab_invites  enable row level security;
alter table cf_collab_repos    enable row level security;
alter table cf_collab_files    enable row level security;
alter table cf_collab_blobs    enable row level security;
alter table cf_collab_messages enable row level security;
alter table cf_collab_locks    enable row level security;

drop policy if exists cf_collab_sessions_read on cf_collab_sessions;
create policy cf_collab_sessions_read on cf_collab_sessions for select using (cf_collab_me(id) is not null);

drop policy if exists cf_collab_people_read on cf_collab_people;
create policy cf_collab_people_read on cf_collab_people for select using (cf_collab_me(session_id) is not null);

drop policy if exists cf_collab_repos_read on cf_collab_repos;
create policy cf_collab_repos_read on cf_collab_repos for select using (cf_collab_me(session_id) is not null);

drop policy if exists cf_collab_files_read on cf_collab_files;
create policy cf_collab_files_read on cf_collab_files for select using (cf_collab_me(session_id) is not null);

drop policy if exists cf_collab_blobs_read on cf_collab_blobs;
drop policy if exists cf_collab_blobs_add on cf_collab_blobs;
create policy cf_collab_blobs_read on cf_collab_blobs for select using (cf_collab_me(session_id) is not null);
create policy cf_collab_blobs_add on cf_collab_blobs for insert with check (cf_collab_me(session_id) is not null);

drop policy if exists cf_collab_messages_read on cf_collab_messages;
drop policy if exists cf_collab_messages_add on cf_collab_messages;
create policy cf_collab_messages_read on cf_collab_messages for select using (cf_collab_me(session_id) is not null);
create policy cf_collab_messages_add on cf_collab_messages for insert with check (cf_collab_me(session_id) is not null and person_id = cf_collab_me(session_id));

drop policy if exists cf_collab_locks_read on cf_collab_locks;
create policy cf_collab_locks_read on cf_collab_locks for select using (cf_collab_me(session_id) is not null);

-- cf_collab_invites has no policy at all: only cf_collab_invite and cf_collab_join touch it.

-- ---------------------------------------------------------------------------
-- Sessions, people, invitations
-- ---------------------------------------------------------------------------

-- Opens a session with its host as the first person. Returns the host's person id.
create or replace function cf_collab_create(p_id uuid, p_name text, p_owner_hash text, p_nick text, p_key_hash text)
    returns uuid
    language plpgsql security definer
    set search_path = public
    as $$
declare
    v_person uuid;
begin
    if coalesce(trim(p_nick), '') = '' then
        raise exception 'cf_nick_required';
    end if;
    insert into cf_collab_sessions (id, name, owner_hash) values (p_id, p_name, p_owner_hash);
    insert into cf_collab_people (session_id, nick, key_hash, role)
        values (p_id, trim(p_nick), p_key_hash, 'owner')
        returning id into v_person;
    return v_person;
end
$$;

-- Adds a repository to the session, or moves an existing one to a new base (with its epoch).
create or replace function cf_collab_add_repo(p_session uuid, p_owner_secret text, p_repo_key text, p_name text, p_base text)
    returns void
    language plpgsql security definer
    set search_path = public
    as $$
begin
    if not cf_collab_is_owner(p_session, p_owner_secret) then
        raise exception 'cf_not_owner';
    end if;
    insert into cf_collab_repos (session_id, repo_key, name, base_sha)
        values (p_session, p_repo_key, p_name, p_base)
        on conflict (session_id, repo_key) do update set name = excluded.name;
end
$$;

create or replace function cf_collab_invite(p_session uuid, p_owner_secret text, p_token_hash text, p_hours integer)
    returns timestamptz
    language plpgsql security definer
    set search_path = public
    as $$
declare
    v_expires timestamptz := now() + make_interval(hours => least(greatest(coalesce(p_hours, 24), 1), 168));
begin
    if not cf_collab_is_owner(p_session, p_owner_secret) then
        raise exception 'cf_not_owner';
    end if;
    insert into cf_collab_invites (token_hash, session_id, expires_at) values (p_token_hash, p_session, v_expires);
    return v_expires;
end
$$;

-- Exchanges a single-use invitation for a person in its session. Returns what the joiner needs to
-- prepare their copy: the session, their person id and every repository with its base.
create or replace function cf_collab_join(p_token text, p_nick text, p_key_hash text)
    returns json
    language plpgsql security definer
    set search_path = public
    as $$
declare
    v_invite  cf_collab_invites;
    v_session cf_collab_sessions;
    v_person  uuid;
begin
    select * into v_invite from cf_collab_invites where token_hash = cf_collab_hash(p_token) for update;
    if not found then raise exception 'cf_invite_unknown'; end if;
    if v_invite.used_at is not null then raise exception 'cf_invite_used'; end if;
    if v_invite.expires_at < now() then raise exception 'cf_invite_expired'; end if;

    select * into v_session from cf_collab_sessions where id = v_invite.session_id;
    if v_session.ended_at is not null then raise exception 'cf_session_ended'; end if;
    if coalesce(trim(p_nick), '') = '' then raise exception 'cf_nick_required'; end if;
    if exists (
        select 1 from cf_collab_people
        where session_id = v_session.id and removed_at is null and lower(nick) = lower(trim(p_nick))
    ) then
        raise exception 'cf_nick_taken';
    end if;

    insert into cf_collab_people (session_id, nick, key_hash) values (v_session.id, trim(p_nick), p_key_hash)
        returning id into v_person;
    update cf_collab_invites set used_at = now(), used_by = v_person where token_hash = v_invite.token_hash;

    return json_build_object(
        'session_id', v_session.id,
        'name', v_session.name,
        'person_id', v_person,
        'repos', coalesce((
            select json_agg(json_build_object('repo_key', r.repo_key, 'name', r.name, 'base_sha', r.base_sha, 'epoch', r.epoch))
            from cf_collab_repos r where r.session_id = v_session.id
        ), '[]'::json)
    );
end
$$;

create or replace function cf_collab_heartbeat(p_session uuid) returns void
    language plpgsql security definer
    set search_path = public
    as $$
begin
    update cf_collab_people set last_seen = now() where id = cf_collab_me(p_session);
end
$$;

-- The host removes one person: their key stops working at once and their locks go.
create or replace function cf_collab_remove_person(p_session uuid, p_owner_secret text, p_person uuid) returns void
    language plpgsql security definer
    set search_path = public
    as $$
begin
    if not cf_collab_is_owner(p_session, p_owner_secret) then
        raise exception 'cf_not_owner';
    end if;
    update cf_collab_people set removed_at = now()
        where id = p_person and session_id = p_session and role <> 'owner';
    delete from cf_collab_locks where session_id = p_session and person_id = p_person;
    -- Their seats in a shared run are free again, and what they had not finished goes back to the run.
    -- (Those tables come later in the script: plpgsql resolves names when the function runs.)
    update cf_collab_tasks set status = 'withdrawn', updated_at = now()
        where session_id = p_session and person_id = p_person and status in ('offered', 'accepted');
    update cf_collab_seats set person_id = null, agent = '', engine = '', taken_at = null
        where session_id = p_session and person_id = p_person;
    -- They knew the live channel: a new one, which only the people still in learn.
    update cf_collab_sessions
        set channel_key = replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
        where id = p_session;
end
$$;

create or replace function cf_collab_end(p_session uuid, p_owner_secret text) returns void
    language plpgsql security definer
    set search_path = public
    as $$
begin
    if not cf_collab_is_owner(p_session, p_owner_secret) then
        raise exception 'cf_not_owner';
    end if;
    update cf_collab_sessions set ended_at = now() where id = p_session;
    delete from cf_collab_locks where session_id = p_session;
end
$$;

-- ---------------------------------------------------------------------------
-- Files
-- ---------------------------------------------------------------------------

-- Records a file's new state. `p_expected` is the version the caller last saw (0: never recorded). A
-- stale one fails with `cf_conflict:<current>`, so two writers never overwrite each other unseen. A
-- present file needs its blob uploaded first.
create or replace function cf_collab_put_file(
    p_session uuid, p_repo_key text, p_path text, p_expected bigint,
    p_state text, p_sha text, p_size bigint, p_binary boolean
) returns bigint
    language plpgsql security definer
    set search_path = public
    as $$
declare
    v_me      uuid := cf_collab_me(p_session);
    v_current bigint;
    v_rows    integer;
begin
    if v_me is null then raise exception 'cf_not_member'; end if;
    if p_state = 'present' and not exists (
        select 1 from cf_collab_blobs where session_id = p_session and sha = p_sha
    ) then
        raise exception 'cf_blob_missing';
    end if;

    select version into v_current from cf_collab_files
        where session_id = p_session and repo_key = p_repo_key and path = p_path
        for update;

    if v_current is null then
        if p_expected <> 0 then raise exception 'cf_conflict:0'; end if;
        insert into cf_collab_files (session_id, repo_key, path, state, sha, size, is_binary, version, updated_by)
            values (p_session, p_repo_key, p_path, p_state, p_sha, p_size, coalesce(p_binary, false), 1, v_me)
            on conflict (session_id, repo_key, path) do nothing;
        get diagnostics v_rows = row_count;
        if v_rows = 0 then raise exception 'cf_conflict:1'; end if; -- someone recorded it first
        return 1;
    end if;

    if v_current <> p_expected then
        raise exception 'cf_conflict:%', v_current;
    end if;
    update cf_collab_files
        set state = p_state, sha = p_sha, size = p_size, is_binary = coalesce(p_binary, false),
            version = v_current + 1, updated_by = v_me, updated_at = now()
        where session_id = p_session and repo_key = p_repo_key and path = p_path;
    return v_current + 1;
end
$$;

-- After the host commits and pushes, the repository moves to `p_base` and the committed paths stop
-- being session changes. Peers see the epoch move, fetch the base and rebase their worktree onto it.
create or replace function cf_collab_advance_base(
    p_session uuid, p_owner_secret text, p_repo_key text, p_base text, p_paths text[]
) returns integer
    language plpgsql security definer
    set search_path = public
    as $$
declare
    v_epoch integer;
begin
    if not cf_collab_is_owner(p_session, p_owner_secret) then
        raise exception 'cf_not_owner';
    end if;
    update cf_collab_repos set base_sha = p_base, epoch = epoch + 1
        where session_id = p_session and repo_key = p_repo_key
        returning epoch into v_epoch;
    if v_epoch is null then raise exception 'cf_repo_unknown'; end if;
    delete from cf_collab_files
        where session_id = p_session and repo_key = p_repo_key and path = any(coalesce(p_paths, '{}'));
    return v_epoch;
end
$$;

-- ---------------------------------------------------------------------------
-- Turn locks (decision 9)
-- ---------------------------------------------------------------------------

-- Takes every repository in `p_repos` for turn `p_turn`, or none of them: false when any is held by
-- another turn. Calling it again for the same turn renews the locks.
create or replace function cf_collab_lock(p_session uuid, p_repos text[], p_turn text, p_ttl_seconds integer)
    returns boolean
    language plpgsql security definer
    set search_path = public
    as $$
declare
    v_me uuid := cf_collab_me(p_session);
begin
    if v_me is null then raise exception 'cf_not_member'; end if;
    -- One lock decision at a time per session, so two turns asking at once cannot both win.
    perform pg_advisory_xact_lock(hashtext(p_session::text));
    delete from cf_collab_locks where session_id = p_session and expires_at < now();
    if exists (
        select 1 from cf_collab_locks
        where session_id = p_session and repo_key = any(p_repos) and turn_id <> p_turn
    ) then
        return false;
    end if;
    insert into cf_collab_locks (session_id, repo_key, person_id, turn_id, expires_at)
        select p_session, r, v_me, p_turn, now() + make_interval(secs => greatest(coalesce(p_ttl_seconds, 120), 30))
        from unnest(p_repos) as r
        on conflict (session_id, repo_key) do update set expires_at = excluded.expires_at;
    return true;
end
$$;

create or replace function cf_collab_unlock(p_session uuid, p_turn text) returns void
    language plpgsql security definer
    set search_path = public
    as $$
begin
    delete from cf_collab_locks
        where session_id = p_session and turn_id = p_turn and person_id = cf_collab_me(p_session);
end
$$;

-- ---------------------------------------------------------------------------
-- Change detection and version
-- ---------------------------------------------------------------------------

-- One small read that says whether anything moved: the newest file change, message and base epoch.
create or replace function cf_collab_watermark(p_session uuid) returns json
    language plpgsql security definer
    set search_path = public
    as $$
begin
    if cf_collab_me(p_session) is null then raise exception 'cf_not_member'; end if;
    return json_build_object(
        'files', (select max(updated_at) from cf_collab_files where session_id = p_session),
        'messages', (select max(seq) from cf_collab_messages where session_id = p_session),
        'epochs', (select coalesce(sum(epoch), 0) from cf_collab_repos where session_id = p_session),
        'ended', (select ended_at from cf_collab_sessions where id = p_session),
        'channel', (select channel_key from cf_collab_sessions where id = p_session),
        'me', cf_collab_me(p_session)
    );
end
$$;

-- ---------------------------------------------------------------------------
-- Shared «Equipo» runs (version 3)
-- ---------------------------------------------------------------------------
--
-- A run lives on its owner's machine; the owner's CodeFlow is the only one that plans, merges and
-- lands. Some of its members are SEATS that other people fill with agents of their own, which run on
-- their machines with their accounts. The owner OFFERS a seat's task here (the message its agent
-- starts from, and where in the history it starts); the seat's person accepts or declines it on
-- their machine and REPORTS the answer, with their commit as a git bundle in cf_collab_blobs. The
-- owner also publishes a picture of the run (cf_collab_runs) so the others can follow it.
--
-- Nothing about an agent beyond its name and engine reaches this project: not its account, not its
-- instructions.

alter table cf_collab_sessions add column if not exists kind text not null default 'chat';

create table if not exists cf_collab_seats (
    session_id  uuid not null references cf_collab_sessions(id) on delete cascade,
    member_id   text not null check (char_length(member_id) between 1 and 80),
    name        text not null,
    role        text not null default '',
    person_id   uuid references cf_collab_people(id) on delete set null,
    agent       text not null default '' check (char_length(agent) <= 80),
    engine      text not null default '' check (char_length(engine) <= 40),
    taken_at    timestamptz,
    primary key (session_id, member_id)
);

create table if not exists cf_collab_tasks (
    session_id     uuid not null references cf_collab_sessions(id) on delete cascade,
    item_id        text not null check (char_length(item_id) between 1 and 80),
    attempt        integer not null default 1,
    member_id      text not null,
    person_id      uuid not null references cf_collab_people(id) on delete cascade,
    repo_key       text not null,
    kind           text not null check (kind in ('work', 'review')),
    title          text not null,
    message        text not null,
    writes         boolean not null,
    target         text not null,
    start_sha      text not null check (start_sha ~ '^[0-9a-f]{40}$'),
    start_bundle   text check (start_bundle is null or start_bundle ~ '^[0-9a-f]{64}$'),
    status         text not null default 'offered'
                   check (status in ('offered', 'accepted', 'done', 'failed', 'declined', 'withdrawn')),
    result_text    text,
    error          text,
    result_sha     text check (result_sha is null or result_sha ~ '^[0-9a-f]{40}$'),
    result_bundle  text check (result_bundle is null or result_bundle ~ '^[0-9a-f]{64}$'),
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now(),
    primary key (session_id, item_id)
);

create table if not exists cf_collab_runs (
    session_id  uuid primary key references cf_collab_sessions(id) on delete cascade,
    state       jsonb not null,
    updated_at  timestamptz not null default now()
);

alter table cf_collab_seats enable row level security;
alter table cf_collab_tasks enable row level security;
alter table cf_collab_runs  enable row level security;

drop policy if exists cf_collab_seats_read on cf_collab_seats;
create policy cf_collab_seats_read on cf_collab_seats for select using (cf_collab_me(session_id) is not null);
drop policy if exists cf_collab_tasks_read on cf_collab_tasks;
create policy cf_collab_tasks_read on cf_collab_tasks for select using (cf_collab_me(session_id) is not null);
drop policy if exists cf_collab_runs_read on cf_collab_runs;
create policy cf_collab_runs_read on cf_collab_runs for select using (cf_collab_me(session_id) is not null);

-- The owner says which members are seats (`[{"member_id","name","role"}]`). Seats no longer listed
-- go, and with them any task still waiting on them.
create or replace function cf_collab_open_seats(p_session uuid, p_owner_secret text, p_seats jsonb) returns void
    language plpgsql security definer
    set search_path = public
    as $$
begin
    if not cf_collab_is_owner(p_session, p_owner_secret) then raise exception 'cf_not_owner'; end if;
    update cf_collab_sessions set kind = 'run' where id = p_session;
    insert into cf_collab_seats (session_id, member_id, name, role)
        select p_session, s ->> 'member_id', coalesce(s ->> 'name', ''), coalesce(s ->> 'role', '')
        from jsonb_array_elements(coalesce(p_seats, '[]'::jsonb)) s
        on conflict (session_id, member_id) do update set name = excluded.name, role = excluded.role;
    update cf_collab_tasks set status = 'withdrawn', updated_at = now()
        where session_id = p_session and status in ('offered', 'accepted')
          and member_id not in (select s ->> 'member_id' from jsonb_array_elements(coalesce(p_seats, '[]'::jsonb)) s);
    delete from cf_collab_seats
        where session_id = p_session
          and member_id not in (select s ->> 'member_id' from jsonb_array_elements(coalesce(p_seats, '[]'::jsonb)) s);
end
$$;

-- A person fills a free seat (or changes the agent on their own).
create or replace function cf_collab_take_seat(p_session uuid, p_member text, p_agent text, p_engine text) returns void
    language plpgsql security definer
    set search_path = public
    as $$
declare
    v_me uuid := cf_collab_me(p_session);
begin
    if v_me is null then raise exception 'cf_not_member'; end if;
    update cf_collab_seats
        set person_id = v_me, agent = left(coalesce(p_agent, ''), 80), engine = left(coalesce(p_engine, ''), 40), taken_at = now()
        where session_id = p_session and member_id = p_member and (person_id is null or person_id = v_me);
    if not found then raise exception 'cf_seat_taken'; end if;
end
$$;

-- A seat given back: by the person in it, or by the owner (`p_owner_secret`) for anyone's.
-- Its open tasks are withdrawn, so the owner's run takes them back.
create or replace function cf_collab_free_seat(p_session uuid, p_member text, p_owner_secret text) returns void
    language plpgsql security definer
    set search_path = public
    as $$
declare
    v_me uuid := cf_collab_me(p_session);
    v_owner boolean := cf_collab_is_owner(p_session, p_owner_secret);
begin
    if v_me is null and not v_owner then raise exception 'cf_not_member'; end if;
    update cf_collab_tasks set status = 'withdrawn', updated_at = now()
        where session_id = p_session and member_id = p_member and status in ('offered', 'accepted')
          and (v_owner or person_id = v_me);
    update cf_collab_seats set person_id = null, agent = '', engine = '', taken_at = null
        where session_id = p_session and member_id = p_member and (v_owner or person_id = v_me);
end
$$;

-- The owner offers a seat's task to whoever is in the seat. Offering an item again (a retry) starts
-- it over under its new attempt number.
create or replace function cf_collab_offer(p_session uuid, p_owner_secret text, p_task jsonb) returns void
    language plpgsql security definer
    set search_path = public
    as $$
declare
    v_person uuid;
begin
    if not cf_collab_is_owner(p_session, p_owner_secret) then raise exception 'cf_not_owner'; end if;
    select person_id into v_person from cf_collab_seats where session_id = p_session and member_id = p_task ->> 'member_id';
    if v_person is null then raise exception 'cf_seat_free'; end if;
    insert into cf_collab_tasks (session_id, item_id, attempt, member_id, person_id, repo_key, kind, title, message,
                                 writes, target, start_sha, start_bundle, status)
    values (p_session, p_task ->> 'item_id', coalesce((p_task ->> 'attempt')::integer, 1), p_task ->> 'member_id', v_person,
            p_task ->> 'repo_key', p_task ->> 'kind', left(p_task ->> 'title', 300), p_task ->> 'message',
            coalesce((p_task ->> 'writes')::boolean, true), p_task ->> 'target', p_task ->> 'start_sha',
            nullif(p_task ->> 'start_bundle', ''), 'offered')
    on conflict (session_id, item_id) do update set
        attempt = excluded.attempt, member_id = excluded.member_id, person_id = excluded.person_id,
        repo_key = excluded.repo_key, kind = excluded.kind, title = excluded.title, message = excluded.message,
        writes = excluded.writes, target = excluded.target, start_sha = excluded.start_sha,
        start_bundle = excluded.start_bundle, status = 'offered', result_text = null, error = null,
        result_sha = null, result_bundle = null, updated_at = now();
end
$$;

create or replace function cf_collab_withdraw(p_session uuid, p_owner_secret text, p_item text) returns void
    language plpgsql security definer
    set search_path = public
    as $$
begin
    if not cf_collab_is_owner(p_session, p_owner_secret) then raise exception 'cf_not_owner'; end if;
    update cf_collab_tasks set status = 'withdrawn', updated_at = now()
        where session_id = p_session and item_id = p_item and status in ('offered', 'accepted');
end
$$;

-- The seat's person moves their task on: offered → accepted | declined, accepted → done | failed.
-- Only for the attempt they were offered, so a late answer to an old attempt changes nothing.
create or replace function cf_collab_report(
    p_session uuid, p_item text, p_attempt integer, p_status text,
    p_text text, p_error text, p_sha text, p_bundle text
) returns void
    language plpgsql security definer
    set search_path = public
    as $$
declare
    v_me uuid := cf_collab_me(p_session);
    v_task cf_collab_tasks;
begin
    if v_me is null then raise exception 'cf_not_member'; end if;
    select * into v_task from cf_collab_tasks
        where session_id = p_session and item_id = p_item and person_id = v_me for update;
    if v_task.item_id is null or v_task.attempt <> p_attempt then raise exception 'cf_task_gone'; end if;
    if not ((v_task.status = 'offered' and p_status in ('accepted', 'declined'))
         or (v_task.status = 'accepted' and p_status in ('done', 'failed'))) then
        raise exception 'cf_task_gone';
    end if;
    update cf_collab_tasks set
        status = p_status,
        result_text = case when p_status in ('done', 'failed') then left(p_text, 200000) else result_text end,
        error = case when p_status in ('failed', 'declined') then left(p_error, 4000) else null end,
        result_sha = nullif(p_sha, ''),
        result_bundle = nullif(p_bundle, ''),
        updated_at = now()
    where session_id = p_session and item_id = p_item;
end
$$;

-- The owner's picture of the run, for everyone else's screen.
create or replace function cf_collab_publish_run(p_session uuid, p_owner_secret text, p_state jsonb) returns void
    language plpgsql security definer
    set search_path = public
    as $$
begin
    if not cf_collab_is_owner(p_session, p_owner_secret) then raise exception 'cf_not_owner'; end if;
    if octet_length(p_state::text) > 2000000 then raise exception 'cf_too_large'; end if;
    insert into cf_collab_runs (session_id, state, updated_at) values (p_session, p_state, now())
        on conflict (session_id) do update set state = excluded.state, updated_at = now();
end
$$;

create or replace function cf_collab_version() returns integer
    language sql immutable
    as $$
        select 3
    $$;
