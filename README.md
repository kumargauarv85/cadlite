<p align="center"><img src="screenshots/logo.png" width="120" alt="CADLite logo"></p>

# CADLite Viewer (beta)

**A free, lightweight DWG and DXF viewer and editor for Linux.** Open a drawing,
switch between Model and layout sheets, turn layers on and off, take real
measurements and make quick edits, without Windows, Wine or a CAD licence.

![Editing a floor plan](screenshots/editing.png)

## What it does

- Opens **DWG** (R12 to 2018+) and **DXF**
- **Model and layout tabs**, with viewports shown at their scale
- **Layers**: on/off, filter, isolate, reset
- **Measure** distance, path length, area, angle and radius, with snapping to
  end, mid, centre and intersection points
- **Units**: mm, cm, m, inch, feet, plus a Calibrate tool for drawings with an
  unknown scale
- **Edit**: line, polyline, rectangle, circle, arc, text, revision cloud,
  hatch, move, copy, erase, explode, trim, extend, colour and layer, with undo
- **Save** back to DWG or DXF in the original version; convert between versions;
  export SVG and PNG
- Runs locally: your drawings never leave your computer

> **Beta.** Built for 2D review and quick markups, not full drafting. Xrefs, 3D solids, images and true
> hatch patterns are not shown yet (see Known limits). The code was written
> with AI assistance. If a drawing opens wrongly, please open an
> [issue](../../issues).

## Editing (beta)

Click **Edit** to show the drawing tools. Everything is undoable (Ctrl+Z / Ctrl+Y).

- **Draw:** Line, Polyline, Rectangle, Circle, Arc (3 points), multiline Text
  (bold, italic, underline, strikethrough, font, alignment, ° ± ⌀ symbols), Table, Revision
  cloud (rectangle or polygon) and Hatch (Solid, ANSI31, ANSI37, ANSI32, NET,
  LINE, DASH, DOTS, BRICK, EARTH, with scale and angle).
- **Hatch:** click inside any closed outline; closed shapes inside it become
  islands. With no closed outline, click the corners of the area instead.
- **Modify:** Move, Copy, Scale, Erase, Explode, Trim and Extend (quick mode: every
  visible object is a cutting edge or boundary), plus Colour and Layer for the
  selection. New layers can be created from the Layer list.
- **Properties panel:** select anything (also outside Edit mode) to see and change
  colour, layer, linetype, linetype scale, lineweight, and for texts the contents,
  height, rotation and text style; circles and arcs show an editable radius, and
  lines, polylines and hatches show their length or area.
- **Hover highlight:** the object under the pointer lights up, so you can see what
  a click will pick. Double-click a text to edit it.
- **Zoom:** Pan, Zoom window (W, drag a box) and Extents (F); the mouse wheel zooms.
- **Select:** click; Shift+click removes; drag left-to-right for a window,
  right-to-left for a crossing selection.
- **Precise input:** type in the command line at the bottom (AutoCAD style):
  `L`, `PL`, `REC`, `C`, `A`, `T` (multiline), `DT` (single line), `TB`, `REVCLOUD`,
  `H`, `M`, `CO`, `SC`, `TR`, `EX`, `X`, `E`, `U`, `ZW`. Points: `x,y`, `@dx,dy`, `@length<angle`, or just a length in the
  direction of the cursor. Ortho (F8) and Snap (F3) as in AutoCAD.
- **Saving:** Save (Ctrl+S) writes back to the same file and format (a DWG stays
  a DWG in its original version), keeping the previous version as `name.bak`
  the first time. Save as lets you pick another format, version and place.
  Only changed objects are rewritten; everything else in the file is kept as
  it was.

Editing limits: no dimensions, grips, stretch, rotate, mirror, offset or fillet
yet. Tables are made of lines and texts, not an AutoCAD table object. Trim and extend work on lines, arcs, circles and polylines (not
splines or ellipses). Dimensions, tables, multileaders and images cannot be
moved or copied yet. Explode breaks a block down completely (nested blocks
too). Objects are drawn in the tab you are on; drawing through a layout
viewport into model space is not supported. Files older than AutoCAD R14 save
new hatches as outlines.

