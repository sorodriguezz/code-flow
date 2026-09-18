# Media slots

The landing page runs on the real screenshots in `../screenshots/`. Every one of
those frames is also a **slot**: drop a file with the matching name in this
folder and the page upgrades that screenshot to motion by itself. Nothing to
wire up, no HTML to edit.

## How the upgrade works

For a slot named `git-graph`, the page tries, in order:

1. `git-graph.webm`
2. `git-graph.mp4`
3. `git-graph.gif`

The first one that loads wins. Videos play muted, looped and inline, with the
screenshot as the poster, so there is no flash of empty space while they load.
If none of the three exist, the screenshot simply stays — which is why the site
works today with nothing in this folder.

## The slots

| File name | What it should show | Poster / fallback |
|---|---|---|
| `git-graph` | Scrolling the commit graph, opening a diff | `screenshots/graph.png` |
| `editor` | Typing with local autocomplete, ghost text appearing | `screenshots/editor.png` |
| `pipelines` | A run refreshing live, opening a job log | `screenshots/pipelines.png` |
| `api-client` | Sending a request, the response arriving | `screenshots/api-client.png` |
| `dbml` | Typing DBML and the diagram redrawing | `screenshots/diagrams.png` |
| `ai-providers` | The providers list detecting engines | `screenshots/ai-settings.png` |
| `git-changes` | Staging hunks, writing an AI commit message | `screenshots/changes.png` |
| `dbml-edit` | Renaming a table from the canvas, the text following | `screenshots/dbml.png` |
| `demo` | The full reel, 40–90 s, for the "En movimiento" section | `screenshots/windows.png` |

`demo` behaves differently from the rest: it does not autoplay. It keeps the
play button and starts with sound and controls when someone clicks it. If
`media/demo.*` is missing, the play button removes itself rather than dangling
over a still image.

## Recording tips

- **Record at 2560×1600 or larger**, then export at 1500 px wide to match the
  screenshots. Anything narrower looks soft next to them.
- **Loop-friendly length**: 6–12 s for the inline slots. Start and end on the
  same frame so the loop does not jump.
- **No cursor teleporting.** Move deliberately; a jump cut mid-gesture reads as
  a glitch at this size.
- **Keep it light.** These autoplay, so budget ~2–4 MB each. `webm` (VP9) is
  roughly half the size of the equivalent `mp4` — ship both and the browser
  takes the better one.

```bash
# a reasonable pair from one source recording
ffmpeg -i raw.mov -vf "scale=1500:-2,fps=30" -c:v libvpx-vp9 -crf 34 -b:v 0 -an git-graph.webm
ffmpeg -i raw.mov -vf "scale=1500:-2,fps=30" -c:v libx264 -crf 24 -pix_fmt yuv420p -an git-graph.mp4
```

## Seeing the slots while you work

The slot labels are hidden on the published site. They show up on `localhost`,
on a `file://` open, or on any URL with `?slots` appended — so
`https://sorodriguezz.github.io/code-flow/?slots` lists every slot still waiting
for a file.
