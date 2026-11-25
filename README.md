# Naiad

Naiad is a Windows desktop app that shows and changes a flowchart kept in one plain
Mermaid text file, for one person and the AI agents that work on the same file.

The chart shows each node's short title. Click a node and the sidebar shows its full
description, which the file keeps beside the node as Mermaid comments. With nothing
selected, the sidebar shows a description of the whole flowchart, kept the same way.
In other Mermaid tools a node shows only its label, so longer detail crowds the chart,
sits in comments the drawn chart never shows, or lives in a second document. With Naiad the file
stays the only copy, opens in any Mermaid tool, and you, an agent or Naiad can change
it.

- Naiad runs on Windows 11 (x64). It has not been tried on Windows 10, and there are no
  macOS or Linux builds.
- It opens Mermaid flowcharts (text that starts `flowchart` or `graph`) in `.mmd` and
  `.mermaid` files. It does not open a Markdown file, even one with a `mermaid` code
  block, or any other kind of Mermaid diagram.
- Mermaid places the boxes. You change titles, descriptions, shapes, colours, groups
  and arrows; a box cannot be dragged to a place of your choosing.
- Naiad is an early version (0.3), tested on one Windows 11 computer.

![A made-up help-desk flowchart in Naiad's light Coral colours: clicking a step shows its description, the chart is zoomed and scrolled, a step's title and shape are changed, and the Syntax pane shows the file's text](media/reading-and-editing.gif)

![A made-up newsroom flowchart in Naiad's dark Kelp colours: an agent writes a new decision into the file and the chart redraws at once, then a second file opens beside the first](media/working-with-an-agent.gif)

The orange border and label in the second recording mark the time the agent is
editing; the recording adds them, and Naiad does not show them. A script drives both
recordings. It moves the pointer, draws the open Shape list (the browser draws that
list where a recording cannot capture it), and stands in for the agent, writing the
decision "Cleared?" and the step "Hold the story" into `newsroom.mmd` while Naiad is
open. The flowcharts are made up. Both were recorded in the browser version
(`npm run dev`), which lacks the desktop window's minimize, maximize and close buttons.

## The file

A node's description is a run of Mermaid comments, lines that start `%%`, under a line
`%% @` followed by the node's id. Mermaid skips comments, so the file draws the same in
any Mermaid tool. Part of the first recording's file:

```text
flowchart TD
    sort{Seen it before?} -- no --> look(Reproduce the problem)

%% @look
%% Follow the customer's steps on a test account until the problem shows.
%% .
%% - Ask for a screenshot if the steps are unclear.
%% - Note the version and the browser.
```

Click **Reproduce the problem** and the sidebar shows the lines under `%% @look` as
Markdown: `%% .` is an empty line, so the two lines that start `-` are a list. A
description that starts `%% @flowchart` describes the whole flowchart. A complete file:
[examples/sample.mmd](examples/sample.mmd). The full rules, for people and for agents:
[FILE-FORMAT.md](FILE-FORMAT.md).

- Naiad reloads the file whenever it changes on disk, so a change an agent makes shows
  at once. If you have an edit not yet saved at that moment, the version on disk wins
  and your edit stays in Undo.
- A change made in Naiad rewrites only the lines it needs, and Mermaid's own parser
  checks it before it is applied.

## Install

Download the installer from the
[latest release](https://github.com/Cleo8731/naiad/releases/latest): under **Assets**,
the file ending in `_x64-setup.exe` (the two "Source code" files are for building it
yourself). Run it. The installer is not signed, so Windows may show "Windows protected
your PC": click **More info**, then **Run anyway**. To check the download first, run
`Get-FileHash` in PowerShell, followed by the installer's file name, and compare the
hash it prints with the SHA-256 on the release page.

It installs Naiad for your Windows user in `%LOCALAPPDATA%\Naiad` (about 5.9 MB),
without administrator rights. It registers Naiad for `.mmd` and `.mermaid` files, so a
double-click on a `.mmd` file opens it, and adds the `naiad` command to your PATH. Then
open a file with **Open a file**, or start one with **New flowchart**.

To update, run a newer release's installer: it installs over the old version. Naiad is
listed in Windows **Settings**, under **Apps**, **Installed apps**, where it can be
uninstalled; uninstalling has not been tried yet.

To make the installer yourself instead, see [Building from source](#building-from-source).

## Using it

Down the window's left edge, the rail holds **Recent files**, **Syntax**, **About**,
two switches (Mouse or Touchpad, and Edit or View), **Customize** and **Settings**. On
the chart, Undo and Redo sit at the top left, and a bar along the bottom holds **+**
(add a node), the direction button, **Fit** and **Highlight**.

| To do this | Do this |
|---|---|
| Open a file | **Open a file** on a blank tab, Ctrl+O there, a double-click on the file, or `naiad flow.mmd` |
| Read a description | Click a node; click empty space for the whole flowchart's description |
| Write a description | Click the node, then **Edit** beside **Description** in the sidebar, then **Done** |
| Add a node | **+** in the bar at the bottom of the chart, or double-click empty space |
| Rename a node | Double-click it, or select it and press Enter or F2 |
| Connect two nodes | Point at a node and drag the dot beside it onto another node |
| Change a shape, colour, group or arrow | Click it and use the sidebar |
| Delete | Select, then press Delete |
| Undo / redo | Ctrl+Z / Ctrl+Y |
| Zoom and move the chart | Mouse wheel or pinch to zoom, drag empty space to move; in Touchpad mode two fingers move it |
| Show an agent which parts you mean | **Highlight** (key H), then click them; the agent reads them from a small file beside the flowchart |
| Read or edit the Mermaid text | **Syntax** (`</>`) on the rail |
| Read without changing anything | Click the Edit or View switch on the rail to View mode |

Naiad saves the file by itself whenever it is a valid flowchart; Ctrl+S saves it at
once. Tabs and split view, the recent files, themes and fonts, settings, pane widths
and every other control: [USING.md](USING.md).

## From a terminal

```bash
naiad flow.mmd          # open the file in Naiad
naiad check flow.mmd    # report where the file breaks the format; no window opens
naiad fix flow.mmd      # make the one safe repair in the file, then check
naiad serve flow.mmd    # show the file in a browser on this computer; prints the address
naiad --version
```

A terminal that was open during the install does not know the command yet: open a new
one.

`naiad check` is made for agents and scripts: it checks both Mermaid's syntax and
Naiad's description rules, and prints each problem with its line and how to put it
right, or `flow.mmd: no problems`. Its exit code is 0 when there are no problems, 1
when there are, and 2 when a file could not be checked. `naiad fix` writes to the file:
it turns a line holding only `%%` into `%% .`, then checks. Details:
[Checking a file from a terminal](FILE-FORMAT.md#checking-a-file-from-a-terminal).

`naiad serve` is for an agent whose tool has a browser beside the conversation: it
shows the flowchart there, where you can also change it, with no separate window. The
command prints an address (`http://127.0.0.1:`, a port and a secret) and returns; open
the whole address, and leave it out of bug reports. The page at that address is Naiad
itself and saves by the same rules; Naiad's own window can be open on the same file at
the same time. The server behind it can be reached from this computer only, answers
only at the address it printed, refuses requests that come from other web pages, reads
and writes only the file it was started for and that file's highlights, and ends by
itself ten minutes after the page is closed.

## For AI agents

Any agent that can edit a text file can change a Naiad flowchart, and `naiad check`
tells it whether the result is right. The folder [skills/naiad](skills/naiad) is a
skill: instructions an agent loads when a task calls for a flowchart. It teaches the
agent the file format, has it check its work with `naiad check`, and has it show you
the result: in the browser beside the conversation where the agent's tool has one,
otherwise in Naiad's window.

To install the skill, copy the folder `skills/naiad` to the folder where your agent tool
reads skills: for Claude Code, `~/.claude/skills/naiad` (every project on your
computer) or `.claude/skills/naiad` inside a project (commit it and everyone working on
the project has it). The [skills](https://github.com/vercel-labs/skills) installer
knows where each agent tool keeps its skills. This command has not been tried with
Naiad's skill yet:

```bash
npx skills add Cleo8731/naiad
```

Then ask for a flowchart in your own words, for example: "Draw our order process as a
Naiad flowchart in `docs/orders.mmd`, with a description for each step."

### Keeping flowcharts up to date (optional)

A flowchart that describes a project goes stale when the project changes. To have
agents keep it true, add this section to the project's instruction file (`CLAUDE.md`,
`AGENTS.md` or its like), with one line for each flowchart:

```
## Naiad flowcharts
Keep these flowcharts true: when a change alters what one shows, update it in
the same change, following the naiad skill, and say so in your report.
- `docs/architecture.mmd`: the import pipeline
- `docs/release.mmd`: the release steps
```

The skill offers to add this for you when an agent creates a flowchart of the project.

## What Naiad reads and keeps

- Each file you open: read again whenever it changes on disk, and written only as
  [FILE-FORMAT.md](FILE-FORMAT.md#what-naiad-changes-in-a-file-and-what-it-never-does)
  describes.
- Highlights: `.naiad/<file name>/highlights.txt` in the flowchart's folder, with
  Windows' hidden mark on `.naiad`. The file, and the folders it leaves empty, are
  deleted when the last Naiad view of the flowchart closes.
- In your temporary folder, while they run: a small record of each open window
  (`naiad-views`), and the address of each `naiad serve` server (`naiad-serve`), so a
  second `naiad serve` on the same file prints the same address.
- In the window's own storage, kept by Windows' WebView2 in
  `%LOCALAPPDATA%\app.naiad.desktop`: whether the Syntax pane is shown, the width of
  each pane, whether View mode and **About** are on, Touchpad or Mouse mode once you
  choose one, the appearance, theme and Syntax font once you choose them, and whether
  **Remember opened files** is on once you turn it off or on.
- While **Remember opened files** is on, the full paths of the files open in the tabs,
  in their order, and which one is shown; while the window is split, also which tabs
  are in the second half, the tab each half shows, and the split's direction and
  divider. They are in the same storage (`src/app.ts`), written each time a tab opens,
  closes or is shown, and when the window closes.
- The full paths of the last 50 files you opened, for the recent files, in the same
  storage (`src/recent.ts`). While the list is shown, Naiad checks that each listed
  file is still there; it reads none of them until you click one.
- Naiad makes no network requests of its own. An image in a description that points to
  a web address is loaded from there when the description is shown, and a link in a
  description opens in your browser.

## Limits

- Some Mermaid forms are drawn but can be changed only as text; the forms the chart
  can change are listed in
  [FILE-FORMAT.md](FILE-FORMAT.md#mermaid-syntax-naiad-can-edit-from-the-chart).
- A double-click on a `.mmd` file while Naiad is open opens a second window, not a tab
  in the open one. To open it as a tab, click **+** at the end of that window's tabs,
then **Open a file**.

## Building from source

Made and tested on Windows 11 with Node.js 26.7 (npm 11.19), Rust 1.99.1
(`stable-x86_64-pc-windows-msvc`) and the Visual Studio 2022 C++ Build Tools (see the
[Tauri prerequisites](https://tauri.app/start/prerequisites/)).

```bash
git clone https://github.com/Cleo8731/naiad.git
cd naiad
npm install
npm test               # run the tests
npm run dev            # Naiad in a browser, without the desktop window
npm run tauri build    # the desktop app and its installer, in src-tauri/target/release/
```

`npm run dev` opens `examples/sample.mmd`, or the file named by the `NAIAD_FILE`
environment variable, and saves changes to it.

Report a problem or ask for a change in the
[issues](https://github.com/Cleo8731/naiad/issues).

Built with [Tauri](https://tauri.app) and [Mermaid](https://mermaid.js.org).

## Licence

[MIT](LICENSE). The bundled fonts, Lexend, Newsreader, JetBrains Mono, DM Mono and
Recursive, are under the [SIL Open Font License 1.1](src/fonts/OFL.txt). The window's
icons are from [Lucide](https://lucide.dev), under the ISC License, and those Lucide
took from Feather under the MIT License; both are in [src/icons/LICENSE](src/icons/LICENSE).
