/* ==========================================================================
   CodeFlow — landing behaviour
   Spanish lives in the HTML; English lives here. Everything else is
   scroll orchestration, the GitHub release lookup and the media slots.
   ========================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* 1. English dictionary                                               */
  /* ------------------------------------------------------------------ */
  var EN = {
    'a11y.skip': 'Skip to content',

    'nav.workspace': 'Workspace', 'nav.ai': 'AI', 'nav.review': 'Review',
    'nav.tools': 'Tools', 'nav.privacy': 'Privacy', 'nav.download': 'Download',

    'hero.pill': 'v<span class="num" data-version>1.20.1</span> · Windows and macOS · Free',
    'hero.title': 'Your Git client,<br>with the AI <em class="ser">you</em> choose',
    'hero.lede': 'Read your history, review the pull request, watch the build that follows it, and let AI write your commits, find your bugs and resolve your conflicts. Then test the endpoint you just changed, query the database behind it and SSH into the box it runs on — without leaving the window.',
    'hero.win': 'Download for Windows', 'hero.mac': 'Download for macOS',
    'hero.yours': 'Your system',
    'hero.fine1': 'Updates itself', 'hero.fine2': 'No account, no telemetry',
    'hero.fine3': 'See all downloads',
    'hero.caption': 'The repository in the main window. The API client, pulled out into its own.',
    'hero.scroll': 'Scroll',

    'stats.1': 'tools in a single window',
    'stats.2': 'AI engines, one per task',
    'stats.3': 'protocols in the API client',
    'stats.4': 'Git platforms at once',

    'a1.eyebrow': 'The workspace',
    'a1.title': 'One window.<br><em class="ser">Fifteen</em> applications.',
    'a1.lede': 'Every icon in the rail is a full app, not a panel. They all share the same workspace, so switching client switches the repositories, the collections, the connections, the notes and the credentials together — and none of them leaks into the next client’s window.',
    'a1.s1k': 'Git', 'a1.s1h': 'History, readable at a glance',
    'a1.s1p': 'Commit graph with its branches, unified or side-by-side diff, stashes, remotes and an <b>undo commit</b> for when you get it wrong. Background fetch always tells you how many commits you are ahead or behind.',
    'a1.s2k': 'Editor', 'a1.s2h': 'The same Monaco, wired to the repository',
    'a1.s2p': 'Go to definition, hover and diagnostics through the language server. <b>Inline blame</b> on the line under your cursor. Split editors, drafts that survive a restart, and run &amp; debug over DAP with breakpoints.',
    'a1.s3k': 'Pipelines', 'a1.s3h': 'A run isn’t a list, it’s a waterfall',
    'a1.s3p': 'The graph shows what actually ran in parallel and what was waiting — which is where the minutes really went. Job logs with ANSI intact inside the app, and the clock keeps counting while the build is still alive.',
    'a1.s4k': 'API client', 'a1.s4h': 'Test the endpoint you just changed',
    'a1.s4p': 'Six protocols, collections, environments and variables resolved in URL, headers, body and auth. Import from Postman, OpenAPI, Insomnia, HAR or a pasted cURL.',
    'a1.s5k': 'Diagrams', 'a1.s5h': 'The schema is drawn while you type',
    'a1.s5p': 'DBML as text, drawn live — and the drawing is not read-only: every gesture is applied as a text edit, so ⌘Z takes it back like a keystroke. Next to it, the full draw.io, offline.',

    'tools.eyebrow': 'The full rail',
    'tools.title': 'Fifteen apps that share <em class="ser">one</em> workspace',
    'tools.hint': 'Keep scrolling',

    't.git.n': 'Git', 't.git.d': 'Graph, diffs, branches, stashes, undo commit and secret scanning before every commit.',
    't.pr.n': 'Pull requests', 't.pr.d': 'List, review, comment, approve and close. Several accounts per host, and a review from just the link.',
    't.ci.n': 'Pipelines', 't.ci.d': 'The run as a waterfall, with ANSI logs inside the app and live refresh while it runs.',
    't.ed.n': 'Editor', 't.ed.d': 'Monaco with LSP, inline blame, split editors, Markdown preview and debugging over DAP.',
    't.term.n': 'Terminal and services', 't.term.d': 'Services start in dependency order and each waits on a real gate: a port, an HTTP probe, a line in the log.',
    't.ag.n': 'Agents', 't.ag.d': 'A role with its own model and instructions. Tasks and chains with a human gate wherever you say.',
    't.api.n': 'API client', 't.api.d': 'Six protocols, collections, environments, pre-request scripts and tests in JavaScript.',
    't.db.n': 'Databases', 't.db.d': 'Full tree, SQL console with EXPLAIN, row editing in a grid and an SSH tunnel when there is a bastion.',
    't.dia.n': 'Diagrams', 't.dia.d': 'DBML drawn while you type, editable from the canvas — and the full draw.io, offline.',
    't.rem.n': 'Remote', 't.rem.d': 'SSH sessions with your keys, SFTP and FTP both ways, port forwarding and cloud storage.',
    't.note.n': 'Notes', 't.note.d': 'Markdown notebooks for the decision, the runbook and the postmortem, with templates and an AI panel.',
    't.key.n': 'Llavero', 't.key.d': 'A vault with a master password stretched with Argon2id and every item sealed with AES-256-GCM.',
    't.story.n': 'Stories', 't.story.d': 'From a document to a backlog: Gherkin criteria, verified against your code and published to your board.',
    't.wiki.n': 'Wiki', 't.wiki.d': 'It reads the code and writes the technical docs: per repository and per workspace, as a system.',
    't.bk.n': 'Backups', 't.bk.d': 'Encrypted with your passphrase, scheduled and restorable. To a folder, Google Drive or OneDrive.',

    'a2.eyebrow': 'Artificial intelligence',
    'a2.title': 'You don’t pick an AI.<br>You pick <em class="ser">who</em> does what.',
    'a2.lede': 'Six engines you plug in plus a seventh that ships inside the installer. CodeFlow detects which ones you have and tells you what is missing, instead of leaving you to guess why something doesn’t work. One row per action: which engine runs it, and what it is told.',
    'a2.s1k': 'Model per task', 'a2.s1h': 'A commit message doesn’t need your best model',
    'a2.s1p': 'The commit is written by a local model: instant, free and never leaving your machine. Anything left on <b>“inherit”</b> uses your default provider, so you can ignore the whole table if one model does everything you need.',
    'a2.s2k': 'Where it pays', 'a2.s2h': 'The PR review takes the most capable one you have',
    'a2.s2p': 'And fixing findings goes to one with tool access, so it edits the files for real. Switching model is <b>two clicks</b> from the chat itself, without going through Settings.',
    'a2.s3k': 'Offline', 'a2.s3h': 'Code that can’t leave the company?',
    'a2.s3p': 'Put Cline on a local model with Ollama and everything above runs on your machine, with no cost per token — fixing findings included, because Cline drives the model instead of just completing text.',
    'a2.s4k': 'In the background', 'a2.s4h': 'Nothing is lost by looking away',
    'a2.s4p': 'Several conversations at once, no cap. Switching chats, opening a PR or closing the panel <b>cancels nothing</b>: the answer lands in the conversation that asked for it, on screen or not.',
    'a2.card': 'Model per task',
    'a2.r1t': 'Commit message', 'a2.r1d': 'Instant, free, never leaves the machine',
    'a2.r2t': 'Pre-commit analysis', 'a2.r2d': 'Something fast: it runs on every change',
    'a2.r3t': 'Pull request review', 'a2.r3d': 'The most capable you have: this is where it pays',
    'a2.r4t': 'PR description', 'a2.r4d': 'Whichever writes best',
    'a2.r5t': 'Fixing findings', 'a2.r5d': 'With tools, so it edits the files',
    'a2.r6t': 'Conflict resolution', 'a2.r6d': 'Whichever you prefer, local included',

    'fa.eyebrow': 'Providers',
    'fa.title': 'Seven engines. The app tells you <em class="ser">which</em> you have.',
    'fa.p': 'Claude Code, Codex, Gemini, Grok, Open Code and Cline plug in with their own session — no API keys stored anywhere. The seventh isn’t installed: it comes in the installer.',
    'fa.l1': '<b>Local autocomplete</b> — a trimmed <code>llama-server</code> (22 MB on macOS, 38 MB on Windows) writes ghost text as you type.',
    'fa.l2': '<b>Lazy by design</b> — the engine starts on the first suggestion and stops when you stop typing. Nothing runs in the background because you installed it.',
    'fa.l3': '<b>Spend and quota, kept apart</b> — a meter separates what you were billed for tokens from what today’s work ate of a subscription. The ones that publish no limit say so, rather than inventing a number.',
    'fa.l4': '<b>Cline is the door</b> to every OpenAI-compatible endpoint — and it gets there <i>with tools</i>.',

    'a3.eyebrow': 'The review engine',
    'a3.title': 'The review is <em class="ser">planned</em> before anything is spent',
    'a3.lede': 'CodeFlow trims each file down to the symbols the PR touched — the whole method, numbered, with <code>&gt;</code> marking what changed — splits the work across several reviewers in parallel and closes with a cross-file pass looking for what no single-file reviewer can see.',
    'a3.f1': 'The token is written to the error log',
    'a3.f2': 'The signature changed and left three callers behind',
    'a3.f3': 'The schema and the DTO drifted apart',
    'a3.f4': 'Missing index on the foreign key',
    'a3.c1h': 'Three levels with a real contract',
    'a3.c1p': 'Basic, full and ultra. Confidence threshold, severities, active lenses and parallelism are edited in Settings, enforced in code, and frozen into every saved review.',
    'a3.c2h': 'Memory that gets consulted',
    'a3.c2p': 'What was already dismissed on those same files in other PRs comes back as context, and whoever else references the symbols you are touching arrives as a hint for contract changes.',
    'a3.c3h': 'Without cloning, if need be',
    'a3.c3p': 'Repo not on your machine? The diff is read from the host’s API. That is a shallower review and you are told so — and you clone it in one click for the full one.',
    'a3.c4h': 'Paste the link and go',
    'a3.c4p': '⇧⌘L with the PR URL: CodeFlow works out which of your repos it belongs to — even one in another workspace — and starts the review.',

    'fb.eyebrow': 'Git',
    'fb.title': 'Stage, commit and <em class="ser">undo</em>',
    'fb.p': 'Unified or side-by-side diff, selectable for copying. Branches, remotes and stashes within reach. And secret scanning before every commit that stops you in time — deterministic rules, nothing sent anywhere.',
    'fb.l1': '<b>Automatic background fetch</b>: you always know how many commits you are ahead or behind.',
    'fb.l2': '<b>Hide the noise</b>: right-click the tree to hide something from <i>your</i> view — a per-repository filter that never touches disk and never reaches a commit.',
    'fb.l3': '<b>Workspaces</b>: open several projects and group them. Switching workspace switches everything else with it.',

    'bento.eyebrow': 'And also',
    'bento.title': 'Everything that normally<br>lives in <em class="ser">another</em> app',
    'b.db.h': 'Your databases, in the same window',
    'b.db.p': 'The query you need to check is one tab away from the migration you just wrote. Full tree, SQL console with history and <code>EXPLAIN</code>, and row editing that stages locally: you see the exact statements before anything runs.',
    'b.db.t1': 'read-only', 'b.db.t2': 'SSH tunnel',
    'b.rem.h': 'The machines your code runs on',
    'b.rem.p': 'SSH sessions with your keys and hosts imported from your <code>~/.ssh/config</code> rather than typed in again. Files both ways over SFTP and FTP, port forwarding for the database behind the bastion, and cloud storage in the same tree.',
    'b.dbml.h': 'Schemas you write, draw and try out',
    'b.dbml.p': 'A schema in DBML is drawn while you type — and the drawing is not read-only. Rename a table, add a column or draw a relationship from the canvas: every gesture is applied as a <b>text edit</b>, so your comments, blank lines and formatting survive untouched. The <b>Data</b> surface builds an ephemeral SQLite from the diagram to fill it by hand and query it with no guard rails, because here <code>DELETE FROM users</code> is a thing you write every day.',
    'b.note.h': 'Notes, next to the code',
    'b.note.p': 'Markdown notebooks for the decision, the runbook and the postmortem, with templates and an AI panel that drafts without leaving the page. Per workspace, so a client’s notes don’t turn up in another client’s window.',
    'b.key.h': 'Llavero',
    'b.key.p': 'One master password stretched with Argon2id unwrapping the key that seals every item with AES-256-GCM. <b>No stored verifier</b>: a wrong password fails to unwrap the key, and that <i>is</i> the check.',
    'b.bk.h': 'Backups you can actually restore',
    'b.bk.p': 'Encrypted with the passphrase you choose and everything in one file. On a schedule and on exit, keeping the number of copies you ask for, where you say: a folder, Google Drive or OneDrive.',
    'b.ag.h': 'Agents that keep working while you don’t',
    'b.ag.p': 'An agent is a role with its own engine: a name, a model and instructions, written once. Hand it a goal and a repository, then walk away: it keeps running while you switch views, and waits at <b>“Your turn”</b> when it needs an answer from you. If a step fails the chain <b>stops</b>: retry, skip or abort. It never reruns on its own.',
    'b.story.h': 'From a document to a backlog — and to the code',
    'b.story.p': 'Point it at a wiki page, a folder of Markdown or pasted text and get user stories back with acceptance criteria in <b>Gherkin</b> ready for Cucumber. Every story is scored <b>locally, with no model involved</b> — a check worth trusting precisely because it is the same every time.',
    'b.story.l1': '<b>Verify against your code</b>: each criterion gets a verdict backed by the file and line that proves it.',
    'b.story.l2': '<b>Publish</b> to Azure Boards, Jira or monday.com — and nothing reaches the board on its own.',
    'b.story.l3': '<b>Build</b>: one story, from one to many repositories, in two phases with a human gate between them.',
    'b.mob.h': 'Your phone, as a second screen',
    'b.mob.p': 'Turn on the remote-control server, put the six digits into your phone’s browser and that’s it. No app store, no account, nothing published to the internet. Every device is revocable one by one from the desktop.',
    'b.win.h': 'Windows of their own',
    'b.win.p': 'Any app in the rail can be pulled out into its own window. <b>Detaching moves, it never duplicates</b>: there is no way to ask for two windows on the same thing, so you never end up with two editors on one file overwriting each other.',
    'b.you.h': 'And make it yours',
    'b.you.p': 'Light, dark or system theme with the accent colour you want. Interface in Spanish and English. A command palette, rebindable shortcuts, the rail order in your hands and a guided tour you can leave and pick up again.',

    'reel.eyebrow': 'In motion', 'reel.title': 'Watch it <em class="ser">working</em>',

    'vow.eyebrow': 'Security and privacy',
    'vow.title': 'It’s a desktop app.<br>The only server is the one <em class="ser">you</em> switch on.',
    'vow.k1': 'No account', 'vow.h1': 'And no telemetry',
    'vow.p1': 'There is nothing to sign up for. The remote-control server is the one you switch on yourself, on your own network, and switch off again.',
    'vow.k2': 'System keychain', 'vow.h2': 'Your tokens, never in plain text',
    'vow.p2': 'PATs and database passwords go to the operating system’s keychain, not into the app’s own database.',
    'vow.k3': 'Per user', 'vow.h3': 'Data in your own account',
    'vow.p3': 'The database, the settings and the vault live in your own account’s application data, where another account on the same machine cannot read them.',
    'vow.k4': 'Offline', 'vow.h4': 'Two complete paths',
    'vow.p4': 'Cline over Ollama for the conversational work and the bundled engine for autocomplete. Your code never leaves the machine.',
    'vow.k5': 'Before the commit', 'vow.h5': 'Secret scanning',
    'vow.p5': 'It catches API keys, tokens and private keys and stops you in time. Deterministic rules, nothing sent anywhere.',
    'vow.k6': 'Yours', 'vow.h6': 'Repos and backups untouched',
    'vow.p6': 'The app never deletes them: not on a reset, not on uninstall. They live in your own folder and stay there.',

    'get.eyebrow': 'Download', 'get.title': 'Open it and <em class="ser">go</em>',
    'get.lede': 'Download the installer, open it and you are done. The app updates itself when a new version lands, and it can stay alive in the tray so your terminals and AI tasks don’t die when you close the window.',
    'get.win': 'Windows · Installer', 'get.mac': 'macOS · Apple Silicon',
    'get.k1': 'Version', 'get.k2': 'Windows', 'get.v2': '.exe or .msi · x64 · 10 and 11',
    'get.k3': 'macOS', 'get.v3': '.dmg · Apple Silicon (M1+)',
    'get.k4': 'Licence', 'get.v4': 'Source-available · free to use',
    'get.k5': 'Languages',
    'get.all': 'All versions and the notes for each release', 'get.lic': 'Licence',

    'foot.tag': 'Git, reviews and AI in a single flow. A native app for Windows and macOS.',
    'foot.h1': 'Product', 'foot.h2': 'Project', 'foot.h3': 'Documentation',
    'foot.contrib': 'Contribute',
    'foot.copy': '© 2026 Sebastián Rodríguez Zapata · Source-available, not open source',
    'foot.made': 'Built for anyone who wants Git, reviews and AI in a single flow'
  };

  /* deck captions live here in both languages */
  var CAPS = {
    es: [
      'Grafo de commits — ramas, refs y el diff a un clic.',
      'El editor integrado — Monaco, LSP y la terminal en el mismo panel.',
      'Pipelines — la ejecución como cascada, con sus logs.',
      'API client — seis protocolos, colecciones y entornos.',
      'Diagramas — el esquema como texto, dibujado mientras escribes.'
    ],
    en: [
      'Commit graph — branches, refs and the diff one click away.',
      'The built-in editor — Monaco, LSP and the terminal in one panel.',
      'Pipelines — the run as a waterfall, logs included.',
      'API client — six protocols, collections and environments.',
      'Diagrams — a schema as text, drawn as you type.'
    ]
  };

  /* ------------------------------------------------------------------ */
  /* 2. Helpers                                                          */
  /* ------------------------------------------------------------------ */
  var $  = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var clamp = function (n, a, b) { return n < a ? a : n > b ? b : n; };
  var motionMQ = window.matchMedia('(prefers-reduced-motion: reduce)');
  /* live, not latched: a reader who turns motion down while the page is open
     should get the calm version without reloading */
  var REDUCED = motionMQ.matches;

  /* progress of an element through the viewport, 0 → 1 */
  function progressOf(el, startAt, endAt) {
    var r = el.getBoundingClientRect();
    var vh = window.innerHeight;
    var start = vh * (startAt === undefined ? 0.92 : startAt);
    var end   = vh * (endAt   === undefined ? 0.35 : endAt);
    return clamp((start - r.top) / (start - end), 0, 1);
  }

  /* ------------------------------------------------------------------ */
  /* 3. Language                                                         */
  /* ------------------------------------------------------------------ */
  var ES = {};           /* filled from the DOM on first run */
  var lang = 'es';

  function captureSpanish() {
    $$('[data-i18n]').forEach(function (el) {
      ES[el.dataset.i18n] = el.textContent;
    });
    $$('[data-i18n-html]').forEach(function (el) {
      ES[el.dataset.i18nHtml] = el.innerHTML;
    });
  }

  function applyLang(next) {
    lang = next;
    var dict = next === 'en' ? EN : ES;
    $$('[data-i18n]').forEach(function (el) {
      var v = dict[el.dataset.i18n];
      if (v != null) el.textContent = v;
    });
    $$('[data-i18n-html]').forEach(function (el) {
      var v = dict[el.dataset.i18nHtml];
      if (v != null) el.innerHTML = v;
    });
    document.documentElement.lang = next;
    $$('.lang button').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.lang === next));
    });
    try { localStorage.setItem('cf-lang', next); } catch (e) {}
    paintRelease();                 /* the pill holds a [data-version] span */
    if (deckCap) deckCap.textContent = CAPS[next][deckActive] || '';
  }

  /* ------------------------------------------------------------------ */
  /* 4. Release lookup                                                   */
  /* ------------------------------------------------------------------ */
  var REPO = 'sorodriguezz/code-flow';
  var release = {
    version: '1.20.1',
    published: '2026-09-18',
    win: 'https://github.com/' + REPO + '/releases/download/v1.20.1/CodeFlow_1.20.1_x64-setup.exe',
    mac: 'https://github.com/' + REPO + '/releases/download/v1.20.1/CodeFlow_1.20.1_aarch64.dmg',
    winSize: 76439847,
    macSize: 84288448
  };

  function mb(bytes) { return bytes ? (bytes / 1048576).toFixed(1) + ' MB' : ''; }

  function paintRelease() {
    $$('[data-version]').forEach(function (el) { el.textContent = release.version; });
    var ld = document.getElementById('ld');
    if (ld) {
      try {
        var d = JSON.parse(ld.textContent);
        d.softwareVersion = release.version;
        d.downloadUrl = release.mac;
        ld.textContent = JSON.stringify(d);
      } catch (e) {}
    }
    $$('[data-published]').forEach(function (el) {
      try {
        el.textContent = new Date(release.published).toLocaleDateString(
          lang === 'en' ? 'en-GB' : 'es-ES', { year: 'numeric', month: 'short', day: 'numeric' });
      } catch (e) { el.textContent = release.published; }
    });
    $$('.dl').forEach(function (a) {
      var win = a.dataset.os === 'win';
      a.href = win ? release.win : release.mac;
      var meta = $('[data-dl-meta]', a);
      if (!meta) return;
      meta.textContent = win
        ? '.exe · x64 · ' + mb(release.winSize)
        : '.dmg · Apple Silicon · ' + mb(release.macSize);
    });
  }

  function fetchRelease() {
    if (!window.fetch) return;
    fetch('https://api.github.com/repos/' + REPO + '/releases/latest', {
      headers: { Accept: 'application/vnd.github+json' }
    })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function (d) {
        if (!d || !d.assets) return;
        var win = null, mac = null;
        d.assets.forEach(function (a) {
          var n = a.name || '';
          if (/\.sig$/.test(n)) return;
          if (/-setup\.exe$/i.test(n)) win = a;
          if (/aarch64\.dmg$/i.test(n)) mac = a;
        });
        release.version   = (d.tag_name || '').replace(/^v/, '') || release.version;
        release.published = d.published_at || release.published;
        if (win) { release.win = win.browser_download_url; release.winSize = win.size; }
        if (mac) { release.mac = mac.browser_download_url; release.macSize = mac.size; }
        paintRelease();
      })
      .catch(function () { /* the hardcoded fallback is already on screen */ });
  }

  /* highlight the card that matches the visitor's OS */
  function markPlatform() {
    var ua = navigator.userAgent || '';
    var plat = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    var isWin = /Win/i.test(plat) || /Windows/i.test(ua);
    var isMac = !isWin && (/Mac/i.test(plat) || /Mac OS X/i.test(ua));
    if (!isWin && !isMac) return;
    $$('.dl').forEach(function (a) {
      if ((a.dataset.os === 'win') === isWin) a.classList.add('is-yours');
    });
  }

  /* ------------------------------------------------------------------ */
  /* 5. Media slots — upgrade a screenshot to a video or gif if present  */
  /* ------------------------------------------------------------------ */
  function upgradeMedia(host) {
    var base = host.dataset.video;
    if (!base) return;
    var img = $('img', host);

    var v = document.createElement('video');
    v.muted = true; v.loop = true; v.autoplay = true; v.playsInline = true;
    v.setAttribute('playsinline', ''); v.setAttribute('muted', '');
    v.setAttribute('aria-hidden', 'true');
    v.preload = 'metadata';
    if (img) v.poster = img.currentSrc || img.src;

    ['webm', 'mp4'].forEach(function (ext) {
      var s = document.createElement('source');
      s.src = base + '.' + ext;
      s.type = 'video/' + ext;
      v.appendChild(s);
    });

    v.addEventListener('loadeddata', function () {
      host.classList.add('has-video');
      if (img) img.style.visibility = 'hidden';
      var p = v.play(); if (p && p.catch) p.catch(function () {});
    }, { once: true });

    /* every source failed → try a gif, then give up quietly */
    v.addEventListener('error', function () {
      v.remove();
      if (!img) return;
      var probe = new Image();
      probe.onload = function () { img.src = probe.src; host.classList.add('has-video'); };
      probe.src = base + '.gif';
    }, { once: true });

    host.appendChild(v);
  }

  /* ------------------------------------------------------------------ */
  /* 6. Scroll-driven pieces                                             */
  /* ------------------------------------------------------------------ */
  var deckItems = [], deckSteps = [], railIcons = [], railPip = null;
  var deckCap = null, deckActive = 0;
  var pending = [];

  /* reveal anything that has reached the viewport, or that we have already
     scrolled past — the list shrinks as elements graduate */
  function sweepReveals() {
    if (!pending.length) return;
    var vh = window.innerHeight;
    pending = pending.filter(function (el) {
      var r = el.getBoundingClientRect();
      if (r.top < vh * 0.92) { el.classList.add('is-in'); return false; }
      return true;
    });
  }

  function setDeck(i) {
    if (i === deckActive) return;
    deckActive = i;
    deckItems.forEach(function (d, n) { d.classList.toggle('is-active', n === i); });
    deckSteps.forEach(function (s, n) { s.classList.toggle('is-active', n === i); });
    railIcons.forEach(function (r) {
      r.classList.toggle('is-active', Number(r.dataset.rail) === i);
    });
    if (railPip && railIcons[i]) railPip.style.transform = 'translateY(' + railIcons[i].offsetTop + 'px)';
    if (deckCap) deckCap.textContent = CAPS[lang][i] || '';
  }

  var engineRows = [], engineSteps = [];
  function setEngine(i) {
    engineSteps.forEach(function (s, n) { s.classList.toggle('is-active', n === i); });
    /* four steps drive six rows: reveal them progressively, all on by the last */
    var upTo = [0, 2, 4, 5][i];
    engineRows.forEach(function (r, n) { r.classList.toggle('is-on', n <= upTo); });
  }

  /* a stepped section: whichever step is nearest the reading line wins */
  function activeStep(steps) {
    var line = window.innerHeight * 0.48;
    var best = 0, bestD = Infinity;
    steps.forEach(function (s, i) {
      var r = s.getBoundingClientRect();
      var d = Math.abs(r.top + r.height / 2 - line);
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  }

  /* ------------------------------------------------------------------ */
  /* 7. Boot                                                             */
  /* ------------------------------------------------------------------ */
  function boot() {
    captureSpanish();

    /* media slots are a working aid: on the live site they stay hidden */
    if (location.protocol === 'file:' ||
        /^(localhost|127\.|\[?::1)/.test(location.hostname) ||
        location.search.indexOf('slots') > -1) {
      document.body.classList.add('show-slots');
    }

    /* language */
    var saved = null;
    try { saved = localStorage.getItem('cf-lang'); } catch (e) {}
    if (!saved && (navigator.language || '').slice(0, 2) !== 'es') saved = 'en';
    if (saved === 'en') applyLang('en'); else applyLang('es');

    $$('.lang button').forEach(function (b) {
      b.addEventListener('click', function () { applyLang(b.dataset.lang); });
    });

    paintRelease();
    markPlatform();
    fetchRelease();

    /* seamless marquee: duplicate the run so -50% lands on a copy */
    var mq = $('#marquee');
    if (mq) mq.innerHTML += mq.innerHTML;

    /* media upgrades */
    $$('[data-video]').forEach(function (h) { if (!h.classList.contains('reel')) upgradeMedia(h); });

    /* nav */
    var nav = $('#nav'), burger = $('#burger'), sheet = $('#sheet');
    if (burger && sheet) {
      burger.addEventListener('click', function () {
        var open = sheet.classList.toggle('is-open');
        burger.setAttribute('aria-expanded', String(open));
        burger.innerHTML = '<svg aria-hidden="true"><use href="#' + (open ? 'i-close' : 'i-menu') + '"/></svg>';
      });
      $$('a', sheet).forEach(function (a) {
        a.addEventListener('click', function () {
          sheet.classList.remove('is-open');
          burger.setAttribute('aria-expanded', 'false');
          burger.innerHTML = '<svg aria-hidden="true"><use href="#i-menu"/></svg>';
        });
      });
    }

    /* reveal on scroll — a sweep, not an observer: an IntersectionObserver
       can drop an entry during a fast scroll, and a missed entry means that
       block stays at opacity 0 forever. This cannot miss. */
    pending = $$('[data-reveal]');
    sweepReveals();

    if ('IntersectionObserver' in window) {
      /* counters */
      var co = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (!e.isIntersecting) return;
          co.unobserve(e.target);
          var el = e.target, to = Number(el.dataset.count) || 0;
          if (REDUCED) { el.textContent = String(to); return; }
          var t0 = performance.now(), dur = 900;
          (function tick(now) {
            var p = clamp((now - t0) / dur, 0, 1);
            el.textContent = String(Math.round(to * (1 - Math.pow(1 - p, 3))));
            if (p < 1) requestAnimationFrame(tick);
          })(t0);
        });
      }, { threshold: 0.5 });
      $$('[data-count]').forEach(function (el) { co.observe(el); });
    } else {
      $$('[data-count]').forEach(function (el) { el.textContent = el.dataset.count; });
    }

    /* act I */
    deckItems = $$('#act1-deck .deck__item');
    deckSteps = $$('#act1-steps .step');
    railIcons = $$('.rail__i');
    railPip   = $('#railPip');
    deckCap   = $('#act1-cap');
    if (railPip && railIcons[0]) railPip.style.transform = 'translateY(' + railIcons[0].offsetTop + 'px)';

    /* act II */
    engineRows  = $$('#engineCard .erow');
    engineSteps = $$('#act2-steps .step');

    /* act III — measure the flow paths once */
    var flows = $$('#pipe .pipe__flow');
    flows.forEach(function (p) {
      var len = p.getTotalLength ? p.getTotalLength() : 400;
      p.style.setProperty('--len', len);
      p.style.strokeDasharray = len;
      p.style.strokeDashoffset = len;
    });
    var nodes = $$('#pipe .pipe__node');
    var findings = $$('#findings .finding');

    /* horizontal rail */
    var hs = $('.hs'), hsTrack = $('#hsTrack'), hsBar = $('#hsBar'), hsCount = $('#hsCount');
    var hsRange = 0;
    var pinnable = window.matchMedia('(min-width: 861px)');

    function measureHs() {
      if (!hs || !hsTrack) return;
      if (!pinnable.matches || REDUCED) {
        hs.style.height = '';
        hsTrack.style.transform = '';
        hsRange = 0;
        return;
      }
      hsRange = Math.max(0, hsTrack.scrollWidth - window.innerWidth);
      hs.style.height = (window.innerHeight + hsRange) + 'px';
    }

    /* the pinned hero window flattens as you scroll past it */
    var heroWindow = $('#heroWindow');
    var spotlight = $('#spotlight');
    var progressBar = $('#progress');
    var pipe = $('#pipe');
    var download = $('#descargar');

    function onScroll() {
      var y = window.pageYOffset || document.documentElement.scrollTop;

      /* progress bar */
      if (progressBar) {
        var max = document.documentElement.scrollHeight - window.innerHeight;
        progressBar.style.transform = 'scaleX(' + (max > 0 ? y / max : 0) + ')';
      }

      /* nav */
      if (nav) {
        nav.classList.toggle('is-stuck', y > 12);
        if (download) {
          var dr = download.getBoundingClientRect();
          nav.classList.toggle('at-download', dr.top < window.innerHeight * 0.7 && dr.bottom > 0);
        }
      }

      if (!REDUCED) {
        /* hero window */
        if (heroWindow) {
          var p = clamp(y / (window.innerHeight * 0.85), 0, 1);
          heroWindow.style.setProperty('--tilt', (11 - 11 * p).toFixed(2) + 'deg');
          heroWindow.style.setProperty('--sc', (0.965 + 0.035 * p).toFixed(4));
        }

        /* horizontal rail */
        if (hsRange > 0 && hs && hsTrack) {
          var top = hs.offsetTop;
          var pr = clamp((y - top) / (hs.offsetHeight - window.innerHeight), 0, 1);
          hsTrack.style.transform = 'translate3d(' + (-pr * hsRange).toFixed(1) + 'px,0,0)';
          if (hsBar) hsBar.style.width = (pr * 100).toFixed(1) + '%';
          if (hsCount) {
            var n = Math.min(15, Math.floor(pr * 14) + 1);
            hsCount.textContent = (n < 10 ? '0' : '') + n + ' / 15';
          }
        }

        /* act III */
        if (pipe) {
          var pp = progressOf(pipe, 0.95, 0.3);
          flows.forEach(function (path, i) {
            var slot = i < 3 ? 0 : i < 6 ? 1 : 2;
            var a = [0.04, 0.24, 0.44][slot];
            var b = [0.26, 0.46, 0.56][slot];
            var f = clamp((pp - a) / (b - a), 0, 1);
            var len = parseFloat(path.style.getPropertyValue('--len')) || 400;
            path.style.strokeDashoffset = (len * (1 - f)).toFixed(1);
          });
          nodes.forEach(function (n) {
            var stage = Number(n.dataset.node);
            n.classList.toggle('is-on', pp >= [0, 0.2, 0.42, 0.55][stage]);
          });
          findings.forEach(function (f, i) {
            f.classList.toggle('is-on', pp >= 0.62 + i * 0.07);
          });
        }
      }

      sweepReveals();

      /* stepped acts */
      if (deckSteps.length) setDeck(activeStep(deckSteps));
      if (engineSteps.length) setEngine(activeStep(engineSteps));
    }

    var ticking = false;
    function schedule() {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () { ticking = false; onScroll(); });
    }

    /* a backgrounded tab stops firing rAF; without this the `ticking` latch
       could stay raised and the handler would never run again on return */
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) { ticking = false; onScroll(); }
    });

    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', function () { measureHs(); schedule(); }, { passive: true });
    if (pinnable.addEventListener) pinnable.addEventListener('change', function () { measureHs(); schedule(); });
    if (motionMQ.addEventListener) motionMQ.addEventListener('change', function (e) {
      REDUCED = e.matches;
      measureHs();
      onScroll();
    });

    measureHs();
    onScroll();
    window.addEventListener('load', function () { measureHs(); onScroll(); });

    /* spotlight over the hero only */
    if (spotlight && !REDUCED && window.matchMedia('(pointer: fine)').matches) {
      var hero = $('.hero');
      window.addEventListener('pointermove', function (e) {
        var r = hero.getBoundingClientRect();
        var inside = e.clientY < r.bottom;
        spotlight.classList.toggle('is-on', inside);
        if (inside) {
          spotlight.style.transform =
            'translate3d(' + (e.clientX - 310) + 'px,' + (e.clientY - 310) + 'px,0)';
        }
      }, { passive: true });
    }

    /* the demo reel plays on demand, with controls */
    var reel = $('#reel'), reelPlay = $('#reelPlay');
    if (reel && reelPlay) {
      var probe = document.createElement('video');
      probe.preload = 'metadata';
      probe.muted = true;
      ['webm', 'mp4'].forEach(function (ext) {
        var s = document.createElement('source');
        s.src = 'media/demo.' + ext;
        s.type = 'video/' + ext;
        probe.appendChild(s);
      });
      probe.addEventListener('error', function () {
        /* no reel on disk yet — drop the affordance rather than dangle it */
        reelPlay.remove();
        var veil = $('.reel__veil', reel);
        if (veil) veil.style.background = 'linear-gradient(180deg,rgba(5,7,12,.1),rgba(5,7,12,.5))';
      }, { once: true });
      probe.addEventListener('loadedmetadata', function () {
        reelPlay.addEventListener('click', function () {
          probe.controls = true;
          probe.muted = false;
          probe.style.position = 'absolute';
          probe.style.inset = '0';
          probe.style.width = '100%';
          probe.style.height = '100%';
          probe.style.objectFit = 'cover';
          reel.appendChild(probe);
          reel.classList.add('is-playing', 'has-video');
          var pl = probe.play(); if (pl && pl.catch) pl.catch(function () {});
        });
      }, { once: true });
      probe.load();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
