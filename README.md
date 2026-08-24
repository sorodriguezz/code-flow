<div align="center">

<img src="src-tauri/icons/128x128@2x.png" width="88" alt="CodeFlow" />

# CodeFlow

### Your desktop Git client, with the AI you choose.

Manage repositories, review pull requests, watch your pipelines, turn a specification into a
ready backlog, and let AI write your commits, find bugs and resolve conflicts — all in a fast,
native app. And when you're done, test the endpoint you just changed, query the database behind
it and SSH into the box it runs on without leaving the window. **You decide which model does
what.**

![version](https://img.shields.io/badge/version-1.18.9-6C5CE7)
![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-2D3436)
![providers](https://img.shields.io/badge/AI-7%20engines-00B894)
![languages](https://img.shields.io/badge/languages-EN%20%7C%20ES-0984E3)

**English** · [Español](README.es.md)

</div>

---

CodeFlow gathers in one place what is normally split between your Git client, the
GitHub/GitLab/Azure DevOps website, your Jira, monday or Azure board, a REST client, a database
tool, an SSH client and a separate terminal. You read your history, stage and commit changes,
open and review pull requests, watch the build that follows them, write the backlog for what
comes next, and work with an AI assistant that understands your repository.

**What you won't find in another client:** it doesn't marry you to one AI provider. Use several
at once and give each task to the model that suits it — including a **local** one, if your code
can't leave your machine.

## ✨ At a glance

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/graph.png" alt="Commit graph" /></td>
    <td width="50%"><img src="docs/screenshots/changes.png" alt="Changes and diff" /></td>
  </tr>
  <tr>
    <td align="center"><b>Commit graph</b> — history and branches at a glance</td>
    <td align="center"><b>Changes</b> — unified or side-by-side diff</td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/ai-settings.png" alt="AI assistant" /></td>
    <td width="50%"><img src="docs/screenshots/pr-review.png" alt="AI review" /></td>
  </tr>
  <tr>
    <td align="center"><b>AI assistant</b> — providers and a model per task</td>
    <td align="center"><b>AI review</b> — clear, actionable findings</td>
  </tr>
</table>

## 🧠 AI, your way

Six engines you plug in, plus a seventh that ships inside the app. CodeFlow **detects which ones
you have installed** and tells you what's missing, instead of leaving you to guess why something
doesn't work.

| Provider | How it works | Best for |
|---|---|---|
| **Claude Code** | CLI, with tools | Deep reviews and applying fixes |
| **Codex** | CLI, with tools | Your ChatGPT subscription, not API credits |
| **Gemini** | CLI (Antigravity), with tools | A strong alternative on a Google account |
| **Grok** | CLI, with tools | Resumes the exact conversation, not "the last one" |
| **Open Code** | CLI, any model you configure | Mixing providers however you like |
| **Cline** | CLI, with tools — 🔒 **local** via Ollama, or any API you point it at | Full privacy offline, or OpenAI / OpenRouter / Groq / Azure with tools |

**Cline is also the door to every OpenAI-compatible endpoint.** `cline auth openai` — or any
compatible base URL configured inside it — reaches the same services a bare API-key entry would,
and reaches them *with tools*, so fixing a finding works there too.

### ⚡ Autocomplete that never leaves your machine

The seventh engine isn't a provider you install — **it comes in the installer**. A trimmed
`llama-server` ships inside the app (22 MB on macOS, 38 MB on Windows) and writes ghost text in
the editor as you type.

- **The model is yours to pick and download once**, from the catalogue in
  **Settings › Editor** — a 0.5B answers in under 200 ms on a laptop, and bigger ones are there
  when you want them. Downloads resume if the connection drops.
- **Lazy by design**: the engine starts on the first suggestion and stops when you stop coding.
  Nothing runs in the background because you installed it.
- **Offline, free, and yours.** No API key, no token bill, no line of code leaving the machine —
  useful even on the days your provider is down.

### A different engine for every task

Here's the difference: you don't pick "an AI" — you pick **who does what**.

| Task | For example… |
|---|---|
| Commit message | A local model: instant, free, never leaves your machine |
| Pre-commit analysis | Something fast, since it runs on every change |
| Pull request review | The most capable one you have — this is where it pays off |
| PR description | Whichever writes best |
| Fixing findings | One with tool access, so it edits the files |
| Conflict resolution | Whichever you prefer, local included |

Anything left on **"inherit"** uses your default provider, so you can ignore the whole table if
one model does everything you need. And you switch model **in two clicks** from the chat itself,
without going through Settings.

### What it does for you

- **Chat with your repo** — it reads files, searches the code and checks Git state to answer you.
- **Commit messages** written from what you've staged.
- **Pre-commit analysis** — finds bugs and vulnerabilities before you commit, with a quality gate for reliability, security and maintainability.
- **Fix findings in one click** — the AI applies the change in your working tree.
- **Resolve conflicts** — an editable proposal, diffed against the original file, that touches nothing until you accept.
- **Create pull requests** with a title and description generated from the diff.
- **Customizable templates** for all five actions, shared across providers.

> 🔒 **Code that can't leave the company?** Set Cline as your provider, point it at a local model
> (`cline auth ollama`) and everything above runs on your machine, offline and with no cost per
> token — fixing findings included, because Cline drives the model instead of just completing text.

### What it's costing you

A meter in Settings keeps **spend and plan quota apart**, because they are different questions
with different answers: what you have been billed for tokens, and how much of a subscription's
allowance today's work has eaten. Providers that publish a limit show it; the ones that don't say
so plainly rather than inventing a number.

### Nothing is lost by looking away

Everything the AI starts lives in the background, not in the screen that started it.

- **Several conversations at once**, no cap: ask in one, open another and ask there while the
  first is still thinking.
- **Switching chats, opening a pull request or closing the panel cancels nothing.** The answer
  lands in the conversation that asked for it, on screen or not.
- **Activity lists it all while it runs** — chats, PR reviews, pre-commit analyses and fixes —
  with a count of how many are alive. One click puts you back where you were, live log still
  going and the stop button still there.
- **The timer tells the truth**: it counts from when the task started, not from when you looked
  back at it.

## 🤖 Agents that keep working while you don't

An agent is a **role with its own engine**: a name, a model and standing instructions, written
once and reused. The documenter on a cheap model, the reviewer on the best one you have — without
touching your global settings. It's the same roster the chat's agent picker uses, so there aren't
two lists to keep in step.

- **Tasks** — hand an agent a goal and a repository, then walk away. It keeps running while you
  switch views or workspaces, and waits at **Your turn** when it needs an answer from you.
- **Chains** — several agents in a row, each handed the previous one's work: architect →
  implementer → reviewer. Put a **gate** on any step and the chain stops to show you the exact
  message it's about to send, which you can edit before it goes.
- **Review what it did** against the real diff of that repository, the same way you'd review your
  own work.
- **Move up a model mid-conversation** when the job turns out harder than it looked.
- If a step fails the chain **stops and waits**: retry, skip or abort. It never quietly loops or
  reruns on its own.

> ⚠️ Agents edit your working copy **for real**. Every turn takes a restore point before it
> starts, and only one agent runs per repository at a time — but these are your files, not a
> sandbox. To work in parallel, split the work across repositories.

## 🌳 Git, visually

- **Commit graph** with branches, to read history at a glance.
- **Stage, commit and discard** changes; **unified or side-by-side** diff, selectable for copying.
- **Branches, remotes and stashes** within reach, with **undo commit** for when you get it wrong.
- **Automatic background fetch**: you always know how many commits you're ahead or behind.
- **Clone repositories**, open several projects and group them into **workspaces**.
- **Built-in terminal** (multiple tabs and panes) and a **code editor** with local autocomplete,
  Markdown preview and diagram preview.
- **Run and debug** through the Debug Adapter Protocol, with breakpoints and variables.
- **Hide the noise**: right-click anything in the file tree to hide it from *your* view — a
  per-repository filter that never touches disk and never reaches a commit.

## 🚦 The build that follows the push

A **Pipelines** tab appears on repositories linked to a host that has CI — **GitHub Actions**,
**GitLab CI** and **Azure Pipelines** — and stays away from the ones that don't, rather than
showing an empty screen.

- **Runs newest first**, with status, branch, commit, duration and **the date and time each one
  ran**, filterable by branch and by status.
- **A run isn't a list of jobs, it's a waterfall** — the graph shows what actually ran in
  parallel and what was waiting, which is where the minutes really went.
- **Job logs in the app**, ANSI intact, so a red build doesn't send you to a browser tab.
- **Live while it's live**: a running build refreshes itself and the elapsed time keeps counting.

## 🔀 Pull requests, without leaving the app

- Connect **GitHub**, **GitLab** and **Azure DevOps** — all at once, if you need to. Several
  accounts per host, too.
- **Review a PR by pasting only its link** (⇧⌘L): CodeFlow works out which of your repos it
  belongs to — even one in another workspace — and starts the review.
- Repo not on your machine? **Review it anyway, without cloning**: the diff is read from the
  host's API. That's a shallower review (the model can't see the rest of the code), so you can
  also clone it in one click for the full one.
- **List, review and comment** on PRs; **approve, request changes or close** them.
- **The review is planned before anything is spent**: CodeFlow trims each file down to the
  symbols the PR touched — the whole method, numbered, with `>` marking what changed — splits the
  work across several reviewers in parallel, and closes with a cross-file pass looking for what no
  single-file reviewer can see: signatures that left their callers behind, schemas that drifted
  apart.
- **Three depth levels** (basic · full · ultra) with a real contract rather than a suggestion:
  confidence threshold, reported severities, active lenses and parallelism. All of it is edited in
  Settings → Review → Engine, enforced in code, and frozen into every saved review so an old one
  still says which rules produced it.
- **Memory that gets consulted, not just stored**: what was already dismissed on those same files
  in other PRs comes back as context, and whoever else in the repository references the symbols
  you are touching arrives as a hint for contract changes.
- **Create a PR** with an AI title and description, as a draft too.
- Publish the **AI review's** comments straight onto the pull request.

## 📝 From a document to a backlog — and to the code

The part of the job that usually eats a meeting: turning a specification nobody has read into
stories somebody can actually build. It works in four directions, and all of them share your
workspace, your board connection and your repositories.

### Write

Point it at a wiki page, a folder of Markdown files or text you paste, and get a set of user
stories back — narrative, acceptance criteria in **Gherkin** ready for Cucumber, an estimate,
tags, and the questions the documentation left unanswered.

- **Every story is scored locally, with no model involved.** The narrative has its three parts, no
  scenario has two "When", every criterion is testable, the estimate is on the Fibonacci scale.
  It's a check worth trusting precisely because it's the same every time — not an opinion that
  changes on the next run.
- **Verify against your code.** Each criterion gets a verdict — met, not met, partial, unknown —
  backed by the file and line that proves it. That's how you find out what's already built before
  planning it a second time.
- **Export a `.feature` file** into the repository, so QA runs the criteria instead of reading them.
- **Publish** the stories you pick onto **Azure Boards**, **Jira** or **monday.com** — all
  connected at once, one board chosen per set. On Azure they carry their area, iteration and tags;
  on Jira their labels and estimate; on monday, whichever columns your board actually has, and the
  panel tells you which ones it matched before you publish.
- Everything is editable before any of that: fix a title, rewrite a scenario, drop a story. Edits
  save as you leave the field.

### Review

For a story, bug or item that **already exists** on the board. Paste its link — an Azure work
item, a Jira `PROJ-123`, a monday item — pick the repositories it touches, and find out what's
missing — in three passes you launch yourself:

1. **Analyse** — what the story lacks, judged on INVEST and testability. For a bug the bar is
   different: reproducible, expected, actual, scope.
2. **Criteria** — the Gherkin scenarios nobody wrote, based on the story *as it stands right
   now*, including your edits from the previous step.
3. **Tasks** — the breakdown into development and QA work, aware of the tasks it already has so it
   doesn't propose them twice.

Nothing reaches the board on its own. What you want to send goes into a publish column and you
confirm it field by field, seeing exactly what will change before it changes.

### Build

A story doesn't have to stop at the board. Hand it to an agent chain and it becomes a branch:

- **One story, one to many repositories.** A change that spans an API, a front end and a schema is
  one run, not three you have to keep in step by hand.
- **Two phases with a human gate between them.** It plans first and shows you the plan; nothing is
  written until you say so.
- It ends where your own work ends — in your working copy, with a diff to read.

### Wiki

The opposite direction: it reads the code and writes the technical documentation the other three
tabs assume somebody wrote.

- **Per repository** — how it's built, configured, run locally and deployed, including its
  environment variables, integrations and database.
- **Per workspace** — how several repositories fit together as a system: who calls whom, the
  contracts between them and where they're coupled.

It comes out as editable Markdown, and publishes to your wiki when it says what you mean.

## 🛰️ An API client, built in

Test the endpoint you just changed without switching apps — in the same window as the commit that
changed it.

- **Six protocols**: REST, GraphQL (with schema introspection), WebSocket, Socket.IO, gRPC (from a
  `.proto` file or server reflection) and MQTT.
- **Collections, folders and environments**, with variables resolved everywhere — URL, headers,
  body and auth.
- **Pre-request scripts and tests** in JavaScript, so a login can feed the call after it.
- **Bring what you already have**: import from Postman, OpenAPI/Swagger, Insomnia, HAR or a raw
  cURL command. Export back to Postman, OpenAPI or CodeFlow's own format.
- **Run a whole collection** and read the result as a report.
- **Generate the code** for a request in the language you work in.
- **Share a collection with your team** through **your own** Supabase project — you host it, so
  the requests and their secrets stay on infrastructure you control.

## 🗄️ Your databases, in the same window

The query you need to check is one tab away from the migration you just wrote.

- **Six engines**: PostgreSQL, Supabase, SQL Server, InterSystems IRIS, MongoDB and Redis.
- **Browse the tree** — schemas, tables, views, routines, sequences, columns, indexes and keys.
- **SQL console** with history, `EXPLAIN`, and results you can export.
- **Edit rows in a grid**: changes stage locally and you see the exact statements before anything
  runs.
- **Read the DDL** of any object, and the **schema diagram** with its foreign keys.
- **Read-only connections** for the ones you must not touch by accident, and an **SSH tunnel**
  when the database sits behind a bastion.
- Passwords go to the **system keychain**, never into the app's database.

## 🖥️ The machines your code runs on

An SSH client that knows it lives next to your repositories, in the same workspace as them.

- **Terminal sessions over SSH**, with your keys or a password, and **hosts imported from your
  existing `~/.ssh/config`** rather than typed in again.
- **Files both ways over SFTP and FTP**, so getting a log off a server isn't a context switch.
- **Port forwarding** for the database, the debugger or the staging app behind a bastion.
- **Cloud storage in the same tree**: Azure **Blob**, **Queue**, **Table** and **File shares**, and
  **Amazon S3** — browse buckets and containers, upload, download and delete, with the account key
  in the system keychain and never in the connection you saved.

## 📓 Notes and diagrams, next to the code they explain

Two workspaces for the writing and drawing *around* the work — the decision, the runbook, the
architecture — which don't change meaning when you click a different repository.

- **Notes**: Markdown notebooks, with templates for the documents you write more than once and an
  AI panel that drafts and rewrites without leaving the page.
- **Diagrams**: the full **draw.io** editor embedded in the app — every shape library, offline —
  plus **DBML** schemas written as text and rendered as a diagram. Export to PNG, SVG or PDF.
- Both are **per workspace**, so a client's notes don't turn up in another client's window.

## 🔑 Llavero, a password manager in the app

The credentials the work needs, in the window the work happens in — not in a text file on the
desktop.

- **One master password**, stretched with Argon2id and unwrapping a key that seals every item with
  AES-256-GCM. Change the password and 32 bytes get re-wrapped: it cannot half-succeed and leave
  the rest re-encrypted.
- **No stored verifier.** A wrong password fails to unwrap the key, and that *is* the check —
  there is nothing on disk that says what the right answer looks like.
- **Locks itself** after a while, and checks on use rather than only on a timer — a sleeping laptop
  runs no timers.
- Items, folders, attachments and an audit trail of what was opened and when.

## 📱 Your phone, when you're not at the machine

Turn on the remote-control server in Settings, put the six digits it shows into your phone's
browser, and the app has a second screen — no app store, no account, nothing published to the
internet.

- **Watch what's running**: agent tasks and chains, live, and answer the ones waiting at *Your
  turn* from wherever you are.
- **Review a pull request**, read the repository, and keep chatting to the assistant.
- **A terminal on your machine**, if you allow it — its own switch, off unless you turn it on.
- **Every device is revocable** one by one from the desktop, and administering the feature is
  something only the machine can do: a paired phone can't open a pairing window, move the port or
  revoke the device beside it.

## 🛟 Backups you can actually restore

- **Encrypted with a passphrase you choose**, and everything in one file: settings, connections,
  collections, notes, diagrams, reviews, agent work and — if you want them — your credentials.
- **On a schedule and on exit**, keeping the number of copies you ask for.
- **Where you say**: a folder, **Google Drive** or **OneDrive**.
- **Your repositories and your backups are never deleted by the app** — not by a reset, not by the
  uninstaller. They live in your own folder and stay there.

## 🔒 Security and privacy

- **Secret scanning before every commit** — catches API keys, tokens and private keys, and stops
  you in time. Deterministic rules, nothing sent anywhere.
- Your **tokens live in the system keychain**, never in plain text.
- **Per-user data.** The database, settings and vault live in your own account's application data,
  where another account on the same machine cannot read them.
- **Two ways to stay fully offline**: Cline over Ollama for the conversational work, and the
  bundled engine for autocomplete. Your code never leaves the machine.
- It's a desktop app: no cloud account, no telemetry. The only server is the one you switch on
  yourself for your phone, on your own network, and switch off again.

## 🎨 Make it yours

- **Light, dark or system** themes, with an accent color of your choosing.
- Interface in **English and Spanish**.
- **A guided tour on first launch** that walks the app screen by screen — and that you can leave
  and pick up again, because each step remembers where it was.
- **The app rail is yours to order**: hold an icon and move it, so the workspaces you live in are
  the ones under your thumb.
- **Prompt templates** for commit, analysis, review, PR description and conflicts — and for
  writing stories, verifying them and generating documentation, so the backlog comes out in your
  team's house style.
- The **PR review** ones are six, one per part of the engine: the lenses, each level's depth, the
  parallel reviewer, the cross-file pass and the closing summary. The numbers are not typed into
  them — they arrive from the Engine tab through `{{MIN_CONFIANZA}}`-style placeholders, so
  rewriting the wording can never put the instruction and the filter that enforces it out of step.
- Per workspace: **review context**, **instructions (.md)** and **Skills**.
- **Reusable agents** with their own model and standing instructions.
- **A full history** of what the AI has done — failures included, so tomorrow you know what happened.

## ⚙️ Getting started

**1. Open your repository**
Hit **+** in the sidebar and pick a folder with a Git repository. Repeat for as many as you like
and group them into workspaces.

**2. Choose your AI assistant**
**Settings › AI Assistant › Providers** shows the six engines with their status (*Available* /
*Not found*). Expand the one you want, check its binary and pick a model. Mark it as **default**
and you're done.

**3. Turn on autocomplete (optional)**
**Settings › Editor** downloads a completion model once and the editor starts suggesting. The
engine is already installed — there is nothing else to set up, and nothing leaves your machine.

**4. Tune it per task (optional)**
Under **Model per task**, give each action a different engine. Everything starts on "inherit", so
you only touch what you want to change.

**5. Connect your platform (optional)**
Under **Settings › Git Hosting**, connect **GitHub**, **GitLab** or **Azure DevOps** to see and
review pull requests and watch their pipelines — and, on Azure DevOps, to read wikis. **Jira** and
**monday.com** connect on the same screen — they host no code, so they appear for your backlog and
not for pull requests. Tokens are stored in your operating system's keychain, never in the app's
own database.

> 💡 Want to try it without an account? Install [Ollama](https://ollama.com), run
> `ollama pull qwen2.5-coder`, then `npm install -g cline` and `cline auth ollama`. Select
> **Cline** in Settings with the model `ollama/qwen2.5-coder`. No accounts, no keys.

## 💾 Download

Available for **Windows** and **macOS**. Grab the latest build from
**[Releases](../../releases)**, run the installer and open it. The app **updates itself** when a
new version lands.

It can keep running in the background (tray icon) so your terminals and AI tasks stay alive even
when you close the window.

## 🌐 Languages

English and Spanish, switchable at any time from **Settings › General**.

---

<div align="center">
<sub>Built for anyone who wants Git, reviews and AI in a single flow. 💜</sub>
</div>
