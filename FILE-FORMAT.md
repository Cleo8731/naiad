# The Naiad file format

For anyone, person or AI agent, who edits a Naiad file by hand. A Naiad file is an
ordinary Mermaid flowchart saved as `.mmd` (or `.mermaid`), or a Markdown file (`.md`)
with the flowchart in a `mermaid` block
([A flowchart inside a Markdown file](#a-flowchart-inside-a-markdown-file)). It opens
unchanged in every Mermaid tool. Naiad adds one convention on top: **description
blocks**, written as Mermaid comments, which hold each node's full description.

The text file is the only copy of the flowchart. Naiad keeps no other data about it: no
positions, no second copy. The one file Naiad may write beside it holds highlights, which
are not part of the flowchart and are deleted when Naiad stops showing it
([Highlights](#highlights)).

## A whole file

```mermaid
flowchart TD
    collect[Collect data] --> clean{Clean?}
    clean -- yes --> train[Train model]
    clean -- no --> fix[Fix the data]
    fix --> clean

    subgraph review [Review]
        train --> evaluate([Evaluate])
        evaluate --> ship((Ship))
    end

    style ship fill:#d3f9d8,stroke:#2f9e44,color:#1c2026

%% @collect
%% Pull the raw exports from the warehouse.
%% .
%% Descriptions are **Markdown**: lists, `code` and links all work.
%% - one file per day
%% - never edited by hand

%% @clean
%% Check for nulls and duplicates. Rows that fail go back to *Fix the data*.
```

## Titles

A node's **title** is its Mermaid label: `collect[Collect data]` has the id `collect` and
the title `Collect data`. The chart shows only the title. A node with no label
(`collect`) shows its id.

Keep titles short; put everything else in the description.

A title that holds parentheses, brackets, braces or a double quote is written in double
quotes, in any shape: `id["Title with (punctuation)"]`, `id{"Sure (really)?"}`. Other
punctuation needs no quotes.

The word `end` in lower case cannot be a node's id: Mermaid reads it as the end of a
group.

## Description blocks

A node's **description** is the text shown under its title in the sidebar when the node
is clicked. It is Markdown.

```
%% @<node id>
%% <first line of the description>
%% <next line>
```

Rules:

1. The block starts with a line holding only `%% @` and the node's id, exactly as the id
   is written in the flowchart (`%% @collect`).
2. Every following line that starts with `%%` belongs to the description. One space
   after `%%` is dropped; the rest of the line is the text, spaces at its end included
   (two make a Markdown line break). The sidebar shows each
   line as a line of its own, so a paragraph is written as one line, however long.
3. The block ends at the first line that is not a `%%` comment (an empty line ends it),
   or at the next `%% @id` line.
4. **An empty line inside a description is written `%% .`** (two percent signs, a space,
   a full stop). Never write a line holding only `%%`: Mermaid 12 does not read a bare
   `%%` as a comment; it reads it as a node named `%%`. Naiad tolerates a bare `%%` when
   it reads a file, warns about it, and offers a one-click fix. A line runs to its line
   break, LF, CR or CRLF: a U+2028 or U+2029 after `%%` does not end it, so `%%` and the
   text after it on that line are one comment. In the front matter a `%%` line is YAML
   (point 9), and Mermaid refuses a bare one there; Naiad shows Mermaid's message.
5. A description line whose whole text is `.` or `@something`, with or without spaces
   in front, is written with a backslash in front (`%% \.`, `%% \@something`,
   `%% \    @something`), so it is not taken for an empty line or for the start of
   another block.
6. A block may sit anywhere a comment may: on its own lines, at any indent. Naiad adds
   new blocks at the end of the file, after every line already there (blank lines
   too), with one empty line before the block unless the file already ends with one.
7. If two blocks name the same id, the first one is used.
8. A block whose id matches no node is kept as it is and shown nowhere, and Naiad never
   gives its id to a node or group it adds.
9. A `%%` comment that follows no `%% @id` line is an ordinary comment; Naiad leaves it
   alone. `%%{ ... }%%` directives are not description lines. Nor is a `%%` line inside
   the front matter: Mermaid reads it as part of that YAML, not as a comment, and Naiad
   leaves it alone. The front matter is found as Mermaid finds it: the very first line
   of the flowchart is `---`, and it runs to the next line that is `---` after exactly
   the same spaces as the first (none, or any spaces but a line break) and has a line
   after it. An indented `---` inside a YAML text ends nothing.
10. **`%%{` inside a description line is written `%%\{`.** Mermaid reads `%%{` anywhere
    in the file, comment lines included, as a directive that sets the chart's settings
    (its theme, for example). Where backslashes already stand between `%%` and `{`, one
    more is written (`%%\{` is written `%%\\{`). Reading takes one backslash off, so
    `%% Use %%\{init}%%` is the description "Use %%{init}%%".

A comment must be on a line of its own. Mermaid 12 rejects a comment after a statement
on the same line (`a --> b %% note` is a syntax error). A `%%` inside a title or a
label is part of its text, quoted or not (`A["50%% off"]`, `a -->|50%% off| b`): in the
middle of a line Mermaid reads `%%` as text. So is one in a group's title
(`subgraph s ["Sales %% growth"]`), in a `click` line's link or tooltip, and on the
lines of a title in brackets written over several lines. There, and inside
`accDescr { ... }`, a line holding only `%%` is part of the text: Naiad neither warns
about it nor changes it, and no edit is made that would change an accessible title or
description.

## A flowchart inside a Markdown file

Naiad also opens a Markdown file (`.md`, `.markdown`) and works on a flowchart kept in
it as a fenced block marked `mermaid`, the form GitHub and most Markdown tools draw in
place. This guide calls it the **flowchart block**:

````markdown
# Pipeline

Some text.

```mermaid
flowchart TD
    collect[Collect data] --> clean{Clean?}

%% @collect
%% Pull the raw exports from the warehouse.
```

More text.
````

- Everything said above holds inside the flowchart block: titles, description blocks,
  `%% .`. Description blocks go inside the flowchart block, before its closing line, so
  it stays one valid Mermaid flowchart and still draws on GitHub.
- Naiad changes only lines between the flowchart block's opening and closing lines.
  Every other line of the Markdown file stays byte for byte as it was. Before saving,
  Naiad reads its own result back and refuses to save if the flowchart block would no
  longer be found whole.
- The text pane shows the flowchart's text, not the Markdown around it.
- A flowchart block is opened with three or more backticks or tildes followed by
  `mermaid`, and closed by a line of the same character, at least as many of them.
  Fenced blocks in other languages, and `mermaid` blocks that are not flowcharts (their
  first line is not `flowchart` or `graph`), are left alone. A flowchart block inside a
  quote (`>`) is not found, nor is a fence inside YAML front matter at the top of the
  file (from a first line of `---` to the next `---` or `...`).
- A file with several flowchart blocks shows one at a time; a list in the toolbar
  switches between them.
- A flowchart block may be indented, for example inside a list. As in Markdown, its
  opening and closing lines are indented at most three spaces, or, inside a list item,
  at most three spaces past the start of the item's text; a fence indented further is
  an indented code sample and is left alone. A line that looks like a list item but
  stands inside another fenced block, or in an indented code sample, starts no list.
  The fence stands in the item only if every line between them does: a line indented
  less than the item's text ends the item, unless it goes on with a paragraph above
  it. Right under paragraph text, only a bullet (`-`, `+`, `*`) or a `1.` or `1)` with
  text after it starts a new item. Where Naiad cannot tell whether the item ended, it
  does not find the block, so a code sample is never taken for a flowchart. A fenced
  block in a list item also ends with the item: a line in it indented less than the
  item's text (blank lines aside) ends both, and the block then has no closing line.
  Every line of the block must then start with the same whitespace as its opening
  line (empty lines may be fully empty, or all carry that whitespace). If they do
  not, or the closing line is missing, Naiad shows the flowchart but does not change
  it.
- A line that would close the flowchart block (three or more backticks alone on a line,
  when it was opened with backticks) cannot be part of a flowchart in a Markdown file.
  Naiad does not save such a text.

## What Naiad changes in a file, and what it never does

- An edit made in the chart or the sidebar changes only the lines that edit needs. Every
  other line, its spacing and its comments stay byte for byte as they were.
- An arrow written for several pairs at once (`a & b --> c`) is written out one pair per
  line when an edit changes one of its pairs. An arrow's own id (`a & b e1@--> c`) stays
  on the one pair Mermaid gives it to, the last node before the arrow and the first
  after it (`b e1@--> c`). A `linkStyle` line follows its arrow when arrows move, and a
  Markdown label (`` "`...`" ``) stays Markdown.
- Every line keeps its own line ending (LF, CRLF or a lone CR), so a file that mixes
  them stays mixed. A line Naiad changes keeps the ending it had; a line it adds takes
  the ending of the line above it. A byte-order mark is kept.
- When an edit removes a line that stood between a description block and a `%%` comment
  under it (ungrouping removes the `subgraph` and `end` lines; deleting a node removes
  its line), Naiad puts an empty line where it was, so the comment does not join the
  description (rule 3 of [Description blocks](#description-blocks)).
- Before an edit is applied, Naiad asks Mermaid's own parser what the flowchart means
  before and after. If the result does not parse, or differs from the edit that was
  asked for, the edit is refused and the file is not touched. The same goes for the
  descriptions: an edit that would change any description other than the one being
  written, or the one of the node being deleted, is refused. So is an edit that would
  add, change or remove a `%%{ ... }%%` directive anywhere in the flowchart (one in a
  title, or one written by hand inside a description), since Mermaid takes the chart's
  settings from it, and an edit that would change the front matter in any way.
- A line Naiad's scanner cannot read is left alone, and chart edits are refused (with a
  message naming the line) until it is fixed in the text pane. Typing in the text pane
  always works.
- The file is saved only while it is a valid Mermaid flowchart (Ctrl+S saves it anyway).
  Text just typed in the text pane is part of every save, Ctrl+S, reload and Undo.
  Closing Naiad or opening another file saves it first, with what is typed while that
  save runs; while it holds a change that cannot be saved, it asks first, and so does showing another flowchart after a change on disk took an unsaved
  edit's place (Undo holds that edit only while the flowchart stays shown). A
  description being written in the sidebar is written to the file when the sidebar
  turns to another item or closes, and before Naiad closes or shows another flowchart
  or file, with any text typed while it is written; if it cannot be written (the text
  pane holds an error, say), Naiad asks before it is lost, and unless the person lets
  it go, it goes back into its box. Edit pressed again while Done writes it shows the
  text being written, and if the write fails the text stays in the box, with whatever
  was typed into it meanwhile. Cancel (Esc) drops it.
- A save writes the whole text to a new temporary file beside it, named
  `.naiad-<number>-<number>.tmp`, then renames that over the file, so the file is
  never left half written. The temporary name is always one no file has yet: a file
  of yours is never overwritten by it, and two saves at once never share one.
- Naiad opens only whole files. On Windows a path with a `:` inside a name
  (`notes.txt:flow.mmd`) names a hidden part, a stream, of another file: it is refused
  whatever its ending.
- When the file changes on disk (an agent or another editor saved it), Naiad reloads
  it. If Naiad holds an unsaved edit at that moment, the version on disk wins and the
  unsaved edit stays in Undo. A save checks, just before it renames, that the file
  still holds exactly what Naiad last read; if it changed in between, the save is
  refused, the version on disk is taken in the same way, and the edit stays in Undo.
  Saves that reach one Naiad program at once (two pages of `naiad serve` on one file,
  say) are checked and renamed one after the other, so only the first of those made
  from the same reading is done.
  An Undo that would take back a change made on disk asks first, since it saves the
  earlier version over that change; Redo brings the change back. After a change on
  disk Naiad saves nothing until the file has been quiet for a second, so a program
  still writing it finishes first. Naiad knows the file by its name with letter case
  set aside, as Windows does: opened by a path typed in other letters, or renamed to
  other letters only (`flow.mmd` to `Flow.mmd`), it is still the file, and its changes
  are still seen. A save keeps the name the file has on disk, whatever letters the path
  was typed in.
  In a Markdown file, a change on disk that leaves the
  flowchart block as it was (only the text around it changed) is taken in without
  touching the flowchart or an unsaved edit to it. If Naiad cannot tell for certain
  which flowchart block it was showing (the block was removed, or it changed while
  other Mermaid blocks were added, removed or changed), it changes nothing more in the
  file until it can tell again (the block is back, unchanged) or the file is opened
  again. When another block now holds the same text (a copy written beside it), the
  one shown is the one whose lines around it, above and below both, read more as they
  did than the other's; if the lines around the two do not tell them apart, or the
  lines above point to one and the lines below to the other, Naiad cannot tell. Nor can
  it when another block sits where the shown block was (the same lines above it, its
  heading say), whatever its text, even a copy of a third block's, and the shown
  block's text is now elsewhere: the shown block may have been changed in place and
  its old text kept as a copy. So too when the block holding the shown text now stands
  under other headings than the shown block did (any heading above it, not only the
  nearest, renamed, added or taken away; a heading underlined with `===` or `---`
  counts), whatever the lines below each say: the shown block may have been changed in
  place, with the text below it and its heading, and the old text kept with the copy.
- The checker's `fix` changes one thing only: a line holding nothing but `%%` becomes
  `%% .`, in place. A line inside front matter, or inside a quoted text that runs over
  several lines, is never changed: Mermaid reads it as part of that. (A double quote in
  an accessible title or description, `accTitle: A 5" screen`, opens no quoted text:
  Mermaid reads that line as plain text.) It asks Mermaid's parser what the flowchart
  means before and after, and changes nothing when Mermaid cannot read the flowchart,
  when the meaning or a description would differ, or when the file changed while it
  was being checked. The checker's `check` never writes.
- Highlighting never touches the flowchart's file: highlights have a file of their own
  ([Highlights](#highlights)).
- All of this holds in Naiad's window and in the page that `naiad serve <file>` shows
  in a browser: they are the same program and follow the same rules.

## Highlights

A highlight marks a node, an arrow or a group for the person and an agent to point at:
several at once, shown in Naiad's window and in every page `naiad serve` shows of the
same file. Highlights are not part of the flowchart. They are kept in a small file of
their own, for `flow.mmd`:

```
.naiad/flow.mmd/highlights.txt
```

that is, a folder named `.naiad` in the flowchart's folder, and in it a folder named
exactly as the flowchart's file, its ending included. One item per line:

```
# working on the cleaning step
collect
clean
collect --> clean
```

- An item is a node's or a group's id, or an arrow written as its two ends,
  `from --> to` (the first arrow with those ends).
- Blank lines and lines starting with `#` are ignored, and so is a line that names
  nothing on the chart. In a Markdown file the items apply to the flowchart shown.
- A line ends at LF, CRLF or a lone CR. When Naiad changes the list, every line it
  writes ends in LF.
- In Naiad, the **Highlight** switch in the toolbar (key H) makes a click on an item
  highlight it, or take its highlight off, instead of selecting it. **Clear** takes
  every highlight off.
- Anyone may write the file: Naiad shows a change to it within a second, and need not
  be running when it is written.
- When Naiad changes the list it writes the whole file, through a temporary file and a
  rename as for a save, and keeps every line it was not asked to change. It writes only
  if the file still holds what it read for the change: if another view or an agent
  changed it meanwhile, Naiad reads it again and switches the item in that. A file Naiad cannot read
  (one that is not UTF-8) is never replaced or deleted: switching a highlight or Clear
  then shows the error and writes nothing, and closing the last view leaves it. When
  the last item is taken
  off it deletes the file, and the folders it leaves empty. When it makes the `.naiad`
  folder, or finds one, it sets Windows' hidden mark on it, as git does for `.git`.
- Naiad never follows a link there. If `.naiad`, the flowchart's folder in it or
  `highlights.txt` is a symbolic link or a junction, highlighting shows an error and
  reads, writes and deletes nothing, the link included. On Windows, while Naiad reads,
  writes or deletes the highlights file, it holds `.naiad` and the flowchart's folder
  open, so that neither can be deleted, renamed or swapped for a link meanwhile; and
  while it reads `highlights.txt` to show it, it holds that file open the same way.
- On Windows, when Naiad changes `highlights.txt`, it holds the file from its look
  (that it is UTF-8 and, for a switch, still what was read) to its change, so that no
  other program can write, rename or delete it in between. For that moment, a few
  milliseconds, another program's write to it fails, and so may its read: it can try
  again. To replace it, Naiad moves the old file aside under a temporary name, moves
  the new one in, then deletes the old one. If another program makes a file there in
  the moment between, as appending to the file does, Naiad keeps that file and the old
  one too, beside it under the temporary name, changes nothing, and says where the old
  text is.
- The file is deleted when the last Naiad view of the flowchart closes, and only if it
  still holds what Naiad last read or wrote of it: highlights an agent wrote after
  that are kept, to show at the next opening. The view is a window (closed, or showing
  another file), or the last page `naiad serve` shows of it (within half a minute of
  that page closing, and only if the file is still as it was when that page closed:
  highlights written in that half minute are kept).
  A page that only lost its connection, as when the computer sleeps, still counts as
  open: its highlights stay until it closes, or until `naiad serve` stops by itself,
  ten minutes after its last page went.
  Highlights written while no view was open, or left by a Naiad that was stopped by
  force, show at the next opening and go at the next closing.

## Mermaid syntax Naiad can edit from the chart

Reading: anything Mermaid's flowchart parser accepts is drawn, up to Mermaid's limit of
50,000 characters (front matter, directives, comments and descriptions not counted);
past it Mermaid draws only "Maximum text size in diagram exceeded".

Editing from the chart or sidebar works on these forms; lines in other forms are drawn
but must be edited as text:

- Header: `flowchart TD` or `graph LR` (directions TB, TD, BT, LR, RL).
- Nodes: `id`, `id[Title]`, `id["Title with (punctuation)"]`, and the shapes `(round)`,
  `([stadium])`, `[[subroutine]]`, `[(cylinder)]`, `((circle))`, `(((double circle)))`,
  `{diamond}`, `{{hexagon}}`, `[/lean right/]`, `[\lean left\]`, `[/trapezoid\]`,
  `[\inverted trapezoid/]`, `>flag]`, `(-ellipse-)`.
- Links: `-->`, `---`, `-.->`, `==>`, `<-->`, `--o`, `--x`, with a label as
  `-->|label|` or `-- label -->`; chains (`a --> b --> c`) and `&` lists
  (`a & b --> c`).
- Groups: `subgraph id [Title]` ... `end`, with an optional `direction LR` line inside.
- Styling: `style id fill:#...,stroke:#...,color:#...`.
- Inside a quoted title, a double quote is written `#quot;`.

An accessible title or description (`accTitle: text`, `accDescr: text`, `accDescr {`
... `}`) is plain text, never a node or an arrow, even when it reads like one
(`accTitle:::hot`). Write its text on the same line: Mermaid reads an `accTitle:` or
`accDescr:` with nothing after the colon as taking the next line that is not blank or
a comment for its text, and Naiad reads it the same way. A line holding only `%%` is
not a comment there (Description blocks, point 4), so it is the text. An `accDescr {`
runs to the first `}` Mermaid reads: Mermaid drops `%%{ ... }%%` directives and
comment lines before it reads, so a `}` in one of them ends nothing, and Naiad reads
it the same way.

## Checking a file from a terminal

Where Naiad is installed, a terminal can check a file without opening a window:

```
naiad check flow.mmd
naiad fix flow.mmd
```

- `naiad check` prints each place a file breaks this format, with its line number and
  how to put it right, and ends each file with the number of its problems, or
  `no problems`. It reads `.mmd`, `.mermaid` and every flowchart block of a `.md` or
  `.markdown` file, and takes several files at once. Its exit code is 0
  when there are no problems, 1 when there are, and 2 when a file could not be checked.
- It reports: text Mermaid's flowchart parser rejects; a line holding nothing but `%%`;
  a comment after a statement on the same line; a description block whose id matches
  no node or group; a second description block for one id; a line Naiad's scanner
  cannot read; a flowchart past Mermaid's limit of 50,000 characters. It reports
  nothing about style.
- `naiad fix` first puts right what cannot change the flowchart (see "What Naiad
  changes in a file"), then checks.
- On Windows the installer adds the `naiad` command to the user's PATH. A terminal that
  was open during the install does not know the command yet: open a new one, or run it
  by its full path, by default `%LOCALAPPDATA%\Naiad\bin\naiad.exe`.

## Advice for an agent editing a file

- After changing a file, run `naiad check` on it where Naiad is installed, and put
  right what it reports.
- Change only the lines your edit needs; do not reformat or reorder the rest.
- Give every node a short, stable id (letters, digits, `_`); the id ties a node to its
  description block. If you rename an id, rename its `%% @id` line too.
- Put long text in a description block, never in the title.
- Write each paragraph of a description as one line; do not wrap it.
- Write an empty description line as `%% .`.
- Leave an empty line between a description block and an ordinary `%%` comment under
  it; without one, the comment becomes part of the description.
- In a Markdown file, keep description blocks inside the flowchart block, and keep
  every line of an indented flowchart block at its indent.
- Naiad reloads the file as soon as you save it; nothing else needs doing.
- Write the whole file in one step. Naiad waits a second after a change on disk before
  it saves, so a second step that adds to the file within that second is taken in;
  one that comes later is added to whatever Naiad saved in between.
- To point the user at items, highlight them in the highlights file
  ([Highlights](#highlights)), never by changing the flowchart.
