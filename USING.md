# Using Naiad

Everything Naiad's window does, and what Naiad keeps on your computer, for reference.
The [README](README.md) has the everyday steps.

## The window

The tabs run across the top of the window, with the window's own minimize, maximize
and close buttons at their right end; drag the empty part of that row to move the
window, or double-click it to maximize the window. Down the window's left edge, the
rail holds **Recent files**, **Syntax** and **About** at the top, two switches in the
middle (Mouse or Touchpad, and Edit or View) with **Export** and **Print** under them,
and **Customize** and **Settings** at the bottom; pointing at a button shows its name,
and pointing at a switch shows both of its modes' names, the one in use under the knob.
On the chart, Undo and Redo sit at the top left, and a bar along the bottom holds **+**
(add a node), the direction button, **Fit** and **Highlight**; in View mode it holds
**Fit**, **Highlight** and **Walkthrough**.

A page from `naiad serve` (README, [Commands](README.md#commands)) shows
one file in the same way, without tabs, split view, the recent files list or
**Settings**.

## What to do

| To do this | Do this |
|---|---|
| Open several flowcharts | Each file opens in its own tab. The **+** at the end of the tabs opens a blank tab, which shows **Open a file** and **New flowchart** (Ctrl+O opens a file there too). A tab that holds a file is never replaced by another file. With many tabs open, the tabs grow narrower; past that, the mouse wheel scrolls them, and a button after them, showing how many are out of sight, lists every tab. A tab's × closes it at once, and asks first only when text not yet saved would be lost. Each tab keeps its own Undo history, selection and zoom; View mode, **Highlight** and Touchpad or Mouse mode apply to every tab. A file opened while Naiad is open, with a double-click or `naiad flow.mmd`, opens as a new tab in the Naiad window used last and brings that window forward; a file that a window already shows has its tab shown there instead |
| Use several windows | Drag a tab out past the window's edge and let go: a new window opens under the pointer, holding the tab with its Undo history, selection and view. Drag a tab onto another Naiad window's row of tabs to move it there; a line shows where it will land. A window's only tab can move only into another window, and the window it leaves then closes. Opening a file that another window shows brings that window forward with the file's tab shown |
| See two flowcharts at once | Drag a tab onto the chart, toward the side where it should open: that half lights up and names the tab, and letting go splits the window, side by side or one above the other. Each half has its own row of tabs, with its own **+** and list of every tab; a click on a tab shows it in its own half. Drag a tab onto the other half, or into the other row of tabs, to move it there. The half you last clicked is the active one: it has an accent line along its top, and the sidebar, Undo and the keys work on it. Drag the line between the halves to resize them (each at least 240 pixels across); double-click it for half and half. The **×** at the end of a row of tabs closes the split and moves its tabs to the other row; closing a half's last tab closes it too |
| Open a file you opened before | The **Recent files** button, at the top of the rail, shows the last 50 files you opened, newest first, in a pane beside the rail: 25 at first, and 25 more with each click on **View more**. Click one to open it: in the shown tab when that tab is blank, otherwise in a new tab after it; a file already open shows its tab. × takes it off the list and leaves the file where it is. A file that is no longer there stays on the list, greyed and marked "Not found", until you take it off. The list opens by itself on a blank tab and closes when a file opens; between two files' tabs it stays as you left it. The list and the Mermaid syntax are never shown together: opening the list closes the syntax, which stays closed until you open it again |
| Choose light or dark, the colours and the Syntax pane's font | **Customize**, a brush at the bottom of the rail, opens a window with three choices. **Appearance**: **Light**, **Dark** or **System**; System, the choice until you pick another, follows the light or dark setting of your computer. **Theme**: one of six sets of colours, each with a light and a dark form: Naiad Default (the choice until you pick another), Moonpool, Kelp, Water Lily, Glacier and Coral; the chart takes its colours too. **Syntax font**: JetBrains Mono (the choice until you pick another), DM Mono or Recursive Casual, each shown on a line of a flowchart. The window closes with its ×, Escape, or a click outside it. Naiad remembers each choice |
| Have your files open again when Naiad starts | **Settings**, a gear under **Customize**, opens a window with the switch **Remember opened files**, on until you turn it off. While it is on, Naiad opens again the files that were open when it last closed, each in its tab and in the same order, and shows the tab that was shown. A file that is no longer there is skipped, and a notice names it. A file you start Naiad on, with a double-click or `naiad flow.mmd`, opens after them and is shown. With several windows open when Naiad closes, each opens again in its place with its tabs; a window you close while another stays open is forgotten. Turning the switch off forgets the list at once |
| Read a description | Click a node |
| Write or change a description | Click the node, then **Edit** beside **Description**, at the end of the sidebar. The box grows with the text. Click anywhere outside the box, or press Escape or Ctrl+Enter, to finish: the text is written, and **Undo** takes it back |
| Read or write what the whole flowchart is about | Click empty space, so that nothing is selected: the sidebar shows the flowchart's description. A selected node, arrow or group covers it in the sidebar; close that and the description shows again. **About**, on the rail, hides or shows it, and Naiad remembers your choice |
| Make a pane wider or narrower | Drag the grip on the pane's edge that faces the chart. The recent files pane is 180 to 420 px wide (232 at first), the Syntax pane 220 to 640 px (330), and the sidebar 280 to 560 px (340). Naiad remembers each width |
| Add a node | **+** in the bar at the bottom of the chart, or double-click empty space |
| Rename | Double-click a node, press Enter / F2, or type in the title box at the top of the sidebar; there, Escape puts back the old title |
| Connect two nodes | Point at a node and drag the dot beside it to another node, or Shift-click the second node |
| Change an arrow | Click it: label, line, head, colour |
| Colour a node or a group | Click it, then a swatch in the sidebar's **Colour** row. The first swatch takes the node's own colour off: it is **No colour**, or, when a class in the file (`classDef`) colours the node, that colour, named by the class ("process, from its class"). The swatch marked is the colour shown |
| Put nodes in classes, and make and change classes | A class (`classDef` in the file) gives every node in it the same colour, border and, when it has one, shape, and names the kind of step they are. Click a node or a group, then pick a class under **Class**, near the top of the sidebar, or **None**; the row shows while the file defines a class. A node put in a class loses its own colour, so the class's shows, and takes the class's shape. **New class…** there asks for a name, a colour, a border (Normal, Thick, Dashed or Thick dashed) and a shape (**Any shape** leaves each node's shape as it is), and puts the node in the new class. A new node's sidebar holds the row too. With nothing selected, the flowchart's description lists the classes under **Classes**, one line each: a picture of its shape in its colour and border, its name, and how many nodes use it. Point at a line and click its three dots for its menu: **Colour**, **Border**, **Shape** (a shape is given to every node in the class), **Rename** and **Delete class** (its nodes stay, without its colour; Undo brings it back). Double-click a name to rename it there: Enter keeps the new name, Esc keeps the old one; the name changes everywhere the file uses it. **New class**, under the list, adds one |
| See where a node's arrows go | Rest the pointer on the node: its arrows and the nodes at their other ends stay, and the rest fades |
| See which way a long arrow goes | Look along it: an arrow at least 250 px long at 100% zoom, with a head at one end only, carries a small arrowhead about every 150 px, pointing the way it goes |
| Move an arrow's start or end | Point at the arrow and drag the dot at that end onto another node or group; or pick it under **From** or **To** in the sidebar |
| Group nodes | Click a node and pick **New group…** under **Group** in the sidebar; then click each other node and pick that group there |
| Delete | Select, then Delete |
| Undo / redo | Ctrl+Z / Ctrl+Y, or the curved arrows at the chart's top left |
| Change which way the chart runs | The direction button, an arrow, shows the way the chart runs now. Point at it or click it to show the other three ways, and click one: the file's first line changes, for example from `flowchart TD` to `flowchart LR` |
| Zoom / pan | Mouse wheel or pinch to zoom; drag empty space to pan |
| Fit the chart in the window | **Fit**, in the bar at the bottom of the chart: a click shows the whole chart, and the next click its width (top first), in turn; after you move the view, a click shows the whole chart again. Pointing at **Fit** shows **Whole chart** and **Width** to pick one. The view glides there. A chart opens fitted whole, unless its text would then be smaller than 9 px: a tall chart then opens fitted to its width, its top first, and you scroll down it |
| Move the chart with two fingers on a touchpad | The first switch in the middle of the rail shows a mouse over a touchpad, with a knob on the mode in use. Click it to slide the knob to the touchpad: in Touchpad mode two fingers or the mouse wheel move the chart (Shift: sideways), and a pinch or Ctrl with the wheel zooms. Naiad starts in Mouse mode and remembers your choice |
| Point at nodes, arrows or groups with an agent | The **Highlight** button, a highlighter pen (key H), then click them; **Clear**, at the chart's top left with the number of highlights, takes every highlight off |
| Show or hide the flowchart's Mermaid syntax | The **Syntax** button, `</>`, on the rail (the syntax is hidden when Naiad starts, unless you left it open). Opening it closes the **Recent files** list. The pane colours the parts of each line (ids, titles, arrows, labels, classes and descriptions) and numbers the lines; a long line wraps, and a bar beside the numbers marks its wrapped rows |
| Read or edit the syntax with the whole window | The button at the Syntax pane's top right makes the pane fill the window, over the chart and the sidebar. Click it again, or hide the pane, to see the chart again |
| Follow one run through the flowchart, node by node | In View mode, **Walkthrough** (footprints) in the bar at the bottom of the chart. The bar says **Click the node to start from**, and all but the nodes no arrow points to fades, as a hint; any node can be clicked. Then the node you are at glows, its next steps and their arrows stay as drawn, the path taken is half faded and the rest fades, and the sidebar shows the node. Click a next step, its arrow or its label to go on; the view glides there. A next step out of view gets a chip at the chart's edge, where its arrow leaves the view; click the chip to go there. Left arrow or **Back** goes back; Right arrow goes on when there is one way on; 1 to 9 take the next steps in the order they lie on the chart. At the end of a path, **Start again** goes back to the node you started from. Escape or **Leave** ends it, and so do switching to Edit mode and opening another file. Highlights are hidden while it lasts; their file is not changed |
| Save the chart as a picture | **Export**, under the two switches on the rail: **Save as SVG…** or **Save as PNG…**. The picture is the whole chart in the colours on screen, without the selection or highlights; a PNG is twice the size the chart has at 100% zoom, at most 16,384 pixels a side and 120 million pixels in all. The save dialog offers the flowchart's name, in its folder |
| Print the chart or its descriptions | **Print** (Ctrl+P), under **Export**, opens a page with three boxes: **The chart** (ticked at first, printed in black on white), **The flowchart's description** (above the chart) and **Each node's description** (after the chart, for each node that has one). For the chart, **Fit on one page** or **Readable size, over several pages**, each saying what it gives, such as the text's size or the number of pages; **Change** picks the paper and which way up, your region's paper at first. **Print preview…** opens Windows' print window, where you print |
| Read without changing anything | The second switch in the middle of the rail shows a pencil (Edit mode) over an open book (View mode), with a knob on the mode Naiad is in. Click it to switch. View mode has no dots to drag, no dot grid, no **+**, direction button, Undo or Redo, and the sidebar and the Syntax pane show text only; an edit tried there shows a notice instead. Naiad opens in the mode you left it in |

## Dragging near the edge

While you drag a dot, holding the pointer within 48 px of the chart's edge moves the
view that way, at up to 1,200 px a second, until the chart's edge on that side comes
into view; the wheel and a pinch work as they do outside a drag, and Escape cancels the
drag.

## Saving

The file is saved by itself while it is a valid flowchart; Ctrl+S saves it at once.
Naiad shows no "Saved" mark. A notice at the top of the chart says when the file could
not be saved or read, and when its text is not a flowchart Mermaid can read. Text like
that, typed in Naiad, is saved only when you press Ctrl+S. When the file changes on
disk while Naiad holds an edit not yet saved, the version on disk wins and the edit
stays in Undo ([FILE-FORMAT.md](FILE-FORMAT.md#what-naiad-changes-in-a-file-and-what-it-never-does)).
Highlights are kept in a small file of their own beside the flowchart, which an agent
reads and writes too ([FILE-FORMAT.md](FILE-FORMAT.md#highlights)).

## What Naiad keeps on your computer

- Each file you open: read again whenever it changes on disk, and written only as
  [FILE-FORMAT.md](FILE-FORMAT.md#what-naiad-changes-in-a-file-and-what-it-never-does)
  describes.
- Highlights: `.naiad/<file name>/highlights.txt` in the flowchart's folder, with
  Windows' hidden mark on `.naiad`. The file, and the folders it leaves empty, are
  deleted when the last Naiad view of the flowchart closes.
- A picture you export: written only where you save it.
- In your temporary folder, while they run: a small record of each open window
  (`naiad-views`), and the address of each `naiad serve` server (`naiad-serve`), so a
  second `naiad serve` on the same file prints the same address.
- In the window's own storage, kept by Windows' WebView2 in
  `%LOCALAPPDATA%\app.naiad.desktop`: whether the Syntax pane is shown, the width of
  each pane, whether View mode and **About** are on, Touchpad or Mouse mode once you
  choose one, the appearance, theme and Syntax font once you choose them, and whether
  **Remember opened files** is on once you turn it off or on.
- While **Remember opened files** is on, for each window: the full paths of the files
  open in its tabs, in their order, and which one is shown; its place on the screen;
  while it is split, also which tabs are in the second half, the tab each half shows,
  and the split's direction and divider. They are in the same storage, written each time a tab opens, closes or is
  shown, and when the window closes.
- The full paths of the last 50 files you opened, for the recent files, in the same
  storage. While the list is shown, Naiad checks that each listed file is still there;
  it reads none of them until you click one.
- Naiad makes no network requests of its own. An image in a description that points to
  a web address is loaded from there when the description is shown, and a link in a
  description opens in your browser.