| Layout sheet with viewport | One-click DWG setup |
|---|---|
| ![Layout tab](screenshots/layout.png) | ![DWG setup](screenshots/dwg-setup.png) |

## Install

Any Linux (Bazzite, Fedora, Arch, openSUSE ...), no root needed:

    curl -LO https://github.com/kumargauarv85/cadlite/releases/download/v2.1.0/cadlite-2.1.0-linux.tar.gz
    tar xzf cadlite-2.1.0-linux.tar.gz
    cd cadlite-2.1.0
    ./install.sh

Ubuntu / Debian / Mint / Pop!_OS:

    curl -LO https://github.com/kumargauarv85/cadlite/releases/download/v2.1.0/cadlite_2.1.0_all.deb
    sudo apt install ./cadlite_2.1.0_all.deb

Start it from the application menu ("CADLite Viewer"), by right-clicking a
.dwg/.dxf file and choosing "Open With", or from a terminal: `cadlite plan.dwg`.
To remove it: `./install.sh --uninstall` (or `sudo apt remove cadlite`).

Requirements: Python 3.6+. CADLite opens in its own small native window when
the system has GTK with WebKitGTK and PyGObject (standard on GNOME desktops,
including Bazzite GNOME). Otherwise it uses a Chromium-family browser in app
mode (Chrome, Chromium, Brave, Edge, Vivaldi; native or Flatpak), then Firefox
or your default browser. `cadlite --browser` forces the browser. In the native
window, saved and exported files go to your Downloads folder.
The viewer talks only to a private service on 127.0.0.1.

## DWG files and version conversion

DXF files open straight away. DWG is a closed format, so CADLite uses the free
ODA File Converter as its engine for opening DWG and saving other versions
(R12 to 2018+). Set it up once, from inside the app:

* Click **Convert / Export > Set up DWG support** (or just open a DWG file and
  press the button that appears). CADLite downloads the engine from
  opendesign.com into ~/.local/share/cadlite/engine and unpacks it. Nothing
  else to install; it needs an internet connection only this one time.
* Terminal alternative: `cadlite --setup-dwg`
* Already have the ODA AppImage, or LibreDWG (`dwg2dxf`)? CADLite detects them
  too. A custom path can be set under "Use a converter you already have".

The engine is ODA's software and is used under ODA's terms. Its window may
flash briefly during a conversion on systems without `xvfb`.

Built in, no converter needed: SVG (vector), PNG, and a simple R12 DXF.

Command-line conversion: `cadlite in.dwg --convert out.dxf DXF ACAD2013`
(formats DWG, DXF, DXB; versions ACAD12, ACAD14, ACAD2000, ACAD2004, ACAD2007,
ACAD2010, ACAD2013, ACAD2018).

## Using it

* Pan: drag. Zoom: mouse wheel. Fit: F or double-click.
* Layers: tick/untick; double-click a name to show only that layer; Reset
  returns to the state saved in the file.
* Tabs at the bottom switch between Model and the drawing's layouts.
* Measuring: D distance, P path, A area, G angle, R radius. Enter or
  double-click finishes, Esc cancels, Backspace removes the last point, S
  toggles snap. Inside a layout viewport, results are real model units at the
  viewport's scale; across the sheet they are paper units.
* Placing a distance: after the two points, move the pointer away and click
  to set the dimension line clear of the drawing (Enter keeps it on the
  points). Drag any measurement label later to move it.
* Units: "1 drawing unit =" says what one unit in the file stands for (read
  from the file when it states it, otherwise assumed mm); "Measure in" is the
  unit results are converted to. If numbers look wrong, press Calibrate, click
  the two ends of a length you know, and type its real value.
* Own window: CADLite opens in its own window when a Chromium-family browser
  is installed (Chrome, Chromium, Brave, Edge, Vivaldi; native or Flatpak).
  With only Firefox it opens as a browser tab.

## Known limits

2D viewer: 3D solids/surfaces (ACIS), images, OLE objects, XLINE/RAY and
MLINE are not drawn; 3D geometry is shown in plan. text uses a system font, line weights are not shown, and
viewports are clipped to their rectangle and assumed to look straight down.

## Licence

MIT. The optional DWG engine (ODA File Converter) is separate software from the Open Design Alliance, downloaded by the user under ODA's own terms.
