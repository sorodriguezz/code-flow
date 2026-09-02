use rusqlite::{params, Connection, OptionalExtension};

pub fn run(conn: &Connection) -> rusqlite::Result<()> {
    // Must run *before* the schema batch: it moves the pre-workspace `api_*` tables aside so the
    // batch below recreates them in their current shape, and `migrate_api_tables_finish` then
    // copies the old rows across. See that pair's doc comments.
    migrate_api_tables_begin(conn)?;
    // Also before the batch, and for a related reason: the batch's `CREATE TABLE IF NOT EXISTS
    // notes` is a no-op on a database that already has the table under its old column names, so
    // the `book_id` index a few lines later fails on a column that was never renamed. See the
    // function.
    migrate_note_folders_to_books(conn)?;

    conn.execute_batch(
        r#"
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS workspaces (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            icon        TEXT NOT NULL DEFAULT 'folder',
            color       TEXT NOT NULL DEFAULT '#6366f1',
            sort_order  INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS projects (
            id          TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            name        TEXT NOT NULL,
            local_path  TEXT NOT NULL,
            remote_url  TEXT,
            color       TEXT NOT NULL DEFAULT '#6366f1',
            icon        TEXT NOT NULL DEFAULT 'git-branch',
            ado_org      TEXT,
            ado_project  TEXT,
            ado_repo_id  TEXT,
            github_owner TEXT,
            github_repo  TEXT,
            github_host  TEXT,
            sort_order   INTEGER NOT NULL DEFAULT 0,
            created_at   TEXT NOT NULL
        );

        -- Review context is scoped per WORKSPACE (see migrate_review_contexts_to_workspace
        -- below for the project_id -> workspace_id column migration for pre-existing rows).
        CREATE TABLE IF NOT EXISTS review_contexts (
            id           TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            name         TEXT NOT NULL,
            content      TEXT NOT NULL DEFAULT '',
            enabled      INTEGER NOT NULL DEFAULT 1,
            created_at   TEXT NOT NULL
        );

        -- Per-workspace, provider-independent prompt overrides keyed by `kind`
        -- (`review_standard` = the PR review methodology, `pr_description` = the PR-description
        -- generator). One row per (workspace, kind), seeded with the built-in default on creation
        -- and backfilled for pre-existing workspaces (see backfill_workspace_prompts). Empty
        -- content means "use the built-in default", so resetting is just a blank save. These are
        -- deliberately NOT per-provider — the same text applies to whatever engine a task routes to.
        -- A workspace that commits as somebody else.
        --
        -- One row per workspace, and only when there is an override: **no row means inherit**, the
        -- same convention `workspace_prompts` uses for an empty `content`. There is deliberately no
        -- 'global' row and no `scope` column, because the global row already exists and it is
        -- ~/.gitconfig — a second one stored here would be a second answer to the same question,
        -- free to disagree with the first.
        --
        -- This table is the *declared intent*, not the thing git reads. What git reads is each
        -- repository's own .git/config, which `apply_workspace_identity` keeps in step: the intent
        -- lives here so a repository added to the workspace tomorrow can be brought into line
        -- without asking, and so the settings screen can show every workspace's identity without
        -- opening N repositories to find out.
        CREATE TABLE IF NOT EXISTS workspace_git_identity (
            workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
            name         TEXT NOT NULL,
            email        TEXT NOT NULL,
            updated_at   TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS workspace_prompts (
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            kind         TEXT NOT NULL,
            content      TEXT NOT NULL DEFAULT '',
            updated_at   TEXT NOT NULL,
            PRIMARY KEY (workspace_id, kind)
        );

        -- The PR review engine's numbers, per workspace: what each depth level costs (confidence
        -- threshold, reportable severities, active lenses, parallelism), which severities fail the
        -- Quality Gate, which paths are in scope, and the context budgets.
        --
        -- Deliberately NOT in `workspace_prompts`, even though it is edited on the same screen: this
        -- is a policy the code enforces and freezes into every saved review, while a prompt is text
        -- handed to a model. Storing one JSON document rather than a column per knob is what lets a
        -- new setting ship without a migration, and `ReviewEngineConfig` deserializes every field
        -- with a default so a row written by an older build stays readable.
        CREATE TABLE IF NOT EXISTS review_engine_config (
            workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
            config       TEXT NOT NULL DEFAULT '{}',
            updated_at   TEXT NOT NULL
        );

        -- Durable memory of every completed PR review — one row per run, kept in the DB (not on
        -- disk) so it moves/backs up with codeflow.db. Holds the rendered review, the exact diff
        -- reviewed, run metadata and the parsed findings (JSON), which is what a re-review reads
        -- back to reconcile new/still-present/resolved. Timestamped rows, never overwritten, so the
        -- code a finding referred to stays recoverable even after the branch is gone.
        CREATE TABLE IF NOT EXISTS review_runs (
            id           TEXT PRIMARY KEY,
            project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            workspace_id TEXT NOT NULL,
            pr_id        INTEGER NOT NULL,
            iter         INTEGER NOT NULL,
            level        TEXT NOT NULL,
            meta         TEXT NOT NULL DEFAULT '{}',
            review_md    TEXT NOT NULL,
            diff         TEXT NOT NULL DEFAULT '',
            findings     TEXT NOT NULL DEFAULT '[]',
            created_at   TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_review_runs_pr ON review_runs (project_id, pr_id, created_at);

        -- Skills installed via `npx skills add`, scoped per workspace; synced into whichever
        -- project is actually being reviewed at review time (Claude Code only discovers
        -- skills from a project's own .claude/skills, there's no cross-directory flag for it).
        CREATE TABLE IF NOT EXISTS workspace_skills (
            id           TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            skill_name   TEXT NOT NULL,
            source_repo  TEXT NOT NULL,
            enabled      INTEGER NOT NULL DEFAULT 1,
            installed_at TEXT NOT NULL
        );

        -- User-defined SDD/Harness agents (roles) per workspace — name + role + model + prompt.
        -- Deliberately empty by default (no preset roster); the user creates their own.
        CREATE TABLE IF NOT EXISTS workspace_agents (
            id           TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            name         TEXT NOT NULL,
            role         TEXT NOT NULL DEFAULT '',
            provider     TEXT NOT NULL DEFAULT '',
            model        TEXT NOT NULL DEFAULT '',
            prompt       TEXT NOT NULL DEFAULT '',
            enabled      INTEGER NOT NULL DEFAULT 1,
            sort_order   INTEGER NOT NULL DEFAULT 0,
            created_at   TEXT NOT NULL
        );

        -- A folder for agent work — "Migración API", "Refactor auth". Purely an organising device: it
        -- holds tasks and chains, it runs nothing, and it is deliberately NOT a repository (`projects`),
        -- which is where a turn's working copy comes from. One task can belong to at most one of these.
        --
        -- Membership is recorded on the child as a plain id with no foreign key, the same convention
        -- `agent_tasks.agent_id` uses: deleting a folder must leave the work standing, so the delete
        -- clears the pointer instead of cascading.
        CREATE TABLE IF NOT EXISTS agent_projects (
            id           TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            name         TEXT NOT NULL,
            description  TEXT NOT NULL DEFAULT '',
            color        TEXT NOT NULL DEFAULT '#6366f1',
            sort_order   INTEGER NOT NULL DEFAULT 0,
            created_at   TEXT NOT NULL,
            updated_at   TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_agent_projects_workspace
            ON agent_projects(workspace_id, sort_order);

        -- The agent console's terminal bench: shells the user opened by hand to drive whatever CLI
        -- they like, kept beside the agents rather than inside a repository.
        --
        -- Workspace-scoped and *not* project-scoped, unlike the terminal dock in the repository
        -- views. That dock belongs to a working copy — its cwd is the repo and it closes with it.
        -- These belong to the workspace the way the agent roster does: the CLI you are logging into
        -- or the long build you are watching is not a fact about which repository is selected, and
        -- clicking a different one must not take it away.
        --
        -- `transcript` is the reason this table exists at all. A pty cannot outlive the process that
        -- opened it, so "don't lose my work" cannot mean keeping the shell alive across a restart —
        -- it means keeping what the shell *said*. The bytes are appended as they are printed (see
        -- `terminal::Transcript`, which caps them), so reopening the bench replays the scrollback
        -- with a fresh shell under it. `cwd` and `profile_id` are what make that shell the same
        -- shell in the same place rather than a new one somewhere else.
        --
        -- Deliberately absent from `backup::snapshot::TABLES`; see `NEVER_BACKED_UP` there.
        CREATE TABLE IF NOT EXISTS workspace_terminals (
            id           TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            -- Which bench tab this shell is a pane of. See `workspace_bench_tabs`.
            tab_id       TEXT NOT NULL DEFAULT '',
            title        TEXT NOT NULL,
            cwd          TEXT NOT NULL DEFAULT '',
            -- Empty means "whatever the configured default profile resolves to", which is not the
            -- same as a fixed shell: a user who changes their default gets it here too.
            profile_id   TEXT NOT NULL DEFAULT '',
            transcript   TEXT NOT NULL DEFAULT '',
            sort_order   INTEGER NOT NULL DEFAULT 0,
            created_at   TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_workspace_terminals_workspace
            ON workspace_terminals(workspace_id, sort_order);

        -- One tab of the bench, and the arrangement of shells inside it.
        --
        -- Tabs and panes both, the way every terminal emulator that has one does it, and for the
        -- reason those all arrived at: a tiling view alone does not scale. Six shells tiled are six
        -- unreadable slivers and the only way out is closing one. Tabs give the set somewhere to
        -- live that costs no screen, and panes give the two or three you are actually watching
        -- right now — the build and the server it is restarting — the room to be watched together.
        --
        -- `layout` is a JSON binary tree over the ids of this tab's terminals:
        --
        --     {"kind":"leaf","id":"<workspace_terminals.id>"}
        --     {"kind":"split","dir":"row"|"col","ratio":0.5,"a":{…},"b":{…}}
        --
        -- A tree rather than the list-of-groups the repository dock uses, because a list cannot say
        -- what the user is asking for: one shell down the left with two stacked beside it is two
        -- levels of nesting, and one level of grouping can only ever draw a single row or column.
        --
        -- Stored as text and parsed on the frontend, which is the only place it means anything —
        -- the backend never walks it, it only keeps it. A layout that fails to parse, or that names
        -- a terminal that has since been deleted, is repaired on load rather than refused: see
        -- `lib/bench/layout.ts`.
        --
        -- Also absent from `backup::snapshot::TABLES`, for the same reason its terminals are.
        CREATE TABLE IF NOT EXISTS workspace_bench_tabs (
            id           TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            title        TEXT NOT NULL DEFAULT '',
            layout       TEXT NOT NULL DEFAULT '',
            sort_order   INTEGER NOT NULL DEFAULT 0,
            created_at   TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_workspace_bench_tabs_workspace
            ON workspace_bench_tabs(workspace_id, sort_order);

        -- One agent task: a goal handed to a roster agent (`workspace_agents`) and worked on
        -- against one repository of this workspace.
        --
        -- Scoped to the workspace because the roster is — but it also names the project it runs
        -- in, because every agentic backend command resolves its working directory from
        -- `projects.local_path`, so a task with no repository could never actually run.
        --
        -- The task carries no transcript of its own: its turns are ordinary `activity_log` rows
        -- sharing `conversation_id`, exactly like a chat, so reopening a task replays the same
        -- rows — and the same stored traces — the AI panel would show. What lives here is only
        -- what `activity_log` cannot say: which agent was picked, and how the task as a whole is
        -- doing.
        --
        -- `provider` and `prompt` are *copied* off the agent at creation rather than read back
        -- through `agent_id`: an agent edited or deleted next week must not silently rewrite what
        -- a task already ran as. `model` is the one field a later turn may change, which is why it
        -- reads as "what the next turn will use" rather than as a frozen record.
        CREATE TABLE IF NOT EXISTS agent_tasks (
            id              TEXT PRIMARY KEY,
            workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            -- The roster row this came from, or '' once that agent has been deleted.
            agent_id        TEXT NOT NULL DEFAULT '',
            -- Snapshot of the agent's name, so a deleted agent still reads as itself here.
            agent_name      TEXT NOT NULL DEFAULT '',
            provider        TEXT NOT NULL DEFAULT '',
            model           TEXT NOT NULL DEFAULT '',
            prompt          TEXT NOT NULL DEFAULT '',
            -- The goal as first written, and the name shown in the list (the goal's first line
            -- until the user renames it).
            goal            TEXT NOT NULL DEFAULT '',
            title           TEXT NOT NULL DEFAULT '',
            -- The `agent_projects` folder this is filed under, or '' when it is filed nowhere.
            agent_project_id TEXT NOT NULL DEFAULT '',
            -- Whether the list keeps it in its pinned section, wherever else it lives.
            pinned          INTEGER NOT NULL DEFAULT 0,
            -- The app's own conversation id; `activity_log.session_id` for every turn of this task.
            conversation_id TEXT NOT NULL,
            -- 'draft' | 'running' | 'idle' | 'done' | 'error' | 'cancelled'. `running` is only
            -- meaningful within the session that set it; a row still saying so at startup is one
            -- whose app was killed mid-turn, and the store demotes it on load.
            status          TEXT NOT NULL DEFAULT 'draft',
            turns           INTEGER NOT NULL DEFAULT 0,
            last_error      TEXT NOT NULL DEFAULT '',
            created_at      TEXT NOT NULL,
            updated_at      TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_agent_tasks_workspace
            ON agent_tasks(workspace_id, updated_at DESC);

        -- One chain: an ordered plan of agent steps worked through against ONE repository.
        --
        -- Deliberately no `workspace_id`, unlike `agent_tasks` above. Moving a repository between
        -- workspaces rewrites only `projects.workspace_id`, so a copy kept here would go stale and
        -- the chain would vanish from its workspace's list while still owning live tasks. The
        -- listing joins `projects` instead, and each step's task takes the workspace id read live
        -- off that row at the moment it is created.
        --
        -- `status` is the scheduler's entire state. Only the claim/complete pair and the four
        -- explicit user commands write it; nothing in the task layer touches it.
        CREATE TABLE IF NOT EXISTS agent_chains (
            id           TEXT PRIMARY KEY,
            project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            title        TEXT NOT NULL DEFAULT '',
            goal         TEXT NOT NULL DEFAULT '',
            -- The `agent_projects` folder this is filed under, or '' when it is filed nowhere.
            agent_project_id TEXT NOT NULL DEFAULT '',
            -- Whether the list keeps it in its pinned section, wherever else it lives.
            pinned       INTEGER NOT NULL DEFAULT 0,
            -- 'queued' | 'running' | 'gated' | 'paused' | 'failed' | 'done' | 'aborted'
            status       TEXT NOT NULL DEFAULT 'paused',
            current_step INTEGER NOT NULL DEFAULT 0,
            step_count   INTEGER NOT NULL DEFAULT 0,
            -- Why it is not moving, in the chain's own words: a translation key
            -- (`chain.interrupted`, `chain.repoBusy`, …) or a raw engine error.
            last_reason  TEXT NOT NULL DEFAULT '',
            -- How many step runs this plan has dispatched, ever.
            --
            -- `step_count` stopped being the bound the day a step could send the plan backwards:
            -- a three-step plan whose reviewer loops to the implementer runs more than three
            -- times, by design. This is what actually bounds it (`MAX_CHAIN_DISPATCHES`), and it
            -- is a counter rather than a computed value because the thing that must not be
            -- exceeded is *work started*, which no amount of reading the steps back can recover
            -- once a row has been overwritten by a second visit.
            dispatches   INTEGER NOT NULL DEFAULT 0,
            created_at   TEXT NOT NULL,
            updated_at   TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_agent_chains_project
            ON agent_chains(project_id, updated_at DESC);

        -- One step of a chain.
        --
        -- `agent_id`/`agent_name`/`provider`/`model`/`prompt` are snapshotted off the roster for
        -- EVERY step when the chain is created — not at dispatch — for the same reason
        -- `agent_tasks` snapshots them: an agent edited or deleted next week must not silently
        -- rewrite what a chain paused for a week is about to run as.
        --
        -- `task_id` carries no foreign key, the same convention as `agent_tasks.agent_id`: the
        -- step has to outlive its task in order to be able to say the task is gone, and a CASCADE
        -- here would silently shorten the plan when a user deletes one step's task.
        --
        -- `output_text` is a COPY of the answer, not a pointer into `activity_log`. Deleting a
        -- task deletes its conversation, and a gate can hold a chain for days — reading the
        -- handoff back at dispatch time would break in both cases.
        --
        -- `log_count_at_dispatch` is `COUNT(*)` of the task's `activity_log` rows at the instant of
        -- dispatch. After a crash it is the only way to point at the row *this* run wrote rather
        -- than at whatever is newest: a retry after an error would otherwise harvest the previous
        -- attempt's error text and hand it forward as if it were the plan.
        CREATE TABLE IF NOT EXISTS agent_chain_steps (
            id            TEXT PRIMARY KEY,
            chain_id      TEXT NOT NULL REFERENCES agent_chains(id) ON DELETE CASCADE,
            step_index    INTEGER NOT NULL,
            agent_id      TEXT NOT NULL DEFAULT '',
            agent_name    TEXT NOT NULL DEFAULT '',
            provider      TEXT NOT NULL DEFAULT '',
            model         TEXT NOT NULL DEFAULT '',
            prompt        TEXT NOT NULL DEFAULT '',
            instruction   TEXT NOT NULL DEFAULT '',
            -- The plan's declared review point. Never cleared: `gate_cleared` records the approval
            -- separately, so a retried step re-gates and the plan can still be read as authored.
            gate          INTEGER NOT NULL DEFAULT 0,
            gate_cleared  INTEGER NOT NULL DEFAULT 0,
            -- Frozen when the chain parks at this step's gate, and sent verbatim. Editing the
            -- handoff writes here, and a non-empty value always wins over recomposition — which is
            -- what makes the preview the user approves byte-for-byte what runs.
            pending_input TEXT NOT NULL DEFAULT '',
            task_id       TEXT NOT NULL DEFAULT '',
            run_id        TEXT NOT NULL DEFAULT '',
            log_count_at_dispatch INTEGER NOT NULL DEFAULT -1,
            output_text      TEXT NOT NULL DEFAULT '',
            output_truncated INTEGER NOT NULL DEFAULT 0,
            -- 'pending' | 'running' | 'done' | 'error' | 'interrupted' | 'skipped'
            status        TEXT NOT NULL DEFAULT 'pending',
            attempts      INTEGER NOT NULL DEFAULT 0,
            last_error    TEXT NOT NULL DEFAULT '',

            -- ---- the verdict, and where it sends the plan ----
            --
            -- Together these are what turn a list into a state machine. A chain used to advance
            -- because a turn returned text: a reviewer that wrote "this is broken" finished the
            -- plan green, because nothing in the schema could tell the difference between an
            -- answer and a correct one.
            --
            -- A shell command run in this step's repository once the turn lands. Exit code 0 is
            -- the verdict and nothing else is — no parsing, no asking the model whether it thinks
            -- it succeeded. Empty means the step has no check, which is every step authored before
            -- this column existed and every step that is genuinely unverifiable.
            check_command TEXT NOT NULL DEFAULT '',
            -- Where the plan goes next, as step indices. `-1` is "the default": for `on_pass` the
            -- following step, for `on_fail` stopping.
            --
            -- A target **behind** this step is the loop the feature was missing — the reviewer
            -- that sends the implementer back to try again — and it is expressed as an index
            -- rather than as an edge table because the scheduler already selects the
            -- lowest-`pending` step: jumping backwards is resetting rows to `pending`, jumping
            -- forward is marking them `skipped`, and in both cases the existing selector then
            -- picks exactly the right one. No second table, and no second way to be wrong.
            on_pass       INTEGER NOT NULL DEFAULT -1,
            on_fail       INTEGER NOT NULL DEFAULT -1,
            -- What the step that sent the plan here had to say — its answer plus the output of the
            -- check it failed. Written onto the *target*, because a loop back to step 2 walks its
            -- context backwards from step 1 and would otherwise never see why it was sent back.
            feedback      TEXT NOT NULL DEFAULT '',

            created_at    TEXT NOT NULL,
            updated_at    TEXT NOT NULL,
            UNIQUE (chain_id, step_index)
        );

        CREATE INDEX IF NOT EXISTS idx_agent_chain_steps
            ON agent_chain_steps(chain_id, step_index);

        -- A reusable chain plan: the same three steps you run on every ticket, written once.
        --
        -- Unlike `agent_chains` these are **configuration**, not history — they belong to the
        -- workspace, they carry no run state, and they travel with a backup (see
        -- `backup::snapshot::TABLES`). A template names its agents by id and never snapshots their
        -- routing: a template is meant to follow the roster, which is the opposite of a running
        -- chain, where a snapshot is exactly what keeps it honest.
        CREATE TABLE IF NOT EXISTS workspace_chain_templates (
            id           TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            name         TEXT NOT NULL,
            description  TEXT NOT NULL DEFAULT '',
            sort_order   INTEGER NOT NULL DEFAULT 0,
            created_at   TEXT NOT NULL,
            updated_at   TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS workspace_chain_template_steps (
            id          TEXT PRIMARY KEY,
            template_id TEXT NOT NULL REFERENCES workspace_chain_templates(id) ON DELETE CASCADE,
            step_index  INTEGER NOT NULL,
            -- The roster row, resolved at the moment a chain is created from this template. An
            -- agent since deleted leaves the step for the user to re-point rather than silently
            -- dropping it.
            agent_id    TEXT NOT NULL DEFAULT '',
            instruction TEXT NOT NULL DEFAULT '',
            gate        INTEGER NOT NULL DEFAULT 0,
            -- The verdict and its targets travel with a template, unlike the repository: a check
            -- command and "if this fails, go back to step 2" mean the same thing in any workspace,
            -- and they are most of what makes a plan worth saving rather than retyping.
            check_command TEXT NOT NULL DEFAULT '',
            on_pass     INTEGER NOT NULL DEFAULT -1,
            on_fail     INTEGER NOT NULL DEFAULT -1,
            UNIQUE (template_id, step_index)
        );

        CREATE INDEX IF NOT EXISTS idx_chain_template_steps
            ON workspace_chain_template_steps(template_id, step_index);

        -- One run of "read this documentation, write the backlog": the source it was derived
        -- from, the Azure Boards target it publishes to, and the stories themselves (in
        -- `story_drafts` below).
        --
        -- Scoped to the WORKSPACE, not to a project, for the same reason the agent roster is: a
        -- requirement is written before there is code to write it against, and a batch derived
        -- from a wiki must not need a repository to exist. `project_id` is therefore nullable and
        -- only carries the repo whose Markdown was read, for the `files` source.
        --
        -- `source_text` is a COPY of what was sent to the model, not a pointer at the wiki page.
        -- The wiki is edited by other people; re-running a generation a week later against a page
        -- that has since changed would silently produce a different backlog under the same title,
        -- and comparing a story against the text it came from would no longer be possible.
        CREATE TABLE IF NOT EXISTS story_batches (
            id            TEXT PRIMARY KEY,
            workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            -- The repository whose files were read, for `source_kind = 'files'`. Null otherwise.
            project_id    TEXT REFERENCES projects(id) ON DELETE SET NULL,
            title         TEXT NOT NULL DEFAULT '',
            -- 'wiki' | 'files' | 'text'
            source_kind   TEXT NOT NULL DEFAULT 'text',
            -- Human-readable provenance: the wiki page paths, the file paths, or '' for pasted text.
            source_ref    TEXT NOT NULL DEFAULT '',
            source_text   TEXT NOT NULL DEFAULT '',
            instructions  TEXT NOT NULL DEFAULT '',
            -- What the generation ran on. Snapshotted like `agent_tasks` does: re-reading the
            -- workspace's routing next month must not rewrite what this batch says it used.
            provider      TEXT NOT NULL DEFAULT '',
            model         TEXT NOT NULL DEFAULT '',
            -- The prompt that produced the stories, frozen for the same reason `source_text` is.
            -- The template lives in `workspace_prompts` with one row per workspace and no history,
            -- and `instructions` above is whatever the rail holds *now* for the next run; neither
            -- can answer "what did this set come out of?" after the fact. Empty means never
            -- generated, or generated before this column existed.
            prompt_template     TEXT NOT NULL DEFAULT '',
            prompt_instructions TEXT NOT NULL DEFAULT '',
            generated_at        TEXT NOT NULL DEFAULT '',
            -- The board target. Empty until the user picks one; every story of the batch publishes
            -- against it, which is what makes "publish selected" a single decision.
            --
            -- '' | 'azure' | 'jira'. Empty reads as Azure, which is what every set predating Jira
            -- was, so no backfill exists or is needed.
            board_provider  TEXT NOT NULL DEFAULT '',
            -- Three opaque strings the host interprets: on Azure the organisation, the project and
            -- the work item type; on Jira the site, the project key and the issue type id. Named for
            -- Azure because that is who defined them first, and shared rather than duplicated
            -- because two parallel sets of columns would leave two ways to say where a set
            -- publishes, one of which is always stale.
            ado_org         TEXT NOT NULL DEFAULT '',
            ado_project     TEXT NOT NULL DEFAULT '',
            work_item_type  TEXT NOT NULL DEFAULT '',
            -- Azure only. Jira has no equivalent, so these stay empty on a Jira target and the
            -- panel doesn't offer them.
            area_path       TEXT NOT NULL DEFAULT '',
            iteration_path  TEXT NOT NULL DEFAULT '',
            tags            TEXT NOT NULL DEFAULT '',
            -- What the model couldn't answer from the documentation. Kept on the batch rather than
            -- on a story because an ambiguity usually spans several of them.
            open_questions  TEXT NOT NULL DEFAULT '[]',
            -- Those questions once somebody answered them: [{"question","answer"}]. Requirements the
            -- documentation was missing, so they accumulate rather than being consumed — every later
            -- generation is given them again, and an answer outlives the question that prompted it.
            question_answers TEXT NOT NULL DEFAULT '[]',
            -- The repositories the acceptance criteria are checked against ("does the code already
            -- do this?"), as a JSON array of project ids. Deliberately NOT `project_id`: that one
            -- records where the source Markdown was read from, and a backlog derived from a wiki is
            -- routinely validated against repos that had nothing to do with writing it. Several,
            -- because one capability is routinely split across a service, its BFF and its jobs, and
            -- a criterion checked against only one of them comes back failing for the wrong reason.
            verify_project_ids TEXT NOT NULL DEFAULT '[]',
            -- Where the `.feature` file is written. One repository, not the set above: the criteria
            -- may live in several places, but a spec file copied into each would be several files
            -- drifting apart.
            feature_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
            -- Superseded by `verify_project_ids`; kept so an older build reading this database still
            -- finds the column it expects. Nothing writes it any more.
            verify_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
            -- What the last verification ran on, and when. Snapshotted like `provider`/`model`
            -- above: a verdict is only worth as much as the engine and the moment that produced it,
            -- and QA has to be able to see both before trusting a green criterion.
            verify_provider TEXT NOT NULL DEFAULT '',
            verify_model    TEXT NOT NULL DEFAULT '',
            verified_at     TEXT NOT NULL DEFAULT '',
            -- 'draft' | 'generating' | 'ready' | 'error'. `generating` is only meaningful inside
            -- the session that set it; a row still saying so at startup is demoted on load.
            status        TEXT NOT NULL DEFAULT 'draft',
            last_error    TEXT NOT NULL DEFAULT '',
            created_at    TEXT NOT NULL,
            updated_at    TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_story_batches_workspace
            ON story_batches(workspace_id, updated_at DESC);

        -- One user story: what the model proposed, as the user has since edited it, plus where it
        -- ended up on the board.
        --
        -- `work_item_id` is the whole point of keeping these rows after a publish: it is what stops
        -- a second click on "publish" creating a duplicate work item, and what lets the card link
        -- to the real thing. A published story is deliberately still editable here — the edit just
        -- no longer travels to the board, and the card says so.
        CREATE TABLE IF NOT EXISTS story_drafts (
            id            TEXT PRIMARY KEY,
            batch_id      TEXT NOT NULL REFERENCES story_batches(id) ON DELETE CASCADE,
            seq           INTEGER NOT NULL DEFAULT 0,
            title         TEXT NOT NULL DEFAULT '',
            -- "Como <rol>, quiero <capacidad>, para <beneficio>".
            narrative     TEXT NOT NULL DEFAULT '',
            description   TEXT NOT NULL DEFAULT '',
            -- JSON array of strings, one Gherkin criterion per element (each may be multi-line).
            acceptance_criteria TEXT NOT NULL DEFAULT '[]',
            -- Azure Boards' own scale: 1 (critical) to 4 (low). 0 means "leave the field alone".
            priority      INTEGER NOT NULL DEFAULT 0,
            -- REAL, not INTEGER: Azure accepts fractional estimates and half-points are real usage.
            story_points  REAL NOT NULL DEFAULT 0,
            tags          TEXT NOT NULL DEFAULT '',
            notes         TEXT NOT NULL DEFAULT '',
            -- 0 until published; the host's numeric id afterwards. Jira issues have one of these
            -- as well as their key, which is what let this column stay an integer — and what keeps
            -- `work_item_id = 0` meaning "not published yet" on both boards.
            work_item_id  INTEGER NOT NULL DEFAULT 0,
            -- What the board calls it out loud: Jira's 'PROJ-123'. Empty on Azure, where the id is
            -- the name, and the card falls back to '#id'.
            work_item_key TEXT NOT NULL DEFAULT '',
            work_item_url TEXT NOT NULL DEFAULT '',
            -- What the last "check this against the code" run concluded for this story.
            -- '' (never checked) | 'pass' | 'partial' | 'fail' | 'unknown'. Rolled up from the
            -- per-criterion verdicts below rather than taken from the model, so the badge on the
            -- card can never disagree with the criteria it summarises.
            verify_status   TEXT NOT NULL DEFAULT '',
            verify_summary  TEXT NOT NULL DEFAULT '',
            -- JSON array positionally aligned with `acceptance_criteria`: one
            -- {verdict, evidence[], note, covered_by_test} per criterion. Same encoding as the
            -- criteria themselves, and for the same reason — evidence is multi-line.
            verify_criteria TEXT NOT NULL DEFAULT '[]',
            -- When this story's verdicts were produced. Cleared whenever the criteria are edited:
            -- a verdict about text that has since changed is worse than no verdict, because QA
            -- stops looking exactly where the gap now is.
            verified_at     TEXT NOT NULL DEFAULT '',
            -- 'draft' | 'published' | 'error'
            status        TEXT NOT NULL DEFAULT 'draft',
            last_error    TEXT NOT NULL DEFAULT '',
            created_at    TEXT NOT NULL,
            updated_at    TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_story_drafts_batch
            ON story_drafts(batch_id, seq);

        -- One review session over a work item that already exists on the board.
        --
        -- The review reads Azure and writes nothing back, so before this table a session was worth
        -- exactly what the user had copied out of it before closing the window — three AI runs and
        -- several minutes of reading repositories, gone on a tab switch. What is kept is the review
        -- *as the user left it*: the story text they edited, and the proposals that survived their
        -- triage.
        --
        -- A row is one **session**, not one work item. Re-reviewing #4821 next sprint is a new row,
        -- because the interesting question is what the review said *then* versus what it says now;
        -- the three stages of a single sitting share one id and update in place, because they are
        -- one review answering in three parts.
        --
        -- Deliberately a snapshot and deliberately not reconciled: the item on Azure moves under it
        -- and this row does not follow. That is what makes it a record. The screen says so when it
        -- reopens one, and reloading from Azure is one click away.
        CREATE TABLE IF NOT EXISTS work_item_reviews (
            id             TEXT PRIMARY KEY,
            workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            -- Where the item lives, so a reopened session can go back for a fresh copy.
            ado_org        TEXT NOT NULL DEFAULT '',
            work_item_id   INTEGER NOT NULL DEFAULT 0,
            work_item_type TEXT NOT NULL DEFAULT '',
            work_item_url  TEXT NOT NULL DEFAULT '',
            -- The title as the user last had it, which is what the history list shows. Not
            -- necessarily Azure's: editing the local copy is the point of the screen.
            title          TEXT NOT NULL DEFAULT '',
            -- The whole session as JSON — story text, criteria, and each stage's proposals with
            -- what was dismissed. One blob rather than a table per proposal kind: nothing queries
            -- inside it, and the shape belongs to the screen that wrote it.
            payload        TEXT NOT NULL DEFAULT '{}',
            -- What produced it. Snapshotted like `story_batches.model` and for the same reason: a
            -- judgement is worth what the engine behind it was, and re-reading today's routing
            -- would rewrite the past.
            engine         TEXT NOT NULL DEFAULT '',
            model          TEXT NOT NULL DEFAULT '',
            version        TEXT NOT NULL DEFAULT '',
            created_at     TEXT NOT NULL,
            updated_at     TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_work_item_reviews_workspace
            ON work_item_reviews(workspace_id, updated_at DESC);

        -- One page of generated technical documentation, before and after the user edits it.
        --
        -- `project_id` is what makes the two scopes one table rather than two. A **repository**
        -- document names the repo it describes; a **workspace** document names none, because its
        -- subject is precisely what happens *between* the repositories — how they integrate and
        -- what they solve together. That is not a missing project_id, it is a different question,
        -- so `scope` says which on the row rather than leaving the reader to infer it from a null.
        --
        -- `content` is the document as it stands: generated once, then edited by hand, with no
        -- record of which words came from which. Keeping the model's original alongside was
        -- considered and dropped — a diff nobody reads costs a column and invites the question of
        -- which one publishes.
        --
        -- The publish target lives here rather than on the workspace because a team routinely puts
        -- its architecture page in one wiki and a service's runbook in another, and because the
        -- page path is per-document by nature.
        CREATE TABLE IF NOT EXISTS doc_pages (
            id            TEXT PRIMARY KEY,
            workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            -- The repository this documents. Null for a workspace-scope document.
            project_id    TEXT REFERENCES projects(id) ON DELETE CASCADE,
            -- 'repo' | 'workspace'
            scope         TEXT NOT NULL DEFAULT 'repo',
            title         TEXT NOT NULL DEFAULT '',
            -- Markdown, which is what an Azure DevOps wiki page is.
            content       TEXT NOT NULL DEFAULT '',
            -- Where it publishes. Empty until the user picks a target.
            ado_org       TEXT NOT NULL DEFAULT '',
            ado_project   TEXT NOT NULL DEFAULT '',
            wiki_id       TEXT NOT NULL DEFAULT '',
            wiki_name     TEXT NOT NULL DEFAULT '',
            -- Wiki-absolute, e.g. '/Servicios/Checkout API'.
            page_path     TEXT NOT NULL DEFAULT '',
            published_at  TEXT NOT NULL DEFAULT '',
            published_url TEXT NOT NULL DEFAULT '',
            -- What generated it. Snapshotted like `story_batches.model`: documentation is only
            -- worth what the engine that read the code was, and re-reading today's routing would
            -- rewrite what a page published last month says about itself.
            engine        TEXT NOT NULL DEFAULT '',
            model         TEXT NOT NULL DEFAULT '',
            version       TEXT NOT NULL DEFAULT '',
            -- 'draft' | 'generating' | 'ready' | 'error'. `generating` is only meaningful inside
            -- the session that set it; a row still saying so at startup is demoted on load.
            status        TEXT NOT NULL DEFAULT 'draft',
            last_error    TEXT NOT NULL DEFAULT '',
            created_at    TEXT NOT NULL,
            updated_at    TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_doc_pages_workspace
            ON doc_pages(workspace_id, updated_at DESC);

        -- MCP servers configured per workspace; written out as a --mcp-config JSON file for
        -- headless `claude -p` invocations against any project in the workspace.
        CREATE TABLE IF NOT EXISTS workspace_mcps (
            id           TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            name         TEXT NOT NULL,
            command      TEXT NOT NULL,
            args         TEXT NOT NULL DEFAULT '',
            env          TEXT NOT NULL DEFAULT '',
            enabled      INTEGER NOT NULL DEFAULT 1,
            created_at   TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS app_settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        -- Persisted record of every AI chat question/answer turn, scoped per project — the
        -- chat itself (chatStore) only lives in memory for the session, so without this a
        -- restart silently loses everything that was ever asked. `session_id` is the Claude
        -- Code session these turns can be `--resume`d under; rows sharing one `session_id`
        -- reconstruct a full conversation, letting the UI list/reopen/continue past chats
        -- instead of only ever having one ongoing conversation per project.
        CREATE TABLE IF NOT EXISTS activity_log (
            id          TEXT PRIMARY KEY,
            project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            session_id  TEXT,
            question    TEXT NOT NULL,
            answer      TEXT NOT NULL,
            created_at  TEXT NOT NULL
        );

        -- Persisted record of every finished PR review / pre-commit analysis run — like
        -- `activity_log` above, `jobsStore` on the frontend only lives in memory for the
        -- session, so without this a restart silently loses every past review/analysis
        -- result. Only successful/errored *completed* runs are recorded (there's nothing
        -- meaningful to reopen from a run that was still in flight when the app closed).
        CREATE TABLE IF NOT EXISTS job_history (
            id           TEXT PRIMARY KEY,
            project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            kind         TEXT NOT NULL,
            label        TEXT NOT NULL,
            custom_label TEXT,
            status       TEXT NOT NULL,
            result       TEXT,
            error        TEXT,
            meta         TEXT NOT NULL DEFAULT '{}',
            created_at   TEXT NOT NULL
        );

        -- The same record as `job_history`, for the work that belongs to no repository: a pull
        -- request reviewed straight from its link, with nothing cloned. Such a review can't be
        -- filed against a project (there isn't one, and inventing a row for a repo the user
        -- doesn't have would put a phantom in the sidebar), yet it is still something that
        -- happened and is worth reopening — so it is filed against the WORKSPACE it was run in.
        -- That is also the scope the user sees it at: it shows in Activity whichever repository
        -- of the workspace is open, and disappears on switching to another workspace.
        CREATE TABLE IF NOT EXISTS workspace_activity (
            id           TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            kind         TEXT NOT NULL,
            label        TEXT NOT NULL,
            custom_label TEXT,
            status       TEXT NOT NULL,
            result       TEXT,
            error        TEXT,
            meta         TEXT NOT NULL DEFAULT '{}',
            created_at   TEXT NOT NULL
        );

        -- A user-given rename for a chat conversation (`activity_log` rows grouped by
        -- `session_id`) — conversations don't otherwise have a row of their own to attach a
        -- title to, since they're just a GROUP BY over individual question/answer turns.
        CREATE TABLE IF NOT EXISTS conversation_titles (
            session_id  TEXT PRIMARY KEY,
            project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            title       TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        );

        -- ===================== API client (per workspace) =====================
        -- Scoped to a WORKSPACE, not to a project: a collection describes a *service*, and the
        -- several repos of one workspace (frontend, backend, infra) normally talk to the same
        -- one — scoping per repo would mean re-creating the same collection in each. Scoping per
        -- workspace also keeps environments and the cookie jar from leaking a staging session
        -- from one client's workspace into another's.
        --
        -- Only the roots carry `workspace_id`: folders and requests reach it through their
        -- collection, so there is exactly one place a row's workspace can be wrong.
        --
        -- The editable content of a request lives in one `spec` JSON blob rather than in
        -- columns, so adding a protocol, an auth scheme or a body mode never needs a migration.

        CREATE TABLE IF NOT EXISTS api_collections (
            id           TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL DEFAULT '' REFERENCES workspaces(id) ON DELETE CASCADE,
            -- 'workspace' or 'global' — see `note_books.scope`, which states the whole design.
            --
            -- Collections are the one scoped thing that also travels between machines, so this
            -- column has a second rule: it is *local placement*, never the host's decision.
            -- `api_sync::comparable` strips it before diffing and `localise_collection` restores
            -- the local value on every pull, the same way `sort_order` and `pinned` are handled.
            scope        TEXT NOT NULL DEFAULT 'workspace',
            name        TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            -- JSON AuthConfig; '' = nothing configured (children fall through to "none").
            auth        TEXT NOT NULL DEFAULT '',
            pre_script  TEXT NOT NULL DEFAULT '',
            post_script TEXT NOT NULL DEFAULT '',
            -- JSON ApiVariable[] — collection-scoped variables.
            variables   TEXT NOT NULL DEFAULT '[]',
            sort_order  INTEGER NOT NULL DEFAULT 0,
            -- Pinned collections sort above the rest, whatever their sort_order.
            pinned      INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        );

        -- Folders nest arbitrarily (`parent_id` self-references); NULL means "directly under the
        -- collection". Kept as a separate table from requests so a folder can carry its own
        -- auth/scripts, which requests inherit.
        CREATE TABLE IF NOT EXISTS api_folders (
            id            TEXT PRIMARY KEY,
            collection_id TEXT NOT NULL REFERENCES api_collections(id) ON DELETE CASCADE,
            parent_id     TEXT REFERENCES api_folders(id) ON DELETE CASCADE,
            name          TEXT NOT NULL,
            description   TEXT NOT NULL DEFAULT '',
            auth          TEXT NOT NULL DEFAULT '',
            pre_script    TEXT NOT NULL DEFAULT '',
            post_script   TEXT NOT NULL DEFAULT '',
            sort_order    INTEGER NOT NULL DEFAULT 0,
            created_at    TEXT NOT NULL,
            -- Carried so a restore and a shared-workspace pull can both resolve last-write-wins on
            -- a folder the same way they do on a request.
            updated_at    TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_api_folders_parent
            ON api_folders (collection_id, parent_id, sort_order);

        CREATE TABLE IF NOT EXISTS api_requests (
            id            TEXT PRIMARY KEY,
            collection_id TEXT NOT NULL REFERENCES api_collections(id) ON DELETE CASCADE,
            folder_id     TEXT REFERENCES api_folders(id) ON DELETE CASCADE,
            name          TEXT NOT NULL,
            -- http | graphql | websocket | socketio | grpc | mqtt
            protocol      TEXT NOT NULL DEFAULT 'http',
            -- Denormalized out of `spec` purely so the tree can render method+URL without
            -- parsing every blob.
            method        TEXT NOT NULL DEFAULT 'GET',
            url           TEXT NOT NULL DEFAULT '',
            -- JSON ApiRequestSpec: params, headers, body, auth, scripts, protocol settings.
            spec          TEXT NOT NULL DEFAULT '{}',
            sort_order    INTEGER NOT NULL DEFAULT 0,
            created_at    TEXT NOT NULL,
            updated_at    TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_api_requests_parent
            ON api_requests (collection_id, folder_id, sort_order);

        -- Environments are global too. Exactly one row has `is_global = 1`: the "Globals"
        -- pseudo-environment, which is always in scope and can't be deleted or switched away
        -- from (see `ensure_globals_environment`).
        CREATE TABLE IF NOT EXISTS api_environments (
            id           TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL DEFAULT '' REFERENCES workspaces(id) ON DELETE CASCADE,
            name        TEXT NOT NULL,
            -- JSON ApiVariable[] — initial vs current value, secret flag, enabled flag.
            variables   TEXT NOT NULL DEFAULT '[]',
            is_global   INTEGER NOT NULL DEFAULT 0,
            sort_order  INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL DEFAULT ''
        );

        -- Every send, whether or not it came from a saved request (`request_id` is NULL for
        -- ad-hoc sends). `snapshot` holds the full request spec + response so an old entry can
        -- be replayed or restored into the builder exactly as it was.
        CREATE TABLE IF NOT EXISTS api_history (
            id           TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL DEFAULT '' REFERENCES workspaces(id) ON DELETE CASCADE,
            request_id  TEXT,
            name        TEXT NOT NULL DEFAULT '',
            protocol    TEXT NOT NULL DEFAULT 'http',
            method      TEXT NOT NULL DEFAULT '',
            url         TEXT NOT NULL DEFAULT '',
            status      INTEGER,
            duration_ms INTEGER,
            size_bytes  INTEGER,
            snapshot    TEXT NOT NULL DEFAULT '{}',
            created_at  TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_api_history_time ON api_history (workspace_id, created_at DESC);

        -- The cookie jar. Persisted rather than kept in the reqwest client because the client is
        -- rebuilt per request (per-request SSL/proxy/redirect overrides make a shared client
        -- impossible), so nothing in the transport layer can hold jar state across sends.
        CREATE TABLE IF NOT EXISTS api_cookies (
            id         TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL DEFAULT '' REFERENCES workspaces(id) ON DELETE CASCADE,
            domain     TEXT NOT NULL,
            path       TEXT NOT NULL DEFAULT '/',
            name       TEXT NOT NULL,
            value      TEXT NOT NULL DEFAULT '',
            secure     INTEGER NOT NULL DEFAULT 0,
            http_only  INTEGER NOT NULL DEFAULT 0,
            expires    TEXT,
            updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_api_cookies_key
            ON api_cookies (workspace_id, domain, path, name);

        -- What was deleted, and when. A deletion has to leave a trace: to anything reading changes
        -- since a point in time — a shared workspace, another machine — "absent" and "not created
        -- yet" are the same observation, so without this row a delete would be undone by the next
        -- pull instead of travelling.
        --
        -- Recorded for every workspace, not only shared ones: a workspace can be shared after the
        -- fact, and a deletion history that started when sharing did would resurrect everything
        -- removed before it.
        CREATE TABLE IF NOT EXISTS api_tombstones (
            id           TEXT NOT NULL,
            workspace_id TEXT NOT NULL,
            -- collection | folder | request | environment
            kind         TEXT NOT NULL,
            deleted_at   TEXT NOT NULL,
            -- The collection the deleted row belonged to ('' for environments, which belong to a
            -- workspace). Sharing is per collection, so a push has to be able to select the
            -- tombstones of *its* subtree and no one else's.
            collection_id TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (workspace_id, kind, id)
        );

        -- ---------------------------------------------------------------------
        -- Collaboration: one shared collection per row
        -- ---------------------------------------------------------------------

        -- Which collections are shared on the user's Supabase project, and where each one's sync
        -- has got to. The share TOKEN is not here — it is the credential, and lives in the OS
        -- credential store (see `secrets::supabase_share_token`).
        --
        -- `workspace_id` is denormalised from the collection so the collaboration panel can group
        -- shares by workspace without loading every tree.
        --
        -- Deliberately NOT a foreign key onto `api_collections`. The row has to exist both before
        -- the collection does (accepting an invitation registers the share, and the first pull is
        -- what creates the collection) and after it stops (deleting a shared collection has to
        -- stay shared long enough for the tombstone to be pushed, or the deletion never reaches
        -- anyone else). A cascade would break the first case and silently swallow the second.
        CREATE TABLE IF NOT EXISTS api_shared_collections (
            collection_id TEXT PRIMARY KEY,
            workspace_id  TEXT NOT NULL,
            -- The Supabase project this particular share lives on. Per share, not per install:
            -- hosting your own collections and accepting an invitation to a collection on someone
            -- else's project are both normal, and often at the same time. A single global URL made
            -- the second invitation silently break the first.
            project_url   TEXT NOT NULL DEFAULT '',
            -- The name the remote knows it by; shown while joining, before the tree has it.
            remote_name   TEXT NOT NULL DEFAULT '',
            -- 'owner' for whoever created the share, 'member' for whoever accepted an invitation.
            -- Purely informational: the token grants the same rights to both.
            role          TEXT NOT NULL DEFAULT 'owner',
            -- Newest server `synced_at` already applied — where the next pull starts.
            cursor        TEXT NOT NULL DEFAULT '',
            -- Newest server `synced_at` the watermark probe has *seen*. A pull is only worth
            -- running when this is ahead of `cursor`.
            watermark     TEXT NOT NULL DEFAULT '',
            last_sync_at  TEXT NOT NULL DEFAULT '',
            last_error    TEXT NOT NULL DEFAULT '',
            created_at    TEXT NOT NULL
        );

        -- The common ancestor of a three-way merge: what each record looked like the last time this
        -- machine and the server agreed about it.
        --
        -- Without it, "someone else changed this" and "I changed this" are indistinguishable, and
        -- the only available policy is last-write-wins — which silently drops the losing edit. With
        -- it, a record whose local timestamp moved *and* whose remote timestamp moved is a conflict
        -- to be shown, not a coin toss to be resolved.
        CREATE TABLE IF NOT EXISTS api_sync_base (
            collection_id TEXT NOT NULL,
            kind          TEXT NOT NULL,
            id            TEXT NOT NULL,
            -- The record's `updated_at` at the moment of agreement, as the *remote* carried it.
            base_updated_at TEXT NOT NULL,
            PRIMARY KEY (collection_id, kind, id)
        );

        -- Records frozen pending a decision: neither applied nor pushed until the user picks a
        -- side. Holds the incoming payload verbatim so "take theirs" needs no second round trip,
        -- and so the diff can be shown without one either.
        CREATE TABLE IF NOT EXISTS api_sync_conflicts (
            collection_id     TEXT NOT NULL,
            kind              TEXT NOT NULL,
            id                TEXT NOT NULL,
            remote_payload    TEXT NOT NULL,
            remote_updated_at TEXT NOT NULL,
            local_updated_at  TEXT NOT NULL,
            /* 1 when the incoming change is a deletion rather than an edit. */
            remote_deleted    INTEGER NOT NULL DEFAULT 0,
            detected_at       TEXT NOT NULL,
            PRIMARY KEY (collection_id, kind, id)
        );

        -- ---------------------------------------------------------------------
        -- Database workspace
        -- ---------------------------------------------------------------------
        --
        -- Scoped to the workspace, exactly like `api_collections`: a database is a property of the
        -- service a workspace's repositories talk to, not of any one repository, so switching
        -- repository must not change which databases are on screen.
        --
        -- **No password column, by construction.** Credentials live in the OS keychain under
        -- `db-password:<id>` (see `datasource::password_key`). This table is a plain-text file in
        -- the user's config directory; a database password in it would be readable by anything that
        -- can read a file.
        -- A folder in the connection tree, as a row of its own. The same split as `remote_groups`
        -- below, for the same reason and with the same trade-offs: connections carry `group_name`
        -- as text and that is what puts one in a group, while this table owns only the group's
        -- *existence* — the one thing the string alone cannot express is a group with nothing in
        -- it, which is exactly the state between creating a folder and filling it.
        CREATE TABLE IF NOT EXISTS db_groups (
            id           TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL DEFAULT '' REFERENCES workspaces(id) ON DELETE CASCADE,
            name         TEXT NOT NULL,
            -- 'workspace' or 'global' — see `note_books.scope`.
            --
            -- A group is a *name*, not a container, so re-scoping one only means anything if its
            -- members go with it: `set_group_scope` rewrites the connections too, because a group
            -- whose members are invisible renders as an empty folder rather than as a group.
            scope        TEXT NOT NULL DEFAULT 'workspace',
            sort_order   INTEGER NOT NULL DEFAULT 0,
            created_at   TEXT NOT NULL
        );
        -- One row per name per workspace. The tree renders a group once whether it is here, implied
        -- by a connection, or both, so a duplicate would be invisible in the UI and confusing in
        -- the data.
        --
        -- Note what this does *not* say now that groups can be global: a global group "Prod" and a
        -- workspace group "Prod" are two rows with different `workspace_id`, so the index permits
        -- both, and `groupConnections` merges them into one bucket on screen. That is why the three
        -- group writers address `(workspace_id = ?1 OR scope = 'global')` rather than
        -- `workspace_id = ?1` — otherwise a rename would move half of a bucket. Making the index
        -- span both scopes instead would mean rebuilding the table, which SQLite has no ALTER for.
        CREATE UNIQUE INDEX IF NOT EXISTS idx_db_groups_name
            ON db_groups (workspace_id, name);

        CREATE TABLE IF NOT EXISTS db_connections (
            id           TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL DEFAULT '' REFERENCES workspaces(id) ON DELETE CASCADE,
            -- 'workspace' or 'global' — see `note_books.scope`.
            scope        TEXT NOT NULL DEFAULT 'workspace',
            name         TEXT NOT NULL,
            -- Free text, and the sole record of *membership* — see `db_groups` above for what that
            -- table adds and why it deliberately isn't a foreign key. Empty means ungrouped, which
            -- the tree shows as a bucket of its own rather than as a group named "".
            group_name   TEXT NOT NULL DEFAULT '',
            -- postgres | supabase | sqlserver | iris | mongodb | redis
            kind         TEXT NOT NULL,
            -- JSON: host, port, database, user, url, ssl, options, read_only, timeout. One blob
            -- rather than columns for the same reason `api_requests` keeps a `spec` — a new engine
            -- or a new driver option ships without a migration.
            spec         TEXT NOT NULL DEFAULT '{}',
            -- Tints the connection's row and its consoles' tabs, so "am I on production?" is
            -- answerable at a glance rather than by reading a hostname.
            color        TEXT NOT NULL DEFAULT '',
            sort_order   INTEGER NOT NULL DEFAULT 0,
            created_at   TEXT NOT NULL,
            updated_at   TEXT NOT NULL
        );

        -- A saved SQL/Mongo console. Its own table rather than a file on disk because a console is
        -- bound to a connection (and to a database within it) and is meaningless without one.
        CREATE TABLE IF NOT EXISTS db_consoles (
            id            TEXT PRIMARY KEY,
            connection_id TEXT NOT NULL REFERENCES db_connections(id) ON DELETE CASCADE,
            name          TEXT NOT NULL,
            body          TEXT NOT NULL DEFAULT '',
            -- Which database/namespace and schema the console is pointed at. Stored so reopening it
            -- lands where it was left, rather than on the connection's default.
            database_name TEXT NOT NULL DEFAULT '',
            schema_name   TEXT NOT NULL DEFAULT '',
            sort_order    INTEGER NOT NULL DEFAULT 0,
            created_at    TEXT NOT NULL,
            updated_at    TEXT NOT NULL
        );

        -- Every statement that ran, with what it cost.
        --
        -- `connection_id` deliberately carries no foreign key: deleting a connection must not erase
        -- the record of what was run against it. `connection_name` is denormalized for the same
        -- reason — it is the only thing left naming the connection once the row is gone.
        CREATE TABLE IF NOT EXISTS db_query_history (
            id              TEXT PRIMARY KEY,
            workspace_id    TEXT NOT NULL DEFAULT '' REFERENCES workspaces(id) ON DELETE CASCADE,
            connection_id   TEXT NOT NULL DEFAULT '',
            connection_name TEXT NOT NULL DEFAULT '',
            statement       TEXT NOT NULL,
            database_name   TEXT NOT NULL DEFAULT '',
            duration_ms     INTEGER NOT NULL DEFAULT 0,
            row_count       INTEGER NOT NULL DEFAULT 0,
            -- Empty when the statement succeeded. Kept rather than dropped: a failed statement is
            -- the one most worth finding again, because it is about to be fixed and re-run.
            error           TEXT NOT NULL DEFAULT '',
            ran_at          TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_db_history_time
            ON db_query_history (workspace_id, ran_at DESC);

        -- A folder in the host tree, as a row of its own.
        --
        -- Hosts still carry `group_name` as text and that is still what puts a host in a group —
        -- this table does not own the membership, it owns the group's *existence*. The reason is
        -- the one thing the string alone cannot express: a group with nothing in it. Creating a
        -- folder and then filling it is the order people actually work in, and with membership as
        -- the only record, a folder vanishes the moment you empty it — including between creating
        -- it and dragging the first host in.
        --
        -- Keeping membership as text rather than a foreign key is deliberate too: a host whose
        -- group row is missing is still a host, in a group that renders from its own name. There is
        -- no orphan state to repair.
        CREATE TABLE IF NOT EXISTS remote_groups (
            id           TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL DEFAULT '' REFERENCES workspaces(id) ON DELETE CASCADE,
            name         TEXT NOT NULL,
            sort_order   INTEGER NOT NULL DEFAULT 0,
            created_at   TEXT NOT NULL
        );
        -- One row per name per workspace. The tree renders a group once whether it is here, implied
        -- by a host, or both, so a duplicate would be invisible in the UI and confusing in the data.
        CREATE UNIQUE INDEX IF NOT EXISTS idx_remote_groups_name
            ON remote_groups (workspace_id, name);

        -- A machine reachable over SSH, SFTP, FTP or FTPS: what it can do is decided by the `kind`
        -- inside `spec` — see `remotes::RemoteKind`.
        CREATE TABLE IF NOT EXISTS remote_hosts (
            id           TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL DEFAULT '' REFERENCES workspaces(id) ON DELETE CASCADE,
            name         TEXT NOT NULL,
            -- Free text, and still the sole record of *membership* — see `remote_groups` above for
            -- what that table adds and why it deliberately isn't a foreign key. Nesting is what
            -- the one-level shape gives up, and an estate deep enough to need it wants tags rather
            -- than deeper folders anyway.
            group_name   TEXT NOT NULL DEFAULT '',
            -- JSON: kind, host, port, user, auth, key_file, jump, os, options, command, screen,
            -- forwards, ftp. One blob rather than columns for the same reason `db_connections.spec`
            -- is one — a new flag ships without a migration. Never holds a password.
            spec         TEXT NOT NULL DEFAULT '{}',
            -- Tints the host's row and its sessions' tabs, so "am I on production?" is answerable
            -- at a glance rather than by reading a hostname.
            color        TEXT NOT NULL DEFAULT '',
            sort_order   INTEGER NOT NULL DEFAULT 0,
            created_at   TEXT NOT NULL,
            updated_at   TEXT NOT NULL
        );

        -- What was opened against which host, and whether it worked.
        --
        -- `host_id` deliberately carries no foreign key, and `host_name` is denormalized, for the
        -- reason `db_query_history` gives: deleting a host must not erase the record of what was
        -- done with it, and the name is the only thing left naming it afterwards.
        CREATE TABLE IF NOT EXISTS remote_log (
            id           TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL DEFAULT '' REFERENCES workspaces(id) ON DELETE CASCADE,
            host_id      TEXT NOT NULL DEFAULT '',
            host_name    TEXT NOT NULL DEFAULT '',
            -- session | forward | screen | files
            kind         TEXT NOT NULL,
            detail       TEXT NOT NULL DEFAULT '',
            -- Empty when it worked. Kept rather than dropped: a failure is the entry most worth
            -- finding again, because it is the one about to be diagnosed.
            error        TEXT NOT NULL DEFAULT '',
            at           TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_remote_log_time ON remote_log (workspace_id, at DESC);

        -- A command to send into a session. Scoped to the workspace, not to a host: the point of a
        -- snippet is that it runs on more than one of them.
        CREATE TABLE IF NOT EXISTS remote_snippets (
            id           TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL DEFAULT '' REFERENCES workspaces(id) ON DELETE CASCADE,
            name         TEXT NOT NULL,
            body         TEXT NOT NULL DEFAULT '',
            sort_order   INTEGER NOT NULL DEFAULT 0,
            created_at   TEXT NOT NULL,
            updated_at   TEXT NOT NULL
        );

        -- A book in the Notes workspace: one shelf of notes.
        --
        -- Nested, unlike `remote_groups` — and the difference is not taste. A host list is an
        -- inventory of a few dozen machines that reads better flat; notes are written over years
        -- and the thing that keeps them findable is the shape the author gave them, which is a
        -- hierarchy. `parent_id` is a real foreign key onto this same table (Remote's
        -- `group_name` is free text on purpose; see that table) because a book here is
        -- addressed by identity: it can be renamed and moved without every note inside it having
        -- to be rewritten.
        --
        -- ON DELETE CASCADE onto itself removes the subtree. What it does *not* remove is the
        -- notes — see `notes.book_id`.
        CREATE TABLE IF NOT EXISTS note_books (
            id           TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            -- 'workspace' (the default, and what every row was before this column) or 'global'.
            --
            -- A global book sits on every workspace's shelf. `workspace_id` keeps its foreign key
            -- and its cascade and becomes the book's *home*: where it was made, and what
            -- `queries::rehome_global_rows` moves it out of when that workspace is deleted. There
            -- is no third spelling — a global row cannot be `workspace_id = ''`, because the
            -- column references `workspaces(id)` and SQLite will not take a non-null value with
            -- no parent row.
            scope        TEXT NOT NULL DEFAULT 'workspace',
            -- Null is the root of the tree, which is a real place: an unfiled note is the normal
            -- state of a note that was just written, not an error to be corrected.
            parent_id    TEXT REFERENCES note_books(id) ON DELETE CASCADE,
            name         TEXT NOT NULL,
            -- Tints the book's glyph, the same affordance `remote_hosts.color` gives a host:
            -- "which of these is work and which is the runbook" answered without reading.
            color        TEXT NOT NULL DEFAULT '',
            sort_order   INTEGER NOT NULL DEFAULT 0,
            created_at   TEXT NOT NULL,
            updated_at   TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_note_books_tree
            ON note_books (workspace_id, parent_id, sort_order);

        -- A Markdown note.
        --
        -- Three of these columns are derived from `content` and stored anyway — `excerpt`,
        -- `word_count`, and the `tags` array. That is deliberate, and it is the single decision
        -- this table exists to make: **the note list must never carry note bodies.** A workspace
        -- with four hundred notes is a few megabytes of Markdown, and the sidebar renders titles.
        -- `list_notes` therefore projects every column *except* `content`, and the card in the
        -- gallery gets its two lines of preview from `excerpt` rather than from slicing a body
        -- nobody loaded. The bodies arrive one at a time through `get_note`.
        --
        -- The cost of that is an invariant: whatever writes `content` must rewrite the derived
        -- columns in the same statement. `note_queries::save_note` is the only writer, and it
        -- computes all three — which is why the derivation lives in Rust rather than being
        -- passed in by the caller.
        CREATE TABLE IF NOT EXISTS notes (
            id           TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            -- Denormalised from the book this note is in, and the only column here that is a copy
            -- of something else. It buys the property `load_tree` is built on: the notes read
            -- stays one statement with no join, which is what makes the whole workspace's note
            -- list affordable to hold at once.
            --
            -- The cost is an invariant, and it is narrow: exactly three writers set it —
            -- `create_note` and `move_note` inherit it from the destination book, and
            -- `set_book_scope` rewrites the subtree. Nothing else may write it.
            scope        TEXT NOT NULL DEFAULT 'workspace',
            -- Every note belongs to a book: the Notes view browses books and shows what is inside
            -- them, so a note outside every book is a note with no surface to be reached from.
            -- `file_loose_notes_into_a_book` brought the rows written under the old rule inside,
            -- and `note_queries::create_note` takes a non-optional book id.
            --
            -- The column stays nullable and the action stays SET NULL, because neither is what
            -- enforces the rule and changing them would mean rebuilding the table on every
            -- existing database. `note_queries::delete_book` deletes the subtree's notes itself,
            -- in the same transaction and *before* the books, so this clause never fires — it is
            -- the backstop that would leave a visible orphan rather than a dangling reference if
            -- some future path forgets.
            book_id    TEXT REFERENCES note_books(id) ON DELETE SET NULL,
            title        TEXT NOT NULL DEFAULT '',
            content      TEXT NOT NULL DEFAULT '',
            -- First prose of the body, marks stripped, capped. Derived; see above.
            excerpt      TEXT NOT NULL DEFAULT '',
            -- JSON array of strings. A join table would count tags in SQL, but the whole note
            -- list is already in memory for the sidebar, so counting there is a pass over a few
            -- hundred rows — against which a second table costs a join on every read and a
            -- transaction on every save.
            tags         TEXT NOT NULL DEFAULT '[]',
            pinned       INTEGER NOT NULL DEFAULT 0,
            -- Derived; see above. Stored so the gallery can sort and label by length without
            -- reading a single body.
            word_count   INTEGER NOT NULL DEFAULT 0,
            sort_order   INTEGER NOT NULL DEFAULT 0,
            created_at   TEXT NOT NULL,
            updated_at   TEXT NOT NULL
        );
        -- The gallery's default order, and the sidebar's: most recently touched first.
        CREATE INDEX IF NOT EXISTS idx_notes_recent ON notes (workspace_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_notes_book ON notes (book_id, sort_order);

        -- A note skeleton the user starts from.
        --
        -- Only the user's own. The templates that ship with the app are a TypeScript constant
        -- (`lib/notes/builtinTemplates.ts`) and not seeded rows, for two reasons: seeded rows
        -- would need a migration every time one is improved, and — the deciding one — they have
        -- to be translated. A row holds one language; a constant is read through `translate` and
        -- follows the user's.
        CREATE TABLE IF NOT EXISTS note_templates (
            id           TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            name         TEXT NOT NULL,
            description  TEXT NOT NULL DEFAULT '',
            -- A lucide icon name, so a template is recognisable in the picker before it is read.
            icon         TEXT NOT NULL DEFAULT 'file-text',
            content      TEXT NOT NULL DEFAULT '',
            -- Applied to every note made from it, so a template carries its filing as well as its
            -- shape. JSON array, same as `notes.tags`.
            tags         TEXT NOT NULL DEFAULT '[]',
            sort_order   INTEGER NOT NULL DEFAULT 0,
            created_at   TEXT NOT NULL,
            updated_at   TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_note_templates_workspace
            ON note_templates (workspace_id, sort_order);

        -- A folder in the Diagrams tree.
        --
        -- Column for column the same as `note_books`, and that is the point rather than an
        -- accident: the two trees are one gesture over two kinds of document, so the queries, the
        -- drag rules and the recursive delete are all the same shape. Anyone reading one has read
        -- the other.
        CREATE TABLE IF NOT EXISTS diagram_folders (
            id           TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            -- Null is the root, which is a real place — see `diagrams.folder_id`.
            parent_id    TEXT REFERENCES diagram_folders(id) ON DELETE CASCADE,
            name         TEXT NOT NULL,
            color        TEXT NOT NULL DEFAULT '',
            sort_order   INTEGER NOT NULL DEFAULT 0,
            created_at   TEXT NOT NULL,
            updated_at   TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_diagram_folders_tree
            ON diagram_folders (workspace_id, parent_id, sort_order);

        -- A diagram.
        --
        -- Workspace-scoped like a note, and for the same reason: an architecture diagram describes
        -- the system, not a checkout, and it must not change when you click a different repository.
        --
        -- **`folder_id` is nullable and null means the root**, which is where a diagram created
        -- from the gallery lands. This is the one place the Diagrams tree deliberately parts from
        -- `notes`, which forces every note into a book: filing is a decision worth postponing until
        -- after the thing exists, and the explorer draws the root as a real destination.
        --
        -- **`doc` is opaque to this layer and `format` says what it is.** Today an embedded draw.io
        -- writes mxGraph XML (`format = 'mxgraph'`); the column exists so that a second editor, or
        -- a change of mind about the first, is a new value here rather than a rewrite of every row
        -- and every query. Nothing in Rust parses `doc` except `shape_count`, which switches on
        -- this column and falls back to zero for a dialect it does not know.
        CREATE TABLE IF NOT EXISTS diagrams (
            id           TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            folder_id    TEXT REFERENCES diagram_folders(id) ON DELETE SET NULL,
            title        TEXT NOT NULL DEFAULT '',
            doc          TEXT NOT NULL DEFAULT '',
            format       TEXT NOT NULL DEFAULT 'mxgraph',
            -- A standalone SVG the gallery can draw without mounting an editor. Derived by
            -- whatever edits the diagram, not here.
            thumbnail    TEXT NOT NULL DEFAULT '',
            -- JSON array, same as `notes.tags`.
            tags         TEXT NOT NULL DEFAULT '[]',
            pinned       INTEGER NOT NULL DEFAULT 0,
            -- Vertices plus edges. Derived on every write of `doc`; see `diagram_queries::derive`.
            shape_count  INTEGER NOT NULL DEFAULT 0,
            sort_order   INTEGER NOT NULL DEFAULT 0,
            created_at   TEXT NOT NULL,
            updated_at   TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_diagrams_workspace
            ON diagrams (workspace_id, sort_order);
        CREATE INDEX IF NOT EXISTS idx_diagrams_folder ON diagrams (folder_id, sort_order);

        -- A diagram skeleton the user starts from.
        --
        -- The same design as `note_templates`, including the part that matters most: the templates
        -- that ship with the app are seeded into a workspace as **ordinary rows**, once, the first
        -- time it is opened. From then on a shipped template is a row like any other — it can be
        -- renamed, edited or deleted, and deleting it makes it stay deleted. The alternative, a
        -- read-only built-in list drawn above the user's own, gives you two kinds of template that
        -- behave differently in a picker where they sit side by side.
        --
        -- `doc` and `format` mirror `diagrams`, so applying a template is a copy rather than a
        -- conversion — and so a template written by an older editor keeps working.
        CREATE TABLE IF NOT EXISTS diagram_templates (
            id           TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            name         TEXT NOT NULL,
            description  TEXT NOT NULL DEFAULT '',
            -- A lucide icon name, so a template is recognisable in the picker before it is read.
            icon         TEXT NOT NULL DEFAULT 'workflow',
            doc          TEXT NOT NULL DEFAULT '',
            format       TEXT NOT NULL DEFAULT 'mxgraph',
            -- Applied to every diagram made from it, so a template carries its filing as well as
            -- its shape. JSON array, same as `diagrams.tags`.
            tags         TEXT NOT NULL DEFAULT '[]',
            sort_order   INTEGER NOT NULL DEFAULT 0,
            created_at   TEXT NOT NULL,
            updated_at   TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_diagram_templates_workspace
            ON diagram_templates (workspace_id, sort_order);

        -- ---------------- The keyring ("Llavero") ----------------
        --
        -- CodeFlow's own password manager. Read `keyvault/crypto.rs` before changing anything here;
        -- the key hierarchy is stated there and these columns are its storage.
        --
        -- **No foreign key to `workspaces`, anywhere in these five tables.** That is the single most
        -- important decision in this block. Items may be *filed* under a workspace — `workspace_id`
        -- is a plain string where `''` means "everywhere" — but a cascade would mean a password
        -- disappearing as a side effect of tidying up a workspace, and there is no version of that
        -- which is acceptable in a vault. `queries::rehome_global_rows` moves a deleted workspace's
        -- items back to global instead.

        -- Exactly one row, `id = 'vault'`: the wrapped data key and the parameters needed to unwrap
        -- it.
        --
        -- Nothing here can verify a password by comparison. A wrong password fails the GCM tag on
        -- `dek_wrapped`, and that failure *is* the check — so a copy of this file gives an attacker
        -- no way to test guesses faster than by running Argon2 at the cost recorded below. (Contrast
        -- `backup_cmd::backup_passphrase_matches`, which compares a stored string. Not that.)
        CREATE TABLE IF NOT EXISTS vault_meta (
            id             TEXT PRIMARY KEY,
            kdf            TEXT NOT NULL DEFAULT 'argon2id',
            -- Recorded rather than assumed, exactly as the backup header records them, so raising
            -- the cost later cannot strand a vault created today.
            kdf_memory_kib INTEGER NOT NULL,
            kdf_iterations INTEGER NOT NULL,
            kdf_lanes      INTEGER NOT NULL,
            kdf_salt       TEXT NOT NULL,
            dek_nonce      TEXT NOT NULL,
            dek_wrapped    TEXT NOT NULL,
            -- Minutes of inactivity before the vault locks itself. 0 is off, which is a setting a
            -- desktop user is entitled to.
            autolock_minutes INTEGER NOT NULL DEFAULT 15,
            created_at     TEXT NOT NULL,
            updated_at     TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS vault_folders (
            id           TEXT PRIMARY KEY,
            parent_id    TEXT REFERENCES vault_folders(id) ON DELETE CASCADE,
            name         TEXT NOT NULL,
            color        TEXT NOT NULL DEFAULT '',
            -- `''` is everywhere. See the block comment above for why this is not a foreign key.
            workspace_id TEXT NOT NULL DEFAULT '',
            sort_order   INTEGER NOT NULL DEFAULT 0,
            created_at   TEXT NOT NULL,
            updated_at   TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_vault_folders_tree
            ON vault_folders (parent_id, sort_order);

        -- One entry.
        --
        -- The columns above `secret_*` are deliberately in the clear, and that is a decision rather
        -- than an oversight: a *locked* vault still has to be able to say what is in it. A title
        -- that needed the key to render would turn the list into a wall of bullets, and the user
        -- would have to unlock to find out whether the thing they are looking for is even here.
        -- What is secret is the payload, and only the payload.
        CREATE TABLE IF NOT EXISTS vault_items (
            id          TEXT PRIMARY KEY,
            folder_id   TEXT REFERENCES vault_folders(id) ON DELETE SET NULL,
            -- login | card | note | identity | key | file
            kind        TEXT NOT NULL DEFAULT 'login',
            title       TEXT NOT NULL DEFAULT '',
            -- The account line under the title — a username, the last four of a card. Not a secret.
            subtitle    TEXT NOT NULL DEFAULT '',
            site        TEXT NOT NULL DEFAULT '',
            tags        TEXT NOT NULL DEFAULT '[]',
            favorite    INTEGER NOT NULL DEFAULT 0,
            workspace_id TEXT NOT NULL DEFAULT '',
            -- Everything secret, as one AES-256-GCM ciphertext over a JSON object.
            --
            -- One blob rather than a column per field, for two reasons. The shape differs per
            -- `kind`, so columns would be mostly NULL; and a schema that named the fields would
            -- leak which ones an entry *has* — that a login carries a TOTP secret, that an identity
            -- carries a passport number — to anyone reading the file without the key.
            secret_nonce TEXT NOT NULL DEFAULT '',
            secret_blob  TEXT NOT NULL DEFAULT '',
            sort_order  INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL,
            -- Set when the entry is deleted, so a mis-click is recoverable from the trash. The row
            -- is only really gone when it is purged.
            deleted_at  TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_vault_items_folder
            ON vault_items (folder_id, sort_order);
        CREATE INDEX IF NOT EXISTS idx_vault_items_live
            ON vault_items (deleted_at, updated_at DESC);

        -- Attachments: a photo of a document, a `.pem`, a recovery-codes PDF.
        --
        -- In a table rather than as files on disk, and the reason is `backup::snapshot`: it copies
        -- tables and knows nothing about files, so an attachment on disk would be the one thing a
        -- restore silently lost. The cost is that the row holds base64 of ciphertext — about 1.37×
        -- the file — which is why `keyvault_cmd` caps the size.
        --
        -- `size_bytes` is the *plaintext* length, so the list can say "2.4 MB" while locked.
        CREATE TABLE IF NOT EXISTS vault_blobs (
            id         TEXT PRIMARY KEY,
            item_id    TEXT NOT NULL REFERENCES vault_items(id) ON DELETE CASCADE,
            name       TEXT NOT NULL,
            mime       TEXT NOT NULL DEFAULT 'application/octet-stream',
            size_bytes INTEGER NOT NULL DEFAULT 0,
            nonce      TEXT NOT NULL,
            data       TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_vault_blobs_item ON vault_blobs (item_id);

        -- An append-only record of what was opened and when.
        --
        -- Not a security control on its own — anyone who can edit the database can edit this. It is
        -- the answer to "did I copy that password on the laptop last Tuesday", which is a question
        -- people actually ask after an incident.
        CREATE TABLE IF NOT EXISTS vault_audit (
            id        TEXT PRIMARY KEY,
            item_id   TEXT NOT NULL DEFAULT '',
            -- unlock | lock | reveal | copy | create | update | delete | restore | purge
            action    TEXT NOT NULL,
            at        TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_vault_audit_time ON vault_audit (at DESC);

        -- A phone or tablet that has been paired with the remote-control server.
        --
        -- Deliberately NOT scoped to a workspace: pairing is a property of this *install* — the
        -- device drives the whole app, and the workspace it happens to be looking at is a thing it
        -- chooses per request, exactly as the desktop window does.
        --
        -- **`token_hash`, never the token.** The token is minted once, shown once to the device
        -- that is pairing, and never recoverable afterwards — what stays here is a SHA-256 of it,
        -- so a copy of `codeflow.db` (a backup, a synced folder, a stolen laptop) does not hand
        -- anybody a working credential. Verification hashes the presented bearer and compares, so
        -- losing a device means revoking a row rather than rotating anything.
        --
        -- Not in the OS keychain, which is where `secrets.rs` puts everything else, and the
        -- difference is what the secret is *for*: a keychain entry holds a credential this app
        -- presents to somebody else (a PAT, a database password) and must be able to read back. A
        -- hash is not a credential and is never read back — only compared — so the keychain would
        -- buy nothing and cost a round trip per request on the hot path.
        --
        -- Revoked rows are kept rather than deleted so the settings screen can still say which
        -- device was cut off and when, instead of silently forgetting it existed.
        CREATE TABLE IF NOT EXISTS remote_devices (
            id           TEXT PRIMARY KEY,
            -- What the device called itself when it paired ("iPhone de Sebastián"). Free text from
            -- the device, so it is display-only and never trusted for anything.
            name         TEXT NOT NULL DEFAULT '',
            token_hash   TEXT NOT NULL,
            created_at   TEXT NOT NULL,
            last_seen_at TEXT,
            revoked      INTEGER NOT NULL DEFAULT 0
        );
        -- Every authenticated request is a lookup by hash, and it is the only lookup there is.
        CREATE UNIQUE INDEX IF NOT EXISTS idx_remote_devices_token
            ON remote_devices (token_hash);

        -- ── Services ────────────────────────────────────────────────────────────────────────
        --
        -- A named runnable and a group of them, for the case one terminal cannot hold: two
        -- containers, two backends and two frontends brought up in the right order, every morning.
        --
        -- **Scoped to the workspace, not to a repository**, and that is the whole design. The thing
        -- being started is a *system*, and a system spans repositories — the frontend is one
        -- checkout and the API another. A service filed under a repository could not name the
        -- backend it waits for.
        --
        -- There is no `pid`, no `status` and no `session_id` column here, deliberately: what is
        -- running is a fact about this process, not about the database, and a row claiming a pid
        -- that died with the last launch is worse than no row at all. The live state lives in the
        -- terminal registry, keyed by the session the service was started into.
        CREATE TABLE IF NOT EXISTS service_groups (
            id           TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            name         TEXT NOT NULL,
            sort_order   INTEGER NOT NULL DEFAULT 0,
            created_at   TEXT NOT NULL,
            updated_at   TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS services (
            id           TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            -- Ungrouped services are legal and common — one `docker compose up` on its own is a
            -- service. `ON DELETE SET NULL` so deleting a group keeps its services rather than
            -- taking the user's definitions with it.
            group_id     TEXT REFERENCES service_groups(id) ON DELETE SET NULL,
            name         TEXT NOT NULL,
            -- shell | script | compose. Decides how `command` is built, not what it can do: all
            -- three end up as one line typed into a pty.
            kind         TEXT NOT NULL DEFAULT 'shell',
            -- Where it runs. A project id when the directory is a repository in this workspace,
            -- which is what lets the definition survive the folder being moved; `cwd` is then
            -- relative to it. With no project, `cwd` is absolute.
            project_id   TEXT REFERENCES projects(id) ON DELETE SET NULL,
            cwd          TEXT NOT NULL DEFAULT '',
            command      TEXT NOT NULL DEFAULT '',
            -- JSON object. Values may be `{"vault":"<entry id>"}` rather than a literal, so a
            -- secret stays in the keyring and never becomes a row in this table.
            env          TEXT NOT NULL DEFAULT '{}',
            -- JSON array of numbers, for the `localhost:5173` link on the row. Declared rather than
            -- discovered: reading them out of the output is a guess, and a wrong link is worse than
            -- none.
            ports        TEXT NOT NULL DEFAULT '[]',
            -- What "it is up" means: none | port | log | http. Without one, `depends_on` is a lie —
            -- starting the API the instant the database *process* exists is the failure this is
            -- here to prevent.
            ready_kind   TEXT NOT NULL DEFAULT 'none',
            -- The port number, the pattern to look for, or the URL — whichever `ready_kind` needs.
            ready_value  TEXT NOT NULL DEFAULT '',
            -- JSON array of service ids in this workspace. A cycle is refused on save, naming the
            -- services involved.
            depends_on   TEXT NOT NULL DEFAULT '[]',
            -- Off by default and capped when on: a service that restarts itself in a loop is a fan
            -- at full speed and a flat battery.
            autorestart  INTEGER NOT NULL DEFAULT 0,
            color        TEXT NOT NULL DEFAULT '',
            sort_order   INTEGER NOT NULL DEFAULT 0,
            created_at   TEXT NOT NULL,
            updated_at   TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_services_workspace
            ON services (workspace_id, sort_order);
        "#,
    )?;

    migrate_api_tables_finish(conn)?;
    ensure_globals_environment(conn)?;

    migrate_review_contexts_to_workspace(conn)?;
    migrate_md_files_into_contexts(conn)?;
    migrate_review_standards_into_prompts(conn)?;
    backfill_workspace_prompts(conn)?;
    drop_legacy_installed_skills(conn)?;
    add_session_id_to_activity_log(conn)?;
    add_response_time_to_activity_log(conn)?;
    add_is_error_to_activity_log(conn)?;
    add_engine_session_id_to_activity_log(conn)?;
    add_trace_to_activity_log(conn)?;
    add_engine_meta_to_activity_log(conn)?;
    add_custom_label_to_job_history(conn)?;
    add_github_columns_to_projects(conn)?;
    add_github_host_to_projects(conn)?;
    add_gitlab_columns_to_projects(conn)?;
    add_enabled_to_workspace_skills(conn)?;
    add_provider_to_workspace_agents(conn)?;
    add_pinned_to_api_collections(conn)?;
    add_updated_at_to_folders_and_environments(conn)?;
    add_collection_id_to_tombstones(conn)?;
    add_project_url_to_shared_collections(conn)?;
    add_verification_to_story_batches(conn)?;
    add_prompt_snapshot_to_story_batches(conn)?;
    add_multi_repo_verification_to_story_batches(conn)?;
    add_question_answers_to_story_batches(conn)?;
    add_verification_to_story_drafts(conn)?;
    add_original_estimate_to_story_drafts(conn)?;
    add_board_provider_to_stories(conn)?;
    add_grouping_to_agent_tasks(conn)?;
    add_grouping_to_agent_chains(conn)?;
    add_repos_to_agent_chains(conn)?;
    add_ai_usage(conn)?;
    add_group_name_to_db_connections(conn)?;
    add_scope_to_scoped_tables(conn)?;
    add_tab_to_workspace_terminals(conn)?;
    align_project_ado_org_with_connections(conn)?;
    file_loose_notes_into_a_book(conn)?;
    move_ollama_settings_to_cline(conn)?;
    move_openai_settings_to_cline(conn)?;
    Ok(())
}

/// Carries an install that was talking to an OpenAI-compatible endpoint over to Cline.
///
/// The same move the Ollama one above made, one engine later and for the same reason: the HTTP
/// engine could only *complete text*, so every flow that needed tools was hidden whenever it was
/// selected. Cline reaches the identical endpoints — `cline auth openai`, or any OpenAI-compatible
/// base URL configured inside it — and reaches them with tools, which left nothing for a second
/// implementation to be better at.
///
/// Three things move, and again nothing is invented:
///  - every `ai_provider*` setting reading `openai` now reads `cline`,
///  - `openai_model` and its per-task siblings become `cline_*` as `openai/<model>`, which is the
///    same model addressed the way Cline addresses one,
///  - `openai_binary_path` is dropped: it held a base URL, and a URL is not a path to a binary —
///    left behind, the new engine would try to *launch* `https://api.openai.com/v1`. Its absence
///    means "use the default", which is the `cline` on `PATH`.
///
/// **The API key is deliberately left where it is.** It lives in the OS credential store, not in
/// this database, and deleting a credential is not a migration's business — the user may want to
/// paste it into Cline. Nothing reads it any more; it is inert until removed by hand.
///
/// One thing this cannot do for the user: Cline has to be authenticated against that provider once
/// (`cline auth openai`) or the first run reports it. Same caveat the Ollama move carried.
///
/// An existing `cline_*` value always wins — this only fills gaps. Idempotent.
fn move_openai_settings_to_cline(conn: &Connection) -> rusqlite::Result<()> {
    if !table_exists(conn, "app_settings")? {
        return Ok(());
    }
    conn.execute(
        "UPDATE app_settings SET value = 'cline'
         WHERE (key = 'ai_provider' OR key LIKE 'ai_provider\\_%' ESCAPE '\\')
           AND value = 'openai'",
        [],
    )?;
    let mut stmt = conn.prepare(
        "SELECT key, value FROM app_settings
         WHERE key = 'openai_model' OR (key LIKE 'openai\\_%\\_model' ESCAPE '\\')",
    )?;
    let rows: Vec<(String, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    drop(stmt);
    for (key, value) in rows {
        let model = value.trim();
        if !model.is_empty() {
            let qualified =
                if model.contains('/') { model.to_string() } else { format!("openai/{model}") };
            conn.execute(
                "INSERT INTO app_settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO NOTHING",
                params![key.replacen("openai_", "cline_", 1), qualified],
            )?;
        }
        conn.execute("DELETE FROM app_settings WHERE key = ?1", params![key])?;
    }
    conn.execute("DELETE FROM app_settings WHERE key = 'openai_binary_path'", [])?;

    // The roster agents and the chain steps pin their own provider + model — same two tables, and
    // same reason for stopping there: `agent_tasks` and `story_batches` record what *did* run, and
    // rewriting history would have it claim a run happened on an engine that did not exist.
    for table in ["workspace_agents", "agent_chain_steps"] {
        if !table_exists(conn, table)? || !has_column(conn, table, "provider")? {
            continue;
        }
        conn.execute(
            &format!(
                "UPDATE {table}
                    SET model = CASE
                            WHEN TRIM(model) = '' OR INSTR(model, '/') > 0 THEN model
                            ELSE 'openai/' || model
                        END,
                        provider = 'cline'
                  WHERE provider = 'openai'"
            ),
            [],
        )?;
    }
    Ok(())
}

/// Carries an install that was running local models on the old Ollama engine over to Cline.
///
/// The Ollama engine was an HTTP client for `POST /api/chat` — a completion endpoint, so it could
/// never edit a file. Cline drives the *same* local models through `-P ollama` and can, which is
/// why it replaced it outright rather than joining it. What it does not share is the shape of the
/// settings: the old engine's "binary" was a base URL, and its model was a bare `qwen2.5-coder`,
/// while Cline is a real executable addressed with `provider/model`. Left alone, an install that
/// had Ollama selected would come back up trying to *launch* `http://localhost:11434`.
///
/// So three things move, and nothing is invented:
///  - every `ai_provider*` setting reading `ollama`/`local` now reads `cline`,
///  - `ollama_model` (and the per-task overrides) becomes `cline_model` as `ollama/<model>`, which
///    is the same model on the same machine, now named the way Cline names it,
///  - `ollama_binary_path` is dropped rather than copied: a URL is not a path to anything, and
///    leaving it would point the new engine at a binary that does not exist. Its absence means
///    "use the default", which is the `cline` on `PATH`.
///
/// An existing `cline_*` value always wins — this only fills gaps. Idempotent: the second run finds
/// no `ollama` rows left to move.
fn move_ollama_settings_to_cline(conn: &Connection) -> rusqlite::Result<()> {
    if !table_exists(conn, "app_settings")? {
        return Ok(());
    }
    conn.execute(
        "UPDATE app_settings SET value = 'cline'
         WHERE (key = 'ai_provider' OR key LIKE 'ai_provider\\_%' ESCAPE '\\')
           AND value IN ('ollama', 'local')",
        [],
    )?;
    // `ollama_model` → `cline_model`, `ollama_review_model` → `cline_review_model`, … The model id
    // gains the `ollama/` prefix Cline needs to route it; an id that somehow already carries a
    // provider is left as it is.
    let mut stmt = conn.prepare(
        "SELECT key, value FROM app_settings
         WHERE key = 'ollama_model' OR (key LIKE 'ollama\\_%\\_model' ESCAPE '\\')",
    )?;
    let rows: Vec<(String, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    drop(stmt);
    for (key, value) in rows {
        let model = value.trim();
        if !model.is_empty() {
            let qualified =
                if model.contains('/') { model.to_string() } else { format!("ollama/{model}") };
            conn.execute(
                "INSERT INTO app_settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO NOTHING",
                params![key.replacen("ollama_", "cline_", 1), qualified],
            )?;
        }
        conn.execute("DELETE FROM app_settings WHERE key = ?1", params![key])?;
    }
    conn.execute("DELETE FROM app_settings WHERE key = 'ollama_binary_path'", [])?;

    // The roster agents and the chain steps pin a provider + model of their own, so they need the
    // same rewrite or they would run the old id. Only these two: `agent_tasks` and `story_batches`
    // also carry a provider, but theirs is a record of what *did* run. Rewriting those would not
    // fix anything — they are never executed again — and would leave the history claiming a run
    // happened on an engine that did not exist that day.
    for table in ["workspace_agents", "agent_chain_steps"] {
        if !table_exists(conn, table)? || !has_column(conn, table, "provider")? {
            continue;
        }
        conn.execute(
            &format!(
                "UPDATE {table}
                    SET model = CASE
                            WHEN TRIM(model) = '' OR INSTR(model, '/') > 0 THEN model
                            ELSE 'ollama/' || model
                        END,
                        provider = 'cline'
                  WHERE provider IN ('ollama', 'local')"
            ),
            [],
        )?;
    }
    Ok(())
}

/// Gives every note a book, which is now an invariant rather than a preference.
///
/// The Notes workspace used to treat "no book" as an ordinary place — the root of the tree, where a
/// note just written sat until it was filed. It no longer is: the main view browses *books*, and a
/// note outside every book would be a note with nowhere to be shown from. Rows written under the
/// old rule have to be brought inside before that view can be trusted, and this is the one moment
/// that can be done for them.
///
/// The destination is the workspace's first book if it has one — a person with a single book meant
/// that book — and otherwise a new one. Notes keep their relative order: they are appended in
/// `sort_order` order after whatever the destination already held, so a list arranged by hand is
/// not shuffled by being moved indoors.
///
/// A no-op the second time it runs, and on every database that never had a loose note.
fn file_loose_notes_into_a_book(conn: &Connection) -> rusqlite::Result<()> {
    if !table_exists(conn, "notes")? || !table_exists(conn, "note_books")? {
        return Ok(());
    }
    let workspaces: Vec<String> = conn
        .prepare("SELECT DISTINCT workspace_id FROM notes WHERE book_id IS NULL")?
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    for workspace_id in workspaces {
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM note_books WHERE workspace_id = ?1 AND parent_id IS NULL \
                 ORDER BY sort_order, name LIMIT 1",
                params![&workspace_id],
                |row| row.get(0),
            )
            .optional()?;

        let book_id = match existing {
            Some(id) => id,
            None => {
                let id = uuid::Uuid::new_v4().to_string();
                let timestamp = super::queries::now();
                conn.execute(
                    "INSERT INTO note_books \
                     (id, workspace_id, parent_id, name, color, sort_order, created_at, updated_at) \
                     VALUES (?1, ?2, NULL, 'General', '', 0, ?3, ?3)",
                    params![&id, &workspace_id, &timestamp],
                )?;
                id
            }
        };

        // Appended after the destination's own notes, in the order they were in at the root.
        let base: i64 = conn.query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM notes WHERE book_id = ?1",
            params![&book_id],
            |row| row.get(0),
        )?;
        let loose: Vec<String> = conn
            .prepare(
                "SELECT id FROM notes WHERE workspace_id = ?1 AND book_id IS NULL \
                 ORDER BY sort_order, created_at",
            )?
            .query_map(params![&workspace_id], |row| row.get(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (offset, note_id) in loose.iter().enumerate() {
            // `updated_at` untouched: this is filing, and a migration must not make every note in
            // the workspace look as though it was edited the day the user upgraded.
            conn.execute(
                "UPDATE notes SET book_id = ?2, sort_order = ?3 WHERE id = ?1",
                params![note_id, &book_id, base + offset as i64],
            )?;
        }
    }
    Ok(())
}

/// Files the bench's existing shells into a tab.
///
/// The bench shipped flat — a list of terminals, one on screen at a time — and gained tabs and
/// panes in the release after. Every row written before that names no tab, and a shell filed under
/// no tab is a shell that has vanished: the bench draws tabs, and it would draw none.
///
/// So the backfill is not optional and is not a tidy-up. Rows with an empty `tab_id` are gathered
/// into one tab per workspace, in the order they were created — which is the arrangement they
/// already had, since a flat bench *is* a single tab of stacked panes with only one showing.
fn add_tab_to_workspace_terminals(conn: &Connection) -> rusqlite::Result<()> {
    if !table_exists(conn, "workspace_terminals")? {
        return Ok(());
    }
    if !has_column(conn, "workspace_terminals", "tab_id")? {
        conn.execute_batch("ALTER TABLE workspace_terminals ADD COLUMN tab_id TEXT NOT NULL DEFAULT '';")?;
    }

    let orphaned: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT DISTINCT workspace_id FROM workspace_terminals WHERE tab_id = ''",
        )?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<Vec<String>>>()?
    };

    for workspace_id in orphaned {
        let tab_id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO workspace_bench_tabs (id, workspace_id, title, layout, sort_order, created_at)
             VALUES (?1, ?2, '', '', 0, ?3)",
            rusqlite::params![tab_id, workspace_id, crate::db::queries::now()],
        )?;
        // No `layout` written: an empty one means "lay these out however you like", and the
        // frontend builds a default arrangement from whichever terminals name the tab. Inventing a
        // tree here would mean this file knowing the shape of something it otherwise only stores.
        conn.execute(
            "UPDATE workspace_terminals SET tab_id = ?2 WHERE workspace_id = ?1 AND tab_id = ''",
            rusqlite::params![workspace_id, tab_id],
        )?;
    }
    Ok(())
}

/// Rewrites `projects.ado_org` to the spelling the organisation was connected under.
///
/// Auto-linking matched a remote against the connected organisations case-insensitively and then
/// stored the spelling from the *git remote URL*, so a repository could end up naming `myorg` while
/// Settings had `MyOrg`. Nothing noticed until a token was needed: the PAT was filed under the
/// typed spelling, the lookup asked for the detected one, and the pull-request list reported "No
/// Azure DevOps token saved" for an organisation that was plainly connected.
///
/// The key is case-folded now (`secrets::ado_pat_key`), which stops it happening again — but only
/// for what the two sides *ask* for. This is the other half: the rows already written. Pure data,
/// no credential is read here; it runs at open, where a Keychain prompt would be unwelcome and is
/// not needed.
///
/// Only spellings that differ by case are touched, and only where a connection matches. An org with
/// no connection is left exactly as it is — that is a repository pointing at somewhere the user has
/// not set up, and rewriting it would invent a link.
pub(crate) fn align_project_ado_org_with_connections(conn: &Connection) -> rusqlite::Result<()> {
    let raw: Option<String> = conn
        .query_row("SELECT value FROM app_settings WHERE key = 'ado_connections'", [], |row| {
            row.get(0)
        })
        .optional()?;
    let Some(raw) = raw else { return Ok(()) };
    let Ok(serde_json::Value::Array(items)) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return Ok(());
    };

    for item in items {
        let Some(org) = item.get("org").and_then(serde_json::Value::as_str) else { continue };
        let org = org.trim();
        if org.is_empty() {
            continue;
        }
        // `= ?2 COLLATE NOCASE` and `<> ?2` together: the rows that name this organisation in some
        // other case, and only those. A row already spelled correctly is not rewritten, so this is
        // a no-op on every install that never had the mismatch.
        conn.execute(
            "UPDATE projects SET ado_org = ?1
             WHERE ado_org IS NOT NULL AND ado_org = ?2 COLLATE NOCASE AND ado_org <> ?2",
            (org, org),
        )?;
    }
    Ok(())
}

/// Connections gained folders, the way hosts already had them.
///
/// The empty default is the whole migration: every connection that existed before this is
/// ungrouped, which is the bucket the tree already draws first — so a database upgraded here looks
/// exactly as it did, with one empty folder list beside it. `db_groups` needs no backfill for the
/// same reason it exists at all: it records only the folders a user makes.
fn add_group_name_to_db_connections(conn: &Connection) -> rusqlite::Result<()> {
    if table_exists(conn, "db_connections")? && !has_column(conn, "db_connections", "group_name")? {
        conn.execute_batch(
            "ALTER TABLE db_connections ADD COLUMN group_name TEXT NOT NULL DEFAULT '';",
        )?;
    }
    Ok(())
}

/// A note book, an API collection, a database connection and a connection group can now be
/// *global* — on every workspace's shelf rather than only the one they were made in.
///
/// The default is the whole migration: `'workspace'` is what every existing row already was, so an
/// upgraded database shows exactly what it showed before. Nothing is backfilled and nothing moves.
///
/// Five tables, not three. `notes` is here because `notes.scope` is denormalised from its book —
/// see that column's comment for the property it buys and the three writers that owe it. `db_groups`
/// is here because a group whose members went global while it did not renders as an empty folder.
///
/// What is deliberately *not* here: `api_environments`, `api_history`, `api_cookies` and
/// `db_query_history` stay workspace-scoped. A global collection uses the current workspace's
/// environment and files its history there, which is the right reading of "global" — the
/// collection is shared, the run is local.
fn add_scope_to_scoped_tables(conn: &Connection) -> rusqlite::Result<()> {
    for table in ["note_books", "notes", "api_collections", "db_connections", "db_groups"] {
        if table_exists(conn, table)? && !has_column(conn, table, "scope")? {
            conn.execute_batch(&format!(
                "ALTER TABLE {table} ADD COLUMN scope TEXT NOT NULL DEFAULT 'workspace';"
            ))?;
        }
    }
    Ok(())
}

/// A story set gained the board it publishes to, and a published story gained the name that board
/// calls it by.
///
/// Both default to the empty string, and that is the whole migration: an empty `board_provider`
/// reads as Azure — which is what every existing set was — and an empty `work_item_key` reads as "no
/// key", which is true of every Azure work item, since there the id *is* the name.
///
/// Deliberately no new columns for the target itself. `ado_org`, `ado_project` and `work_item_type`
/// already hold three opaque strings the host interprets, and Jira's site, project key and issue
/// type are three opaque strings in exactly the same positions; adding a parallel set would leave
/// two ways to say where a set publishes and one of them wrong. The Azure-only pair (`area_path`,
/// `iteration_path`) simply stays empty on a Jira target, and the panel doesn't offer it.
fn add_board_provider_to_stories(conn: &Connection) -> rusqlite::Result<()> {
    if table_exists(conn, "story_batches")? && !has_column(conn, "story_batches", "board_provider")? {
        conn.execute_batch(
            "ALTER TABLE story_batches ADD COLUMN board_provider TEXT NOT NULL DEFAULT '';",
        )?;
    }
    if table_exists(conn, "story_drafts")? && !has_column(conn, "story_drafts", "work_item_key")? {
        conn.execute_batch(
            "ALTER TABLE story_drafts ADD COLUMN work_item_key TEXT NOT NULL DEFAULT '';",
        )?;
    }
    Ok(())
}

/// Tasks and chains gained the two columns the task tree is built out of: the folder they are filed
/// under, and whether they sit in the pinned section.
///
/// Both are organisation, not run state — nothing in the scheduler or in a turn reads them — which
/// is why they default to "unset" and why there is no backfill to write: a database that predates
/// folders has everything filed nowhere, and that is exactly what an empty `agent_project_id` and
/// an unpinned flag already say.
fn add_grouping_to_agent_tasks(conn: &Connection) -> rusqlite::Result<()> {
    if !table_exists(conn, "agent_tasks")? {
        return Ok(());
    }
    if !has_column(conn, "agent_tasks", "agent_project_id")? {
        conn.execute_batch(
            "ALTER TABLE agent_tasks ADD COLUMN agent_project_id TEXT NOT NULL DEFAULT '';",
        )?;
    }
    if !has_column(conn, "agent_tasks", "pinned")? {
        conn.execute_batch("ALTER TABLE agent_tasks ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;")?;
    }
    Ok(())
}

/// The chain half of [`add_grouping_to_agent_tasks`] — see its comment for why neither needs a
/// backfill.
fn add_grouping_to_agent_chains(conn: &Connection) -> rusqlite::Result<()> {
    if !table_exists(conn, "agent_chains")? {
        return Ok(());
    }
    if !has_column(conn, "agent_chains", "agent_project_id")? {
        conn.execute_batch(
            "ALTER TABLE agent_chains ADD COLUMN agent_project_id TEXT NOT NULL DEFAULT '';",
        )?;
    }
    if !has_column(conn, "agent_chains", "pinned")? {
        conn.execute_batch("ALTER TABLE agent_chains ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;")?;
    }
    // Seeded at 0 rather than at `step_count`: an existing plan is not a plan that has already
    // used up its budget, and every one of them is linear anyway — the counter only starts
    // mattering the first time a step is authored with a backward `on_fail`.
    if !has_column(conn, "agent_chains", "dispatches")? {
        conn.execute_batch("ALTER TABLE agent_chains ADD COLUMN dispatches INTEGER NOT NULL DEFAULT 0;")?;
    }
    Ok(())
}

/// What the engines have spent, one row per finished run that reported it.
///
/// Global on purpose — no `workspace_id`, no `project_id`. Consumption belongs to the *account* the
/// CLI is logged into, and a meter split by whichever folder happened to be open would answer a
/// question nobody asks of a status bar. It is also why there is no foreign key: nothing here
/// should disappear because a repository was removed.
///
/// `has_cost` is separate from `cost_usd` because zero is a real value and "the CLI did not say" is
/// not zero. Folding the two would report an engine that never prints a price as free.
fn add_ai_usage(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS ai_usage (
            id                 TEXT PRIMARY KEY,
            provider           TEXT NOT NULL,
            -- The model the CLI said it ran, falling back to the one that was forced. May be empty
            -- when neither was known, which is a real state: the CLI picked for itself and did not
            -- report it.
            model              TEXT NOT NULL DEFAULT '',
            -- Which feature spent it: 'chat', 'inline', 'review-pr', 'stories', 'commit', … See
            -- `ai::AiTaskLabel`. Empty only on rows written before this column existed — a meter
            -- that cannot say *what* was counted cannot be checked for gaps, which is the one
            -- question anybody actually asks of it.
            task               TEXT NOT NULL DEFAULT '',
            input_tokens       INTEGER NOT NULL DEFAULT 0,
            output_tokens      INTEGER NOT NULL DEFAULT 0,
            -- Prompt tokens served from the provider's cache, kept apart from `input_tokens`
            -- because they are the cheap ones and a merged total reads as several times the work.
            cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
            cache_write_tokens INTEGER NOT NULL DEFAULT 0,
            cost_usd           REAL NOT NULL DEFAULT 0,
            has_cost           INTEGER NOT NULL DEFAULT 0,
            created_at         TEXT NOT NULL
         );
         -- Every read of this table is 'since a timestamp, grouped by provider', and every write is
         -- an append at the newest end.
         CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage(created_at);
         CREATE INDEX IF NOT EXISTS idx_ai_usage_provider ON ai_usage(provider, created_at);",
    )?;
    add_task_to_ai_usage(conn)
}

/// Which feature each recorded run belongs to.
///
/// Added late: the table shipped knowing only *which engine* spent the tokens, which is enough for
/// a status-bar total and useless for the question that follows it — "is my PR review being counted
/// at all?". Without this the only way to answer was to reason about the call graph. Rows written
/// before it keep an empty task and read as "unknown", which is honest: nothing recorded what they
/// were.
fn add_task_to_ai_usage(conn: &Connection) -> rusqlite::Result<()> {
    if has_column(conn, "ai_usage", "task")? {
        return Ok(());
    }
    conn.execute_batch("ALTER TABLE ai_usage ADD COLUMN task TEXT NOT NULL DEFAULT '';")
}

/// A chain stopped being about one repository.
///
/// Three things at once, because they are one change: the set of repositories a chain works across
/// (`agent_chain_repos`), which repository each individual step runs in
/// (`agent_chain_steps.project_id`), and — since the first user of both is the story realizer — the
/// work item a chain can be built from.
///
/// `agent_chains.project_id` deliberately stays, and stays the **first** repository of the set.
/// Everything that scopes a chain to a workspace does it by joining `projects` through that column
/// (see [`queries::list_agent_chains`]), and a chain whose primary repository is deleted should
/// still go with it — which is exactly what the existing `ON DELETE CASCADE` already says.
///
/// The backfill is what keeps every chain written before this identical to what it was: one row in
/// `agent_chain_repos` naming its own repository, and every step pointed at that same repository.
/// A step's `project_id` is never empty after this, which is what lets the scheduler read it
/// without a fallback branch.
fn add_repos_to_agent_chains(conn: &Connection) -> rusqlite::Result<()> {
    if !table_exists(conn, "agent_chains")? {
        return Ok(());
    }

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_chain_repos (
            chain_id   TEXT NOT NULL REFERENCES agent_chains(id) ON DELETE CASCADE,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            -- The order the user picked them in. Position 0 is the chain's own `project_id`, and
            -- the dialog offers it as the default for a step that names no repository.
            position   INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (chain_id, project_id)
         );
         CREATE INDEX IF NOT EXISTS idx_agent_chain_repos_chain
            ON agent_chain_repos(chain_id, position);",
    )?;

    for (column, ddl) in [
        ("kind", "ALTER TABLE agent_chains ADD COLUMN kind TEXT NOT NULL DEFAULT 'chain';"),
        (
            "work_item_provider",
            "ALTER TABLE agent_chains ADD COLUMN work_item_provider TEXT NOT NULL DEFAULT '';",
        ),
        ("work_item_org", "ALTER TABLE agent_chains ADD COLUMN work_item_org TEXT NOT NULL DEFAULT '';"),
        ("work_item_id", "ALTER TABLE agent_chains ADD COLUMN work_item_id INTEGER NOT NULL DEFAULT 0;"),
        ("work_item_key", "ALTER TABLE agent_chains ADD COLUMN work_item_key TEXT NOT NULL DEFAULT '';"),
        ("work_item_url", "ALTER TABLE agent_chains ADD COLUMN work_item_url TEXT NOT NULL DEFAULT '';"),
        (
            "work_item_title",
            "ALTER TABLE agent_chains ADD COLUMN work_item_title TEXT NOT NULL DEFAULT '';",
        ),
    ] {
        if !has_column(conn, "agent_chains", column)? {
            conn.execute_batch(ddl)?;
        }
    }

    // Every chain that existed before this works across exactly the one repository it names.
    conn.execute(
        "INSERT OR IGNORE INTO agent_chain_repos (chain_id, project_id, position)
         SELECT id, project_id, 0 FROM agent_chains",
        [],
    )?;

    if table_exists(conn, "agent_chain_steps")? {
        if !has_column(conn, "agent_chain_steps", "project_id")? {
            conn.execute_batch(
                "ALTER TABLE agent_chain_steps ADD COLUMN project_id TEXT NOT NULL DEFAULT '';",
            )?;
        }
        if !has_column(conn, "agent_chain_steps", "phase")? {
            conn.execute_batch("ALTER TABLE agent_chain_steps ADD COLUMN phase TEXT NOT NULL DEFAULT '';")?;
        }
        for (column, ddl) in [
            (
                "check_command",
                "ALTER TABLE workspace_chain_template_steps ADD COLUMN check_command TEXT NOT NULL DEFAULT '';",
            ),
            ("on_pass", "ALTER TABLE workspace_chain_template_steps ADD COLUMN on_pass INTEGER NOT NULL DEFAULT -1;"),
            ("on_fail", "ALTER TABLE workspace_chain_template_steps ADD COLUMN on_fail INTEGER NOT NULL DEFAULT -1;"),
        ] {
            if table_exists(conn, "workspace_chain_template_steps")?
                && !has_column(conn, "workspace_chain_template_steps", column)?
            {
                conn.execute_batch(ddl)?;
            }
        }
        // The verdict columns. Every default is the behaviour that existed before them, so a plan
        // authored last month keeps running exactly as it did: no check, pass goes to the next
        // step, fail stops.
        for (column, ddl) in [
            ("check_command", "ALTER TABLE agent_chain_steps ADD COLUMN check_command TEXT NOT NULL DEFAULT '';"),
            ("on_pass", "ALTER TABLE agent_chain_steps ADD COLUMN on_pass INTEGER NOT NULL DEFAULT -1;"),
            ("on_fail", "ALTER TABLE agent_chain_steps ADD COLUMN on_fail INTEGER NOT NULL DEFAULT -1;"),
            ("feedback", "ALTER TABLE agent_chain_steps ADD COLUMN feedback TEXT NOT NULL DEFAULT '';"),
        ] {
            if !has_column(conn, "agent_chain_steps", column)? {
                conn.execute_batch(ddl)?;
            }
        }
        // Idempotent and cheap: only the rows still saying nothing, which after the first run is
        // none of them.
        conn.execute(
            "UPDATE agent_chain_steps
                SET project_id = (SELECT c.project_id FROM agent_chains c WHERE c.id = chain_id)
              WHERE project_id = ''",
            [],
        )?;
    }
    Ok(())
}

/// Story batches gained a second repository reference — the one their acceptance criteria are
/// *checked against* — plus the provenance of the last check.
///
/// Kept apart from `project_id` (which records where the source Markdown was read) because the two
/// answer different questions and are routinely different repositories: a backlog derived from a
/// product wiki is validated against the service that implements it.
fn add_verification_to_story_batches(conn: &Connection) -> rusqlite::Result<()> {
    if !table_exists(conn, "story_batches")? {
        return Ok(());
    }
    // Nullable with a NULL default, which is what SQLite requires of an added column that carries
    // a REFERENCES clause.
    if !has_column(conn, "story_batches", "verify_project_id")? {
        conn.execute_batch(
            "ALTER TABLE story_batches ADD COLUMN verify_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;",
        )?;
    }
    for column in ["verify_provider", "verify_model", "verified_at"] {
        if !has_column(conn, "story_batches", column)? {
            conn.execute_batch(&format!(
                "ALTER TABLE story_batches ADD COLUMN {column} TEXT NOT NULL DEFAULT '';"
            ))?;
        }
    }
    Ok(())
}

/// Story batches gained a snapshot of the prompt their last generation actually ran with.
///
/// Neither half of that prompt could be recovered before: the template lives in `workspace_prompts`
/// as a single row per workspace and kind, so tuning the house style — or hitting "restore default",
/// which stores a blank — silently rewrites the provenance of every set already produced with it;
/// and `instructions` is saved on blur from the rail, making it the value the *next* run will use
/// rather than the one the last did.
///
/// Only the two mutable pieces are frozen. The documentation is already immutable in `source_text`,
/// so copying it again would double the largest column in the table (60k characters a batch) to
/// store what is provably identical. Existing rows default to `''` — never snapshotted — and the
/// screen says so instead of passing today's template off as the one that ran.
fn add_prompt_snapshot_to_story_batches(conn: &Connection) -> rusqlite::Result<()> {
    if !table_exists(conn, "story_batches")? {
        return Ok(());
    }
    for column in ["prompt_template", "prompt_instructions", "generated_at"] {
        if !has_column(conn, "story_batches", column)? {
            conn.execute_batch(&format!(
                "ALTER TABLE story_batches ADD COLUMN {column} TEXT NOT NULL DEFAULT '';"
            ))?;
        }
    }
    Ok(())
}

/// Verification went from one repository to a set of them, and the `.feature` destination became its
/// own choice.
///
/// One capability is routinely spread across a service, its BFF and its scheduled jobs, so a
/// criterion checked against a single repository came back `fail` for the wrong reason — the code
/// existed, just not there. The spec file did not follow: a `.feature` copied into every repository
/// of the set is several files that drift, so it keeps pointing at exactly one.
///
/// The old column is left in place rather than dropped. Dropping it would rewrite the table, and a
/// user who opens an older build against the same database would find it missing; migrating the
/// value forward and leaving the column alone costs one unused column and no risk.
fn add_multi_repo_verification_to_story_batches(conn: &Connection) -> rusqlite::Result<()> {
    if !table_exists(conn, "story_batches")? {
        return Ok(());
    }
    if !has_column(conn, "story_batches", "verify_project_ids")? {
        conn.execute_batch(
            "ALTER TABLE story_batches ADD COLUMN verify_project_ids TEXT NOT NULL DEFAULT '[]';",
        )?;
    }
    // Nullable with a NULL default, which is what SQLite requires of an added column carrying a
    // REFERENCES clause.
    if !has_column(conn, "story_batches", "feature_project_id")? {
        conn.execute_batch(
            "ALTER TABLE story_batches ADD COLUMN feature_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;",
        )?;
    }
    if !has_column(conn, "story_batches", "verify_project_id")? {
        return Ok(());
    }

    // Carry the single repository forward as both the one-repository set and the feature
    // destination, which is exactly what it meant. Built in Rust rather than in SQL so the id goes
    // through `serde_json` instead of through string concatenation.
    let rows: Vec<(String, String)> = {
        let mut stmt = conn.prepare(
            "SELECT id, verify_project_id FROM story_batches
             WHERE verify_project_id IS NOT NULL AND verify_project_id <> '' AND verify_project_ids = '[]'",
        )?;
        let mapped = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        mapped.collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (batch_id, project_id) in rows {
        let ids = serde_json::to_string(&vec![project_id.clone()]).unwrap_or_else(|_| "[]".to_string());
        conn.execute(
            "UPDATE story_batches SET verify_project_ids = ?2, feature_project_id = ?3 WHERE id = ?1",
            rusqlite::params![batch_id, ids, project_id],
        )?;
    }
    Ok(())
}

/// Open questions gained answers.
///
/// They were a terminal notice before: the model listed what the documentation left ambiguous, and
/// the only way to act on it was to retype the answer into the free-text instructions box, where
/// nothing recorded which question it settled. Storing the pairs makes the answers part of what the
/// batch knows — every later generation is handed them, and an answer survives the question
/// disappearing from the next run's list.
///
/// Existing rows default to `'[]'`, which is exactly what a batch nobody has answered anything for
/// has.
fn add_question_answers_to_story_batches(conn: &Connection) -> rusqlite::Result<()> {
    if !table_exists(conn, "story_batches")? {
        return Ok(());
    }
    if !has_column(conn, "story_batches", "question_answers")? {
        conn.execute_batch(
            "ALTER TABLE story_batches ADD COLUMN question_answers TEXT NOT NULL DEFAULT '[]';",
        )?;
    }
    Ok(())
}

/// Stories gained the verdicts of "does the code already satisfy this?" — a rolled-up status for
/// the card's badge and one entry per acceptance criterion. Existing rows default to never-checked
/// (`''` / `'[]'`), which is exactly what they are.
fn add_verification_to_story_drafts(conn: &Connection) -> rusqlite::Result<()> {
    if !table_exists(conn, "story_drafts")? {
        return Ok(());
    }
    for (column, default) in [
        ("verify_status", "''"),
        ("verify_summary", "''"),
        ("verify_criteria", "'[]'"),
        ("verified_at", "''"),
    ] {
        if !has_column(conn, "story_drafts", column)? {
            conn.execute_batch(&format!(
                "ALTER TABLE story_drafts ADD COLUMN {column} TEXT NOT NULL DEFAULT {default};"
            ))?;
        }
    }
    Ok(())
}

/// Stories gained an estimate in *hours*, next to the points they already carried.
///
/// Not a replacement for `story_points`: the two answer different questions and Azure keeps both,
/// points for relative sizing on the backlog and Original Estimate for the hours a sprint plans
/// against. `0` — what every existing row gets — is what the publish reads as "leave the field
/// alone", so nothing already written changes shape.
fn add_original_estimate_to_story_drafts(conn: &Connection) -> rusqlite::Result<()> {
    if !table_exists(conn, "story_drafts")? || has_column(conn, "story_drafts", "original_estimate")?
    {
        return Ok(());
    }
    conn.execute_batch(
        "ALTER TABLE story_drafts ADD COLUMN original_estimate REAL NOT NULL DEFAULT 0;",
    )
}

/// Shares created before a project could differ per share. They are all on whatever project was
/// configured at the time, which the frontend still holds as its default — it backfills the column
/// on the next launch rather than the migration guessing a URL it cannot see from here.
fn add_project_url_to_shared_collections(conn: &Connection) -> rusqlite::Result<()> {
    if !table_exists(conn, "api_shared_collections")?
        || has_column(conn, "api_shared_collections", "project_url")?
    {
        return Ok(());
    }
    conn.execute_batch(
        "ALTER TABLE api_shared_collections ADD COLUMN project_url TEXT NOT NULL DEFAULT '';",
    )
}

/// `github_host` records which GitHub server a linked project lives on (github.com or an
/// Enterprise host), so the API base URL and per-host token can be resolved. Added after
/// `github_owner`/`github_repo` — a row with those set but a NULL host defaults to github.com.
fn add_github_host_to_projects(conn: &Connection) -> rusqlite::Result<()> {
    if has_column(conn, "projects", "github_host")? {
        return Ok(());
    }
    conn.execute_batch("ALTER TABLE projects ADD COLUMN github_host TEXT;")
}

/// GitLab's coordinates for a linked project.
///
/// One path column rather than GitHub's owner/repo pair, because GitLab groups nest arbitrarily —
/// `acme/backend/services/auth` is a perfectly ordinary project — so there is no "owner" to split
/// off. That full path is also exactly what the REST API takes (URL-encoded) as its project id, so
/// storing it whole means never having to reassemble it.
fn add_gitlab_columns_to_projects(conn: &Connection) -> rusqlite::Result<()> {
    if !has_column(conn, "projects", "gitlab_project")? {
        conn.execute_batch("ALTER TABLE projects ADD COLUMN gitlab_project TEXT;")?;
    }
    if !has_column(conn, "projects", "gitlab_host")? {
        conn.execute_batch("ALTER TABLE projects ADD COLUMN gitlab_host TEXT;")?;
    }
    Ok(())
}

/// `workspace_skills` gained an `enabled` flag so skills can be toggled off (e.g. when not using
/// Claude Code) without deleting them. Existing rows default to enabled — the pre-toggle behavior.
fn add_enabled_to_workspace_skills(conn: &Connection) -> rusqlite::Result<()> {
    if has_column(conn, "workspace_skills", "enabled")? {
        return Ok(());
    }
    conn.execute_batch("ALTER TABLE workspace_skills ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;")
}

/// `workspace_agents` gained a `provider` column so an agent runs on its own provider + model
/// (not just a bare model id). Existing rows default to empty, falling back to the active provider.
fn add_provider_to_workspace_agents(conn: &Connection) -> rusqlite::Result<()> {
    if has_column(conn, "workspace_agents", "provider")? {
        return Ok(());
    }
    conn.execute_batch("ALTER TABLE workspace_agents ADD COLUMN provider TEXT NOT NULL DEFAULT '';")
}

/// `api_collections` gained a `pinned` flag so the ones a workspace lives in sort to the top of
/// the explorer. Existing rows default to unpinned — the pre-flag order, unchanged.
fn add_pinned_to_api_collections(conn: &Connection) -> rusqlite::Result<()> {
    if has_column(conn, "api_collections", "pinned")? {
        return Ok(());
    }
    conn.execute_batch("ALTER TABLE api_collections ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;")
}

/// Folders and environments had only a `created_at`, which made them the two records nothing could
/// order: a backup restore and a pull from a shared workspace both had to guess, and both guessed
/// "the incoming copy wins". That is a silent wrong answer — the local edit disappears — and it is
/// also what made a shared workspace never settle, because a record with no timestamp of its own
/// had to be re-stamped on every push and so looked changed forever.
///
/// Existing rows inherit their `created_at`: it is the only honest thing known about them, and it
/// sorts them below anything edited since.
fn add_updated_at_to_folders_and_environments(conn: &Connection) -> rusqlite::Result<()> {
    for table in ["api_folders", "api_environments"] {
        if has_column(conn, table, "updated_at")? {
            continue;
        }
        conn.execute_batch(&format!(
            "ALTER TABLE {table} ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
             UPDATE {table} SET updated_at = created_at WHERE updated_at = '';"
        ))?;
    }
    Ok(())
}


/// Sharing moved from the workspace to the collection, so a push has to be able to ask for the
/// tombstones of one subtree. Rows written before this column existed get backfilled from whatever
/// still resolves; a request whose collection is long gone keeps `''` and is simply never pushed,
/// which is correct — nobody shares a collection that no longer exists.
fn add_collection_id_to_tombstones(conn: &Connection) -> rusqlite::Result<()> {
    if has_column(conn, "api_tombstones", "collection_id")? {
        return Ok(());
    }
    conn.execute_batch(
        r#"
        ALTER TABLE api_tombstones ADD COLUMN collection_id TEXT NOT NULL DEFAULT '';
        UPDATE api_tombstones SET collection_id = id WHERE kind = 'collection';
        UPDATE api_tombstones
           SET collection_id = COALESCE(
                   (SELECT collection_id FROM api_folders  WHERE api_folders.id  = api_tombstones.id),
                   '')
         WHERE kind = 'folder';
        UPDATE api_tombstones
           SET collection_id = COALESCE(
                   (SELECT collection_id FROM api_requests WHERE api_requests.id = api_tombstones.id),
                   '')
         WHERE kind = 'request';
        "#,
    )
}

/// Every workspace resolves variables against its own "Globals" scope, so each one needs that row
/// before anything reads it. Idempotent and keyed on `is_global` rather than a fixed id, so a
/// user renaming it doesn't cause a duplicate to be seeded on the next launch.
fn ensure_globals_environment(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO api_environments (id, workspace_id, name, variables, is_global, sort_order, created_at)
         SELECT lower(hex(randomblob(16))), w.id, 'Globals', '[]', 1, -1, ?1
         FROM workspaces w
         WHERE NOT EXISTS (
             SELECT 1 FROM api_environments e WHERE e.workspace_id = w.id AND e.is_global = 1
         )",
        rusqlite::params![chrono::Utc::now().to_rfc3339()],
    )?;
    Ok(())
}

/// The `api_*` tables shipped scoped to nothing — one global set of collections, environments,
/// history and cookies. They are now per-workspace, which means a new `workspace_id` column on
/// each of the four roots (folders and requests reach it through their collection).
///
/// SQLite can't add that column in place: `ALTER TABLE ... ADD COLUMN` rejects a `REFERENCES`
/// clause while foreign keys are on, so an in-place add would leave a migrated database without
/// the cascade a fresh one has — a workspace deletion would silently orphan its API rows. So the
/// old tables are moved aside here, the schema batch recreates them in their current shape, and
/// [`migrate_api_tables_finish`] copies the rows across. Splitting it in two is what lets the
/// batch stay the single definition of the schema instead of being duplicated inside a migration.
///
/// `legacy_alter_table` is essential: without it SQLite helpfully rewrites the foreign keys in
/// `api_folders`/`api_requests` to point at `api_collections_legacy`, and the rename silently
/// takes the children with it.
fn migrate_api_tables_begin(conn: &Connection) -> rusqlite::Result<()> {
    let needs_migration = table_exists(conn, "api_collections")?
        && !has_column(conn, "api_collections", "workspace_id")?;
    if !needs_migration {
        return Ok(());
    }
    conn.execute_batch(
        r#"
        PRAGMA foreign_keys = OFF;
        PRAGMA legacy_alter_table = ON;
        -- Dropped rather than carried along: a renamed table keeps its indexes under their old
        -- names, which would collide when the schema batch recreates them.
        DROP INDEX IF EXISTS idx_api_history_time;
        DROP INDEX IF EXISTS idx_api_cookies_key;
        ALTER TABLE api_collections  RENAME TO api_collections_legacy;
        ALTER TABLE api_environments RENAME TO api_environments_legacy;
        ALTER TABLE api_history      RENAME TO api_history_legacy;
        ALTER TABLE api_cookies      RENAME TO api_cookies_legacy;
        PRAGMA legacy_alter_table = OFF;
        "#,
    )
}

/// Second half of [`migrate_api_tables_begin`]: copies the pre-workspace rows into the recreated
/// tables, assigning them all to the oldest workspace — the one a single-workspace user has been
/// working in, which is where they will expect to find their collections.
///
/// If there is no workspace at all the legacy tables are left untouched rather than dropped:
/// there is nowhere to put the rows, and destroying a user's collections to tidy up a migration
/// is not a trade worth making. The next launch after a workspace exists finishes the job.
fn migrate_api_tables_finish(conn: &Connection) -> rusqlite::Result<()> {
    if !table_exists(conn, "api_collections_legacy")? {
        return Ok(());
    }
    let target: Option<String> = conn
        .query_row(
            "SELECT id FROM workspaces ORDER BY sort_order, created_at LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let Some(workspace_id) = target else {
        return Ok(());
    };

    conn.execute_batch("PRAGMA foreign_keys = OFF;")?;
    let copied = conn.execute(
        "INSERT INTO api_collections
            (id, workspace_id, name, description, auth, pre_script, post_script, variables,
             sort_order, created_at, updated_at)
         SELECT id, ?1, name, description, auth, pre_script, post_script, variables,
                sort_order, created_at, updated_at
         FROM api_collections_legacy",
        rusqlite::params![workspace_id],
    )?;
    // The Globals row is per-workspace now, and `ensure_globals_environment` seeds one for every
    // workspace right after this — carrying the old one over as well would leave two in the
    // workspace that inherits it.
    conn.execute(
        "INSERT INTO api_environments
            (id, workspace_id, name, variables, is_global, sort_order, created_at)
         SELECT id, ?1, name, variables, is_global, sort_order, created_at
         FROM api_environments_legacy WHERE is_global = 0",
        rusqlite::params![workspace_id],
    )?;
    conn.execute(
        "INSERT INTO api_history
            (id, workspace_id, request_id, name, protocol, method, url, status, duration_ms,
             size_bytes, snapshot, created_at)
         SELECT id, ?1, request_id, name, protocol, method, url, status, duration_ms,
                size_bytes, snapshot, created_at
         FROM api_history_legacy",
        rusqlite::params![workspace_id],
    )?;
    conn.execute(
        "INSERT INTO api_cookies
            (id, workspace_id, domain, path, name, value, secure, http_only, expires, updated_at)
         SELECT id, ?1, domain, path, name, value, secure, http_only, expires, updated_at
         FROM api_cookies_legacy",
        rusqlite::params![workspace_id],
    )?;
    conn.execute_batch(
        r#"
        DROP TABLE api_collections_legacy;
        DROP TABLE api_environments_legacy;
        DROP TABLE api_history_legacy;
        DROP TABLE api_cookies_legacy;
        PRAGMA foreign_keys = ON;
        "#,
    )?;
    let _ = copied;
    Ok(())
}

/// Renames the Notes workspace's *folders* to *books*, in place.
///
/// The vocabulary changed after the tables existed but before the feature shipped, so the only
/// databases this ever finds are the ones that ran a development build in between. It still has to
/// exist: the schema batch is all `CREATE … IF NOT EXISTS`, which silently does nothing to a
/// `notes` table that is already there under the old column name — and then
/// `CREATE INDEX … ON notes (book_id, …)` fails on a column nobody renamed, taking the whole
/// launch down with it. That is not a state a user can get out of on their own.
///
/// The awkward case it has to survive is exactly the one that produced the crash: `execute_batch`
/// commits statement by statement, so a launch that died on the index has *already* created an
/// empty `note_books` beside the populated `note_folders`. Dropping the empty one is safe and is
/// what makes a second launch recover rather than repeat the failure.
///
/// Two SQLite behaviours are load-bearing here, and both are the modern defaults:
/// `ALTER TABLE … RENAME TO` rewrites the foreign key in `notes` that points at it, and
/// `RENAME COLUMN` rewrites the indexes that mention it. Neither needs doing by hand.
fn migrate_note_folders_to_books(conn: &Connection) -> rusqlite::Result<()> {
    if table_exists(conn, "note_folders")? {
        // The empty shell a half-finished launch left behind.
        if table_exists(conn, "note_books")? {
            let rows: i64 =
                conn.query_row("SELECT COUNT(*) FROM note_books", [], |row| row.get(0))?;
            if rows == 0 {
                conn.execute_batch("DROP TABLE note_books;")?;
            }
        }
        // If both hold rows this is not a shape we produced, and guessing how to merge them would
        // be worse than leaving them alone: the batch below will keep using `note_books`.
        if !table_exists(conn, "note_books")? {
            conn.execute_batch(
                "DROP INDEX IF EXISTS idx_note_folders_tree;
                 ALTER TABLE note_folders RENAME TO note_books;",
            )?;
        }
    }

    // Independent of the table above: a database could in principle have one renamed and not the
    // other, and each half is separately safe to finish.
    if table_exists(conn, "notes")?
        && has_column(conn, "notes", "folder_id")?
        && !has_column(conn, "notes", "book_id")?
    {
        conn.execute_batch(
            "DROP INDEX IF EXISTS idx_notes_folder;
             ALTER TABLE notes RENAME COLUMN folder_id TO book_id;",
        )?;
    }
    Ok(())
}

fn table_exists(conn: &Connection, name: &str) -> rusqlite::Result<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
            rusqlite::params![name],
            |_| Ok(true),
        )
        .optional()?
        .unwrap_or(false))
}

fn has_column(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let name: String = row.get(1)?;
        if name == column {
            return Ok(true);
        }
    }
    Ok(false)
}

/// `review_contexts` used to be scoped per-project (`project_id`); it's now per-workspace.
/// For any database created before this change, re-point each existing row at its project's
/// workspace (rather than just dropping the column, which would silently discard content the
/// user already wrote) and drop the old column.
fn migrate_review_contexts_to_workspace(conn: &Connection) -> rusqlite::Result<()> {
    if !has_column(conn, "review_contexts", "project_id")? {
        return Ok(());
    }
    conn.execute_batch(
        r#"
        ALTER TABLE review_contexts ADD COLUMN workspace_id TEXT;
        UPDATE review_contexts
            SET workspace_id = (SELECT workspace_id FROM projects WHERE projects.id = review_contexts.project_id);
        DELETE FROM review_contexts WHERE workspace_id IS NULL;
        ALTER TABLE review_contexts DROP COLUMN project_id;
        "#,
    )
}

/// The old `workspace_md_files` ("Instructions / .md") was functionally identical to
/// `review_contexts` — both were just named text blocks folded into the review prompt. They're now
/// one concept ("Contexto"), so move any md-file rows into `review_contexts` (name = filename) and
/// drop the old table. No-op on fresh installs where the table never existed.
fn migrate_md_files_into_contexts(conn: &Connection) -> rusqlite::Result<()> {
    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspace_md_files'",
            [],
            |_| Ok(true),
        )
        .optional()?
        .unwrap_or(false);
    if !exists {
        return Ok(());
    }
    conn.execute_batch(
        r#"
        INSERT OR IGNORE INTO review_contexts (id, workspace_id, name, content, enabled, created_at)
            SELECT id, workspace_id, filename, content, enabled, created_at FROM workspace_md_files;
        DROP TABLE workspace_md_files;
        "#,
    )
}

/// Moves any rows from the original per-workspace `workspace_review_standards` table (added
/// earlier in this feature's life) into the generalized `workspace_prompts` table under
/// `kind = 'review_standard'`, then drops the old table. No-op on fresh installs where the old
/// table never existed.
fn migrate_review_standards_into_prompts(conn: &Connection) -> rusqlite::Result<()> {
    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspace_review_standards'",
            [],
            |_| Ok(true),
        )
        .optional()?
        .unwrap_or(false);
    if !exists {
        return Ok(());
    }
    conn.execute_batch(
        r#"
        INSERT OR IGNORE INTO workspace_prompts (workspace_id, kind, content, updated_at)
            SELECT workspace_id, 'review_standard', content, updated_at FROM workspace_review_standards;
        DROP TABLE workspace_review_standards;
        "#,
    )
}

/// Seeds the built-in default of every prompt `kind` into every workspace that doesn't have that
/// row yet — both workspaces created before this feature existed and any created outside
/// `create_workspace` (e.g. an imported DB). Seeding the actual default text (not a blank) means
/// users see and can edit the real methodology/template rather than an empty box.
fn backfill_workspace_prompts(conn: &Connection) -> rusqlite::Result<()> {
    let now = crate::db::queries::now();
    for (kind, default) in crate::db::queries::WORKSPACE_PROMPT_KINDS {
        conn.execute(
            "INSERT INTO workspace_prompts (workspace_id, kind, content, updated_at)
             SELECT w.id, ?1, ?2, ?3 FROM workspaces w
             WHERE NOT EXISTS (
                 SELECT 1 FROM workspace_prompts p WHERE p.workspace_id = w.id AND p.kind = ?1
             )",
            rusqlite::params![kind, default, now],
        )?;
    }
    Ok(())
}

/// Superseded by `workspace_skills` — the old table was never actually used for anything
/// (skills management wasn't implemented yet), so there's no data worth preserving.
fn drop_legacy_installed_skills(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch("DROP TABLE IF EXISTS installed_skills;")
}

/// `activity_log` originally had no `session_id` column — for a database created before
/// conversations were grouped by session, add it (existing rows just become un-groupable
/// single turns, which is fine, there's no old session id to backfill them with).
fn add_session_id_to_activity_log(conn: &Connection) -> rusqlite::Result<()> {
    if has_column(conn, "activity_log", "session_id")? {
        return Ok(());
    }
    conn.execute_batch("ALTER TABLE activity_log ADD COLUMN session_id TEXT;")
}

/// Splits the two meanings `session_id` used to carry.
///
/// `session_id` is now the **conversation** id — minted by the app when a chat starts, stable for
/// its whole life, and the key everything groups by. The engine's own resume token moves here,
/// because it is not a conversation identity: Gemini/agy reports one fixed sentinel for every run
/// (so every chat ever collapsed into a single activity), while the Claude CLI can mint a *new*
/// id on each resumed turn (so one conversation could scatter across several activities). Old
/// rows keep grouping by whatever they stored, which is the best that data supports.
fn add_engine_session_id_to_activity_log(conn: &Connection) -> rusqlite::Result<()> {
    if has_column(conn, "activity_log", "engine_session_id")? {
        return Ok(());
    }
    conn.execute_batch("ALTER TABLE activity_log ADD COLUMN engine_session_id TEXT;")
}

/// What the engine printed while producing this turn (tool calls, progress), as JSON. Lets a
/// finished answer still show *how* it was reached, days later — rows written before this simply
/// have no trace to show.
fn add_trace_to_activity_log(conn: &Connection) -> rusqlite::Result<()> {
    if has_column(conn, "activity_log", "trace")? {
        return Ok(());
    }
    conn.execute_batch("ALTER TABLE activity_log ADD COLUMN trace TEXT;")
}

/// `activity_log` originally didn't record how long a reply took — for a database created before
/// that, add the column (existing rows stay NULL and simply show no timing, which is exactly the
/// pre-change behavior).
fn add_response_time_to_activity_log(conn: &Connection) -> rusqlite::Result<()> {
    if has_column(conn, "activity_log", "response_time_ms")? {
        return Ok(());
    }
    conn.execute_batch("ALTER TABLE activity_log ADD COLUMN response_time_ms INTEGER;")
}

/// Failed turns used not to be recorded at all — for a database created before that, add the flag
/// (every existing row is a successful turn, which is what the `0` default says).
fn add_is_error_to_activity_log(conn: &Connection) -> rusqlite::Result<()> {
    if has_column(conn, "activity_log", "is_error")? {
        return Ok(());
    }
    conn.execute_batch("ALTER TABLE activity_log ADD COLUMN is_error INTEGER NOT NULL DEFAULT 0;")
}

/// Which engine answered a turn — provider, model and CLI version. Recorded per turn because the
/// alternative (reading today's settings when a conversation is reopened) would credit an old
/// answer to whatever engine happens to be configured now. Rows written before this stay NULL and
/// simply show no engine stamp. Added together since they're always written as a set.
fn add_engine_meta_to_activity_log(conn: &Connection) -> rusqlite::Result<()> {
    for column in ["provider", "model", "engine_version"] {
        if !has_column(conn, "activity_log", column)? {
            conn.execute_batch(&format!("ALTER TABLE activity_log ADD COLUMN {column} TEXT;"))?;
        }
    }
    Ok(())
}

/// `job_history` originally had no `custom_label` column — for a database created before
/// renaming was supported, add it (existing rows just have no override, falling back to
/// their auto-derived label, which is exactly the pre-rename behavior).
fn add_custom_label_to_job_history(conn: &Connection) -> rusqlite::Result<()> {
    if has_column(conn, "job_history", "custom_label")? {
        return Ok(());
    }
    conn.execute_batch("ALTER TABLE job_history ADD COLUMN custom_label TEXT;")
}

/// `projects` gained `github_owner`/`github_repo` when GitHub was added alongside Azure DevOps
/// as a PR host — for a database created before that, add the columns (existing rows simply
/// have no GitHub link, exactly the pre-GitHub behavior). Added together since they're always
/// set/cleared as a pair.
fn add_github_columns_to_projects(conn: &Connection) -> rusqlite::Result<()> {
    if !has_column(conn, "projects", "github_owner")? {
        conn.execute_batch("ALTER TABLE projects ADD COLUMN github_owner TEXT;")?;
    }
    if !has_column(conn, "projects", "github_repo")? {
        conn.execute_batch("ALTER TABLE projects ADD COLUMN github_repo TEXT;")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The schema batch as it stood before the `api_*` tables were scoped to a workspace, derived
    /// from the current one so the two can't drift apart: strip the `workspace_id` columns and
    /// un-scope the two indexes that now lead with it.
    fn legacy_schema() -> String {
        let current = include_str!("migrations.rs");
        let start = current.find("PRAGMA foreign_keys = ON;").expect("schema batch");
        let end = current[start..].find("\"#,").expect("end of batch") + start;
        current[start..end]
            .replace(
                "            workspace_id TEXT NOT NULL DEFAULT '' REFERENCES workspaces(id) ON DELETE CASCADE,\n",
                "",
            )
            .replace(
                "ON api_cookies (workspace_id, domain, path, name)",
                "ON api_cookies (domain, path, name)",
            )
            .replace(
                "ON api_history (workspace_id, created_at DESC)",
                "ON api_history (created_at DESC)",
            )
            // Every index over a `workspace_id` this strips has to be patched too, or it is left
            // naming a column that no longer exists. `idx_db_history_time` escapes only because
            // `db_query_history` aligns its column declaration differently and so isn't matched
            // above — which is luck, not design, and the reason this list has to be maintained.
            .replace(
                "ON remote_log (workspace_id, at DESC)",
                "ON remote_log (at DESC)",
            )
            .replace(
                "ON remote_groups (workspace_id, name)",
                "ON remote_groups (name)",
            )
            .replace("ON db_groups (workspace_id, name)", "ON db_groups (name)")
    }

    fn legacy_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(&legacy_schema()).unwrap();
        conn.execute_batch(
            r#"
            INSERT INTO workspaces (id, name, created_at, sort_order) VALUES ('w-old', 'Flow', '2020-01-01', 0);
            INSERT INTO workspaces (id, name, created_at, sort_order) VALUES ('w-new', 'Other', '2021-01-01', 1);
            INSERT INTO api_collections (id, name, created_at, updated_at) VALUES ('c1', 'My API', 't', 't');
            INSERT INTO api_folders (id, collection_id, name, created_at) VALUES ('f1', 'c1', 'Auth', 't');
            INSERT INTO api_requests (id, collection_id, folder_id, name, created_at, updated_at)
                VALUES ('r1', 'c1', 'f1', 'Login', 't', 't');
            INSERT INTO api_environments (id, name, is_global, created_at) VALUES ('e-glob', 'Globals', 1, 't');
            INSERT INTO api_environments (id, name, is_global, created_at) VALUES ('e1', 'Dev', 0, 't');
            INSERT INTO api_history (id, url, created_at) VALUES ('h1', 'https://x', 't');
            INSERT INTO api_cookies (id, domain, path, name, updated_at) VALUES ('k1', 'a.com', '/', 'sid', 't');
            "#,
        )
        .unwrap();
        conn
    }

    fn scalar(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |row| row.get(0)).unwrap()
    }

    #[test]
    fn migrating_a_pre_workspace_database_keeps_every_row_and_reparents_it() {
        let conn = legacy_db();
        run(&conn).unwrap();

        // Content survives, assigned to the oldest workspace.
        assert_eq!(
            scalar(&conn, "SELECT COUNT(*) FROM api_collections WHERE workspace_id = 'w-old'"),
            1
        );
        assert_eq!(scalar(&conn, "SELECT COUNT(*) FROM api_folders"), 1);
        assert_eq!(scalar(&conn, "SELECT COUNT(*) FROM api_requests"), 1);
        assert_eq!(
            scalar(&conn, "SELECT COUNT(*) FROM api_history WHERE workspace_id = 'w-old'"),
            1
        );
        assert_eq!(
            scalar(&conn, "SELECT COUNT(*) FROM api_cookies WHERE workspace_id = 'w-old'"),
            1
        );
        assert_eq!(
            scalar(&conn, "SELECT COUNT(*) FROM api_environments WHERE id = 'e1' AND workspace_id = 'w-old'"),
            1
        );

        // Exactly one Globals per workspace: the legacy one is dropped, not carried over.
        assert_eq!(scalar(&conn, "SELECT COUNT(*) FROM api_environments WHERE is_global = 1"), 2);
        assert_eq!(
            scalar(&conn, "SELECT COUNT(DISTINCT workspace_id) FROM api_environments WHERE is_global = 1"),
            2
        );

        // The children's foreign keys still point at `api_collections`, not at the renamed table —
        // this is what `legacy_alter_table` protects, and it fails loudly if that pragma is lost.
        let folders_sql: String = conn
            .query_row("SELECT sql FROM sqlite_master WHERE name = 'api_folders'", [], |r| r.get(0))
            .unwrap();
        assert!(folders_sql.contains("REFERENCES api_collections(id)"), "{folders_sql}");
        assert!(!folders_sql.contains("legacy"), "{folders_sql}");

        // No leftovers, and deleting the workspace now cascades the whole API tree away.
        assert!(!table_exists(&conn, "api_collections_legacy").unwrap());
        conn.execute_batch("PRAGMA foreign_keys = ON; DELETE FROM workspaces WHERE id = 'w-old';")
            .unwrap();
        assert_eq!(scalar(&conn, "SELECT COUNT(*) FROM api_collections"), 0);
        assert_eq!(scalar(&conn, "SELECT COUNT(*) FROM api_requests"), 0);
        assert_eq!(scalar(&conn, "SELECT COUNT(*) FROM api_cookies"), 0);
    }

    fn text(conn: &Connection, sql: &str) -> Option<String> {
        conn.query_row(sql, [], |row| row.get(0)).optional().unwrap()
    }

    /// An install that was running local models on the retired Ollama engine has to come back up on
    /// Cline pointed at the same model — and must not come back up trying to launch a URL.
    #[test]
    fn an_ollama_install_moves_to_cline_without_losing_which_model_it_ran() {
        let conn = Connection::open_in_memory().unwrap();
        run(&conn).unwrap();
        conn.execute_batch(
            r#"
            INSERT OR REPLACE INTO app_settings (key, value) VALUES
                ('ai_provider', 'ollama'),
                ('ai_provider_review', 'claude'),
                ('ai_provider_commit', 'local'),
                ('ollama_model', 'qwen2.5-coder'),
                ('ollama_commit_model', 'llama3.1'),
                ('ollama_binary_path', 'http://localhost:11434');
            INSERT INTO workspaces (id, name, icon, color, sort_order, created_at)
                VALUES ('w1', 'W', 'folder', '#111', 0, 't');
            INSERT INTO workspace_agents (id, workspace_id, name, provider, model, created_at)
                VALUES ('a1', 'w1', 'Dev', 'ollama', 'qwen2.5-coder', 't');
            "#,
        )
        .unwrap();

        run(&conn).unwrap();

        assert_eq!(text(&conn, "SELECT value FROM app_settings WHERE key = 'ai_provider'").as_deref(), Some("cline"));
        // `local` was the same engine under its other id.
        assert_eq!(
            text(&conn, "SELECT value FROM app_settings WHERE key = 'ai_provider_commit'").as_deref(),
            Some("cline")
        );
        // A provider that was never Ollama is left exactly as the user set it.
        assert_eq!(
            text(&conn, "SELECT value FROM app_settings WHERE key = 'ai_provider_review'").as_deref(),
            Some("claude")
        );
        // Same model, same machine — now addressed the way Cline addresses it.
        assert_eq!(
            text(&conn, "SELECT value FROM app_settings WHERE key = 'cline_model'").as_deref(),
            Some("ollama/qwen2.5-coder")
        );
        assert_eq!(
            text(&conn, "SELECT value FROM app_settings WHERE key = 'cline_commit_model'").as_deref(),
            Some("ollama/llama3.1")
        );
        // The endpoint is dropped rather than carried over: it is not a path to any executable, and
        // an engine pointed at it could only fail to launch.
        assert_eq!(text(&conn, "SELECT value FROM app_settings WHERE key = 'ollama_binary_path'"), None);
        assert_eq!(text(&conn, "SELECT value FROM app_settings WHERE key = 'ollama_model'"), None);
        // A pinned agent runs on the new engine, still on its own model.
        assert_eq!(text(&conn, "SELECT provider FROM workspace_agents WHERE id = 'a1'").as_deref(), Some("cline"));
        assert_eq!(
            text(&conn, "SELECT model FROM workspace_agents WHERE id = 'a1'").as_deref(),
            Some("ollama/qwen2.5-coder")
        );

        // Idempotent: a second launch finds nothing left to move and changes nothing.
        run(&conn).unwrap();
        assert_eq!(
            text(&conn, "SELECT value FROM app_settings WHERE key = 'cline_model'").as_deref(),
            Some("ollama/qwen2.5-coder")
        );
    }

    /// A Cline setting the user already has is theirs; the migration only fills gaps.
    #[test]
    fn an_existing_cline_model_is_never_overwritten_by_the_old_ollama_one() {
        let conn = Connection::open_in_memory().unwrap();
        run(&conn).unwrap();
        conn.execute_batch(
            "INSERT OR REPLACE INTO app_settings (key, value) VALUES
                ('cline_model', 'cline/anthropic/claude-sonnet-4-5'),
                ('ollama_model', 'qwen2.5-coder');",
        )
        .unwrap();

        run(&conn).unwrap();

        assert_eq!(
            text(&conn, "SELECT value FROM app_settings WHERE key = 'cline_model'").as_deref(),
            Some("cline/anthropic/claude-sonnet-4-5")
        );
        assert_eq!(text(&conn, "SELECT value FROM app_settings WHERE key = 'ollama_model'"), None);
    }

    #[test]
    fn migration_is_idempotent_and_a_fresh_database_needs_no_migration() {
        let conn = legacy_db();
        run(&conn).unwrap();
        run(&conn).unwrap();
        assert_eq!(scalar(&conn, "SELECT COUNT(*) FROM api_collections"), 1);
        assert_eq!(scalar(&conn, "SELECT COUNT(*) FROM api_environments WHERE is_global = 1"), 2);

        let fresh = Connection::open_in_memory().unwrap();
        run(&fresh).unwrap();
        assert!(has_column(&fresh, "api_collections", "workspace_id").unwrap());
    }

    /// A database with API rows but no workspace has nowhere to put them; the rows must be kept
    /// for a later launch rather than dropped on the floor.
    #[test]
    fn a_database_with_no_workspace_keeps_the_legacy_rows() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(&legacy_schema()).unwrap();
        conn.execute_batch(
            "INSERT INTO api_collections (id, name, created_at, updated_at) VALUES ('c1', 'Kept', 't', 't');",
        )
        .unwrap();
        run(&conn).unwrap();
        assert!(table_exists(&conn, "api_collections_legacy").unwrap());
        assert_eq!(scalar(&conn, "SELECT COUNT(*) FROM api_collections_legacy"), 1);

        // Once a workspace exists, the next launch finishes the job.
        conn.execute_batch(
            "INSERT INTO workspaces (id, name, created_at, sort_order) VALUES ('w1', 'W', 't', 0);",
        )
        .unwrap();
        run(&conn).unwrap();
        assert_eq!(scalar(&conn, "SELECT COUNT(*) FROM api_collections WHERE workspace_id = 'w1'"), 1);
        assert!(!table_exists(&conn, "api_collections_legacy").unwrap());
    }


    /// The crash a development database actually hit: `notes` already existed with `folder_id`, so
    /// the batch's `IF NOT EXISTS` skipped it and the `book_id` index took the launch down.
    #[test]
    fn a_folder_named_notes_database_is_renamed_rather_than_crashing() {
        let conn = Connection::open_in_memory().unwrap();
        run(&conn).unwrap();
        conn.execute_batch(
            r#"
            DELETE FROM workspaces;
            INSERT INTO workspaces (id, name, icon, color, sort_order, created_at)
                VALUES ('w1', 'Flow', 'folder', '#111', 0, '2026-01-01T00:00:00+00:00');
            DROP TABLE notes;
            DROP TABLE note_books;
            CREATE TABLE note_folders (
                id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
                parent_id TEXT REFERENCES note_folders(id) ON DELETE CASCADE, name TEXT NOT NULL,
                color TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE INDEX idx_note_folders_tree ON note_folders (workspace_id, parent_id, sort_order);
            CREATE TABLE notes (
                id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
                folder_id TEXT REFERENCES note_folders(id) ON DELETE SET NULL,
                title TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '',
                excerpt TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]',
                pinned INTEGER NOT NULL DEFAULT 0, word_count INTEGER NOT NULL DEFAULT 0,
                sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE INDEX idx_notes_folder ON notes (folder_id, sort_order);
            INSERT INTO note_folders (id, workspace_id, parent_id, name, sort_order, created_at, updated_at)
                VALUES ('f1', 'w1', NULL, 'Runbooks', 0, 't', 't');
            INSERT INTO notes (id, workspace_id, folder_id, title, content, created_at, updated_at)
                VALUES ('n1', 'w1', 'f1', 'Despliegue', 'cuerpo', 't', 't');
            "#,
        )
        .unwrap();

        // The state a crashed launch leaves behind: the new table created, empty, beside the old.
        conn.execute_batch(
            "CREATE TABLE note_books (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
             parent_id TEXT, name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '',
             sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);",
        )
        .unwrap();

        run(&conn).unwrap();

        assert!(!table_exists(&conn, "note_folders").unwrap(), "the old table is gone");
        assert!(has_column(&conn, "notes", "book_id").unwrap());
        assert!(!has_column(&conn, "notes", "folder_id").unwrap());
        // And the writing survived the rename, which is the entire point.
        let (book, title): (String, String) = conn
            .query_row("SELECT book_id, title FROM notes WHERE id = 'n1'", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();
        assert_eq!(book, "f1");
        assert_eq!(title, "Despliegue");
        assert_eq!(scalar(&conn, "SELECT COUNT(*) FROM note_books"), 1);

        // Idempotent: the next launch must not undo or repeat any of it.
        run(&conn).unwrap();
        assert_eq!(scalar(&conn, "SELECT COUNT(*) FROM note_books"), 1);
    }

    /// The spelling in `projects.ado_org` has to be the one the organisation was connected under,
    /// or the PAT lookup asks for a key nobody wrote. Only case differences are rewritten, and only
    /// where a connection matches — a repository pointing at an organisation the user never
    /// connected is left exactly as it is.
    #[test]
    fn project_ado_org_is_aligned_with_the_connected_spelling() {
        let conn = Connection::open_in_memory().unwrap();
        run(&conn).unwrap();
        conn.execute_batch(
            r#"
            DELETE FROM workspaces;
            INSERT INTO workspaces (id, name, icon, color, sort_order, created_at)
                VALUES ('w1', 'Flow', 'folder', '#111', 0, '2026-01-01T00:00:00+00:00');
            INSERT INTO projects (id, workspace_id, name, local_path, ado_org, sort_order, created_at)
                VALUES ('p1', 'w1', 'api', '/tmp/api', 'myorg', 0, '2026-01-01T00:00:00+00:00');
            INSERT INTO projects (id, workspace_id, name, local_path, ado_org, sort_order, created_at)
                VALUES ('p2', 'w1', 'web', '/tmp/web', 'Unconnected', 0, '2026-01-01T00:00:00+00:00');
            INSERT INTO projects (id, workspace_id, name, local_path, sort_order, created_at)
                VALUES ('p3', 'w1', 'plain', '/tmp/plain', 0, '2026-01-01T00:00:00+00:00');
            INSERT OR REPLACE INTO app_settings (key, value)
                VALUES ('ado_connections', '[{"org":"MyOrg"}]');
            "#,
        )
        .unwrap();

        align_project_ado_org_with_connections(&conn).unwrap();

        let org = |id: &str| -> Option<String> {
            conn.query_row("SELECT ado_org FROM projects WHERE id = ?1", [id], |row| row.get(0))
                .unwrap()
        };
        assert_eq!(org("p1").as_deref(), Some("MyOrg"), "the connected spelling wins");
        assert_eq!(org("p2").as_deref(), Some("Unconnected"), "no connection, no rewrite");
        assert_eq!(org("p3"), None, "a project with no Azure link is untouched");
    }
}
