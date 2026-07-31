<div align="center">

<img src="src-tauri/icons/128x128@2x.png" width="88" alt="CodeFlow" />

# CodeFlow

### Your desktop Git client, with the AI you choose.

Manage repositories, review pull requests, and let AI write your commits, find bugs and
resolve conflicts — all in a fast, native app. And when you're done, test the endpoint
you just changed and query the database behind it without leaving the window.
**You decide which model does what.**

![version](https://img.shields.io/badge/version-1.10.2-6C5CE7)
![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-2D3436)
![providers](https://img.shields.io/badge/AI-7%20engines-00B894)
![languages](https://img.shields.io/badge/languages-EN%20%7C%20ES-0984E3)

**English** · [Español](README.es.md)

</div>

---

CodeFlow gathers in one place what is normally split between your Git client, the
GitHub/Azure DevOps website, a REST client, a database tool and a separate terminal. You
read your history, stage and commit changes, open and review pull requests, and work with
an AI assistant that understands your repository.

**What you won't find in another client:** it doesn't marry you to one AI provider. Use
several at once and give each task to the model that suits it — including a **local** one,
if your code can't leave your machine.

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

Pick from seven engines. CodeFlow **detects which ones you have installed** and tells you
what's missing, instead of leaving you to guess why something doesn't work.

| Provider | How it works | Best for |
|---|---|---|
| **Claude Code** | CLI, with tools | Deep reviews and applying fixes |
| **Codex** | CLI, with tools | Your ChatGPT subscription, not API credits |
| **Gemini** | CLI (Antigravity), with tools | A strong alternative on a Google account |
| **Grok** | CLI, with tools | Resumes the exact conversation, not "the last one" |
| **Open Code** | CLI, any model you configure | Mixing providers however you like |
| **Ollama** | 🔒 **Local**, no cloud | Full privacy, offline, no cost |
| **OpenAI** | API key, editable endpoint | OpenRouter, Groq, DeepSeek, Azure or vLLM |

The **OpenAI** entry speaks the usual `/v1/chat/completions` and the URL is yours to set,
so any compatible service works through it without waiting for an entry of its own. The
key goes to the system keychain.

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

Anything left on **"inherit"** uses your default provider, so you can ignore the whole
table if one model does everything you need. And you switch model **in two clicks** from
the chat itself, without going through Settings.

### What it does for you

- **Chat with your repo** — it reads files, searches the code and checks Git state to answer you.
- **Commit messages** written from what you've staged.
- **Pre-commit analysis** — finds bugs and vulnerabilities before you commit, with a quality gate for reliability, security and maintainability.
- **Fix findings in one click** — the AI applies the change in your working tree.
- **Resolve conflicts** — an editable proposal, diffed against the original file, that touches nothing until you accept.
- **Create pull requests** with a title and description generated from the diff.
- **Customizable templates** for all five actions, shared across providers.

> 🔒 **Code that can't leave the company?** Set Ollama as your provider and everything
> above runs on your machine, offline and with no cost per token.
> *(Features that edit files — fixing findings, MCP — need an engine with tools, meaning
> one of the five CLIs; the app says so and hides what doesn't apply.)*

### Nothing is lost by looking away

Everything the AI starts lives in the background, not in the screen that started it.

- **Several conversations at once**, no cap: ask in one, open another and ask there while
  the first is still thinking.
- **Switching chats, opening a pull request or closing the panel cancels nothing.** The
  answer lands in the conversation that asked for it, on screen or not.
- **Activity lists it all while it runs** — chats, PR reviews, pre-commit analyses and
  fixes — with a count of how many are alive. One click puts you back where you were,
  live log still going and the stop button still there.
- **The timer tells the truth**: it counts from when the task started, not from when you
  looked back at it.

## 🌳 Git, visually

- **Commit graph** with branches, to read history at a glance.
- **Stage, commit and discard** changes; **unified or side-by-side** diff, selectable for copying.
- **Branches, remotes and stashes** within reach, with **undo commit** for when you get it wrong.
- **Automatic background fetch**: you always know how many commits you're ahead or behind.
- **Clone repositories**, open several projects and group them into **workspaces**.
- **Built-in terminal** (multiple tabs and panes) and a **code editor** with Markdown and diagram preview.
- **Run and debug** through the Debug Adapter Protocol, with breakpoints and variables.

## 🔀 Pull requests, without leaving the app

- Connect **GitHub** and **Azure DevOps** — both at once, if you need to.
- **Review a PR by pasting only its link** (⇧⌘L): CodeFlow works out which of your repos it belongs to
  — even one in another workspace — and starts the review.
- Repo not on your machine? **Review it anyway, without cloning**: the diff is read from the host's API.
  That's a shallower review (the model can't see the rest of the code), so you can also clone it in one
  click for the full one.
- **List, review and comment** on PRs; **approve, request changes or close** them.
- **Create a PR** with an AI title and description, as a draft too.
- Publish the **AI review's** comments straight onto the pull request.

## 🛰️ An API client, built in

Test the endpoint you just changed without switching apps — in the same window as the
commit that changed it.

- **Six protocols**: REST, GraphQL (with schema introspection), WebSocket, Socket.IO,
  gRPC (from a `.proto` file or server reflection) and MQTT.
- **Collections, folders and environments**, with variables resolved everywhere — URL,
  headers, body and auth.
- **Pre-request scripts and tests** in JavaScript, so a login can feed the call after it.
- **Bring what you already have**: import from Postman, OpenAPI/Swagger, Insomnia, HAR or
  a raw cURL command. Export back to Postman, OpenAPI or CodeFlow's own format.
- **Run a whole collection** and read the result as a report.
- **Generate the code** for a request in the language you work in.
- **Share a collection with your team** through **your own** Supabase project — you host
  it, so the requests and their secrets stay on infrastructure you control.

## 🗄️ Your databases, in the same window

The query you need to check is one tab away from the migration you just wrote.

- **Five engines**: PostgreSQL, Supabase, SQL Server, InterSystems IRIS and MongoDB.
- **Browse the tree** — schemas, tables, views, routines, sequences, columns, indexes and keys.
- **SQL console** with history, `EXPLAIN`, and results you can export.
- **Edit rows in a grid**: changes stage locally and you see the exact statements before
  anything runs.
- **Read the DDL** of any object, and the **schema diagram** with its foreign keys.
- **Read-only connections** for the ones you must not touch by accident, and an **SSH
  tunnel** when the database sits behind a bastion.
- Passwords go to the **system keychain**, never into the app's database.

## 🔒 Security and privacy

- **Secret scanning before every commit** — catches API keys, tokens and private keys, and stops you in time. Deterministic rules, nothing sent anywhere.
- Your **tokens live in the system keychain**, never in plain text.
- A **100% local option** with Ollama: your code never leaves the machine.
- It's a desktop app: no server, no account, no telemetry.

## 🎨 Make it yours

- **Light, dark or system** themes, with an accent color of your choosing.
- Interface in **English and Spanish**.
- **Prompt templates** for commit, analysis, review, PR description and conflicts.
- Per workspace: **review context**, **instructions (.md)**, **Skills** and **MCP servers**.
- **A full history** of what the AI has done — failures included, so tomorrow you know what happened.

## ⚙️ Getting started

**1. Open your repository**
Hit **+** in the sidebar and pick a folder with a Git repository. Repeat for as many as
you like and group them into workspaces.

**2. Choose your AI assistant**
**Settings › AI Assistant › Providers** shows the seven engines with their status
(*Available* / *Not found*). Expand the one you want, check its binary — or its endpoint,
for Ollama and OpenAI — and pick a model. Mark it as **default** and you're done.

**3. Tune it per task (optional)**
Under **Model per task**, give each action a different engine. Everything starts on
"inherit", so you only touch what you want to change.

**4. Connect your platform (optional)**
Under **Settings › Git Hosting**, connect **GitHub** or **Azure DevOps** to see and review
pull requests. The token is stored in your operating system's keychain.

> 💡 Want to try it without installing any CLI? Install [Ollama](https://ollama.com), run
> `ollama pull qwen2.5-coder` and select it in Settings. No accounts, no keys.

## 💾 Download

Available for **Windows** and **macOS**. Grab the latest build from
**[Releases](../../releases)**, run the installer and open it. The app **updates itself**
when a new version lands.

It can keep running in the background (tray icon) so your terminals and AI tasks stay
alive even when you close the window.

## 🌐 Languages

English and Spanish, switchable at any time from **Settings › General**.

---

<div align="center">
<sub>Built for anyone who wants Git, reviews and AI in a single flow. 💜</sub>
</div>
