# Change Log

All notable changes to the **Debug Inspector** extension are documented here.

## [0.92.0] - 2026-07-17

### Added
- **Show all / Hide all in both the Sections and Columns menus.** One click opens or closes every
  tab/column. Sections' *Hide all* keeps the active tab visible (the panel never goes empty); Columns'
  keeps the first visible column. *Show all* refetches only what was hidden — newly shown sections are
  re-read in one message (the `reveal` protocol now carries a list), and showing all columns rebuilds
  just that section.
- **Right-click a tab to manage sections.** Right-clicking a tab opens the Sections menu at the cursor —
  the exact counterpart of right-clicking a column header for the Columns menu. Sections and columns now
  share the same interaction language: drag to reorder (tab/header or menu row), right-click for options,
  checkboxes + Show all/Hide all in the menu.

### Fixed
- The multi-section reveal loop respects live state: a new stop / resume cancels the remaining fetches, a
  section re-hidden while the list is loading is skipped (hidden sections are never read from GDB), and one
  failing section no longer strands the rest at *Loading…* (it shows an explicit ⚠ instead). A targeted
  whole-section rebuild also re-applies the **current** column preferences when it lands, so hiding columns
  while a rebuild is in flight is no longer reverted by the stale snapshot.

## [0.91.0] - 2026-07-14

### Changed
- **The panel opens as a full-width tab in the active editor group, not a split.** *Open Panel* used
  `ViewColumn.Beside`, which split the editor in two (the "half window"). It now opens with
  `ViewColumn.Active` — a full-width editor tab you switch to — leaving your editor layout untouched.
  Reopening an already-open panel just brings it to the front of whatever column it currently lives in
  (you can still drag it beside your code yourself if you prefer that layout).

## [0.90.3] - 2026-07-14

### Changed
- **`timeline.set.dashWhen` constant handling refined.** Only `true`/`false` are now a no-GDB constant —
  GDB's C mode doesn't know the identifiers `true`/`false`, so they can't be evaluated and must be resolved
  in-process. A literal `1`/`0` is instead evaluated as an ordinary, element-independent GDB expression
  **once** and applied to the whole set (previously `1`/`0` were also short-circuited as constants). The
  accessor (`"off"`) and `"${expr}"` forms are unchanged (per-element). The net effect for `1`/`0` is the
  same (all/none dashed) — just resolved the way GDB naturally evaluates them.

## [0.90.2] - 2026-07-14

### Changed
- **A single timeline `set` now shows its `title` caption too.** The per-group caption previously appeared
  only when a block had ≥ 2 sets; a lone set's `title` lived only in the tooltip. Now any set with a `title`
  gets a small caption to the left of its chips (a title-less set still shows none).

## [0.90.1] - 2026-07-14

### Changed
- **`timeline.set.dashWhen` accepts a literal constant.** Writing `"dashWhen": 1` / `"0"` (or `true` /
  `false`) now dashes **all** (or none) of that set's chips with no per-element GDB read. Previously a bare
  `1`/`0` was mistaken for a field accessor (`(elem).1`), which errored and silently evaluated to false. The
  accessor form (`"off"`) and the `"${expr}"` expression form are unchanged.

## [0.90.0] - 2026-07-14

### Added
- **Multiple sub-arrays per timeline block (`timeline.set` may be an array).** `set` now accepts either a
  single set object (as before) or an **array** of them, so a block can carry several id-sets at once — e.g.
  a device list *and* a signal list. Each set renders as its own chip row inside the block; when there are
  ≥ 2 sets, each row is prefixed with that set's `title` as a caption (e.g. `dev` / `sig`). Every set keeps
  its own `label` / `dashWhen` / overflow (`+N`) / `max`, and the tooltip and click-detail card list each
  set separately. A single set object renders exactly as before (no caption). Demo: the `sched` timeline now
  shows each window's `dev` and `sig` sets on separate rows.

## [0.89.0] - 2026-07-14

### Added
- **Conditional dashed borders on device chips (`timeline.set.dashWhen`).** A `dashWhen` expression on a
  timeline `set` is evaluated **per device element** — an accessor like `"off"`, or a `"${expr}"` template
  where `${expr}` is the device element (e.g. `"${expr}.flags & 1"`). When it's truthy (same
  empty/`0`/`false`/NULL → false rule as a field's `when`), that device's chip is drawn with a **dashed**
  border, in both the timeline block and the click-detail card. Demo: the `sched` timeline marks offline
  devices (`"dashWhen": "off"`) with dashed chips (adc1, imu, can0).

## [0.88.0] - 2026-07-14

### Added
- **Click a timeline block for a detail card.** Clicking any block (part/window) opens a docked card below
  the timeline listing *all* of that block's fields — decoded exactly like the graph node panel (`badge` /
  `valueMap` / `flags` text and colors, raw integer in parentheses) — plus its device set (`timeline.set`)
  as chips. Click the block again or the ✕ to close; the open card survives a re-render (e.g. zoom).
- **Legend caption naming the color field.** The timeline legend now leads with the name of the field the
  colors encode (e.g. `Part:`), so it's clear what the swatches mean rather than leaving it implied.
- **Optional total label (`timeline.totalLabel`).** In positioned mode you can give the axis total a caption
  — `"totalLabel": "major frame"` renders `major frame: 200 ms` on the axis (and in a split chart's title).
  With no `totalLabel`, nothing is assumed — the axis shows just the number and unit as before.

## [0.87.1] - 2026-07-14

### Changed
- **`timeline.set` group title is yours to name (`set.title`).** The device-set line in a block's tooltip
  previously hard-coded the word "devices". It now uses `set.title` from config; with no title given, the
  tooltip shows just `(N): …` and assumes no name.

### Added
- **`timeline.set` auto-fits when a block has too many chips.** After render, chips that don't fit inside a
  block are collapsed into a trailing `+N` badge (the full set always stays in the tooltip). Zooming the
  timeline wider re-flows and reveals more chips. A block with many devices no longer clips them out of sight.

## [0.87.0] - 2026-07-14

### Added
- **Per-block device sets in the timeline (`timeline.set`).** A timeline block (e.g. a scheduling
  window / partition) can now carry a *second* array — a set of ids read off that block's own element —
  rendered as chips inside the block. Configure it under the section's `timeline`:
  ```json
  "timeline": { "start": "Start", "width": "Dur", "total": 100, "unit": "ms",
                "set": { "array": "devs", "count": "ndev", "access": ".", "label": "name" } }
  ```
  For each block element, `array` and `count` are resolved relative to it — accessor (`"devs"`),
  constant, `"::global"`, or a `"${expr}"` template (use `"${expr}->…"` when the element is a pointer) —
  and each sub-element's `label` field (or the element itself when `label` is omitted) becomes a chip;
  `access` is the sub-element accessor (`.`/`->`) and `max` caps the count (default 64). Wide blocks list
  every id; narrow blocks crop with an ellipsis and the full set is always in the block's tooltip. The
  sub-arrays are fetched server-side per block (via each row's stable element expression) and shipped with
  the section, so switching to the timeline view needs no re-fetch. Demo: the `sched` timeline shows each
  partition window's device set (e.g. `NAV → gps, imu, mag`).

## [0.86.3] - 2026-07-12

### Fixed
- **Cross-reference links (`field.link`) now work in on-demand detail sections (`selectedFrom`).** The extension
  already computed the links for detail fields (`buildSection`/`buildArrayNd` attach them), and the `.xref`
  click handler is delegated on the panes container so a click inside a detail accordion was always caught —
  but the detail mini-table renderer (`detSubTable`) passed `links: {}`, silently dropping them (every other
  presentation attribute — base, bar, badge, valueMap, sourceLine — was already honored; only `link` was
  missed). It now passes `sec.links`, so a linked cell in a detail section renders as a clickable cross-reference
  that jumps to the matching row in the target section, exactly like a top-level table. Demo: the **MutexAt**
  detail now has an `Owner` field linking to the `threads` section by `ID`.

## [0.86.2] - 2026-07-12

### Fixed
- **Stray refresh after resume (rapid re-stop → continue).** `cancelRefresh()` (fired on the debugger
  `continued` event) bumped the refresh generation and cleared the debounce timer but did **not** reset the
  queued `pendingRefresh` flag. So if a second stop had queued a follow-up refresh while a first refresh was
  still in flight, the run-loop would fire **one more full refresh after the program had already resumed** —
  evaluating expressions on a running program (stale data / ⚠ cells). `cancelRefresh()` now also clears
  `pendingRefresh`, so resuming reliably ends refresh activity. The legitimate coalesced re-run (a second stop
  with no resume) is unaffected.
- **Skeleton flash from a superseded refresh.** `refresh()` posted its `beginUpdate` (which clears the panel
  to a skeleton) with no staleness check — the first check came only inside the section-streaming loop, *after*
  the panel had already been wiped. A refresh that was superseded during its `stackTrace`/print-setup awaits
  (e.g. by a `continued` or a newer request) could therefore blank the panel and then bail with no `endUpdate`.
  A `stale()` guard now runs immediately before `beginUpdate`, so a superseded run never wipes the panel.
- New deterministic unit test of the coalescing state machine (`test-refresh-machine.js`, gate step 26): a
  verbatim copy of `doRefresh`/`cancelRefresh`/`runRefresh`/`gdbAcquire` driven with a fake timer and a
  hold-able `refresh()`, asserting single=1, debounce-coalesce=1, legitimate pending re-run=2, cancel-clears-
  pending=1 (the fix above), and pre-debounce cancel=0. This isolates a race the live-GDB harness cannot force
  deterministically. These two fixes surfaced from an adversarial audit proving no single stop double-refreshes.

## [0.86.1] - 2026-07-12

### Fixed
- **Double-load when opening the panel while already stopped.** The *Open Panel* command called
  `refresh(...)` **directly** right after creating the webview — bypassing the debounce/generation-guard/GDB
  mutex — while the freshly-loaded webview *also* triggers a refresh via its `ready` message. Opening the
  panel at a breakpoint therefore ran **two full fetch passes**, and because the direct call skipped the
  serialization mutex it could race the `ready`-triggered refresh over the shared `$ri_*` cursors (transient
  ⚠ cells). The command now calls `doRefresh()`, which coalesces both triggers into a single serialized
  refresh. (Panels opened before stopping, and every other trigger, were already correctly coalesced.)
  New end-to-end regression test (`test-double-load.js`, gate step 25) counts `endUpdate` posts per trigger
  and asserts open-while-stopped = 1 refresh (was 2), single/rapid/reload = 1, stopped-then-continued = 0.

## [0.86.0] - 2026-07-04

### Added
- **Horizontal zoom for positioned timelines (− / Fit / +).** A single chart (or any chart) was always
  fit to the pane width, so with a large `total` the blocks became tiny. The timeline toolbar now has a
  zoom control (in positioned mode): **1× fits the width** (unchanged default), and each **+** doubles the
  drawn width (up to 16×) so the timeline overflows the pane with horizontal scroll and small slices become
  readable; **−** steps back down to Fit. Works for single- and multi-chart timelines and composes with
  Normalize. Lane names are now **sticky** — they stay pinned at the left while you scroll horizontally.
  Per-section state.

## [0.85.0] - 2026-07-04

### Added
- **⤢ Normalize toggle for multi-chart timelines.** When a timeline is split into several charts
  (`timeline.chart`), the toolbar now offers a runtime toggle between **proportional** (each chart's width
  scaled to its `total`, true-to-scale) and **normalized** (every chart drawn at full width). Short
  timelines that were cramped next to long ones in proportional mode become readable in one click — no
  config edit. The button defaults to the config's `scale` and its state is per-section.

## [0.84.0] - 2026-07-04

### Added
- **Multiple timelines in one section (`timeline.chart`).** A `chart` column splits a section into
  **separate timeline charts** — one per distinct value, each with its own title and its own axis — so
  timelines of *different lengths* are shown independently instead of forced onto one scale. With `chart`,
  **`total` may be a column** (each chart's axis end is read from its own rows: a positive constant per
  chart, disagreements flagged, never computed), and **`scale`** picks the layout: `"proportional"`
  (default — a chart's pixel width is proportional to its `total`, so a 250 ms timeline is ~2.5× the width
  of a 100 ms one) or `"fit"` (every chart spans the full width; the length difference lives only in the
  axis numbers). Without `chart` the timeline is unchanged (single chart). Demo: new `schedules` section —
  `boot` (100 ms) and `cruise` (250 ms) schedules, each with per-core lanes and idle gaps, drawn at
  proportional widths.

## [0.83.0] - 2026-07-04

### Changed
- **Professional timeline rendering.** Applied dataviz rules to the ⏱ view: the categorical palette is
  replaced with an 8-slot **validated dark palette** (lightness band / chroma floor / contrast all PASS;
  identity is never color-alone thanks to labels + legend + gaps); block labels now wear **ink**, not the
  series color; a **lane-aligned 5-tick axis** (0/¼/½/¾/total, tabular numerals, optional `unit` such as
  `"ms"` on the last tick) replaces the 3-label header; **recessive dashed gridlines** run through every
  lane at the tick positions; lanes get zebra striping and stronger name typography; blocks brighten on
  hover; and an **automatic legend** (swatch + value, capped at 12 with “+N”) appears whenever the color
  key has ≥ 2 distinct values. Same value → same color across refreshes (entity-stable hashing).

## [0.82.2] - 2026-07-04

### Fixed
- **Positioned timeline silently fell back to sequential layout — gaps and the axis never appeared.**
  The `total` validation regex lived inside the webview's TypeScript template literal, where a single
  backslash is consumed during template evaluation (`\d` became `d`), so a perfectly valid
  `"total": 100` never matched and positioned mode disabled itself. Escaped properly; the whole template
  was scanned for other mangled escapes (none left). Added a **rendered-output regression test** that
  drives the *evaluated* webview (mock section → switch to ⏱ view) and asserts the axis with the
  configured total, blocks placed at their `start` values (`left:40% / left:75%` → real gaps), and no
  bogus total warning — the raw-JS syntax check alone cannot catch this class.

## [0.82.1] - 2026-07-04

### Changed
- **Positioned timeline: `total` must be given in config — it is never derived from the data.** The
  auto "(latest end)" fallback is removed: the axis end is exactly what you configure. If `start` is set
  but `total` is missing or not a positive number, the timeline shows an explicit ⚠ notice and renders
  the sequential layout instead (nothing is guessed).

## [0.82.0] - 2026-07-04

### Added
- **Positioned timeline (`start` + `total`).** Give `timeline.start` a column and blocks are **placed on
  the time axis by that value** instead of packing sequentially — so **gaps between executions are
  visible**. `width` becomes the duration; lane order is implied by position. A dashed **axis header**
  shows `0 · mid · total`; `total` may be a fixed number (`"total": 160`) or is derived automatically as
  the latest end (labeled *(auto)*). Missing/invalid start clamps to 0 (a rule, not a guess); a fixed
  `total` smaller than the data simply clips (track overflow is hidden). Demo: `coreSched` now uses
  `start: "Start"`, `width: "Dur"`, `total: 160` over the new per-item `start`/`dur` fields — lanes per
  core with visible idle gaps.

## [0.81.2] - 2026-07-04

### Fixed
- **`linked_list` now has a cycle guard.** `walk` and `tree` already detected revisited nodes, but a
  linked list that is circular (or whose `next` reads garbage that loops) crawled all the way to the
  `max` bound (default 1024) — hundreds of serial GDB round-trips that feel like an infinite load on a
  real target. The traversal now records each node address and stops with an explicit
  `cycle (node 0x… repeats)` reason (visible in the log's `stopped:` line) the moment a node repeats.
- **New release-gate test for traversal termination** (`test-linked-term`): replays the extension's exact
  cursor-chase against real GDB and asserts the NULL stop after exactly 8 demo rows, the cycle-guard stop
  on a circular chain, and the `max` clamp on a runaway chain — value tests existed, termination didn't.

## [0.81.1] - 2026-07-04

### Changed
- **The ⏱ Timeline button is now opt-in per section.** It appears only in sections whose config has a
  `"timeline"` key (an empty `{}` enables it with defaults: lanes from group headers, block text from the
  first visible column). Sections without the key no longer show the button; if the key is removed while
  a section is in timeline view, the section falls back to the table view.

## [0.81.0] - 2026-07-04

### Changed (BREAKING)
- **`array2d` and `array3d` modes are removed — `nested_array` is the single multi-level mode.** They had
  become pure aliases normalizing into the same engine; keeping three spellings of one feature cost config
  and doc surface with no behavior difference. Migration is mechanical:
  `root`/`count`/`access`/`label`/`cast`/`wrap` + `inner*`/`inner2*` become entries in `levels[]`
  (outermost first, last level = the rows) — e.g. array3d's `"inner": "${expr}", "innerCount": "::g_n"`
  is now `{ "array": "${expr}", "count": "::g_n", ... }` as `levels[1]`. All tokens are unchanged
  (`${index}`, `${master}`/`${master_index}`, `${outer}`/`${outer_index}`, named `${<level>}` /
  `${<level>_index}`, and the `${selected*}` detail tokens). The demo `panels` and `coreJobs` sections
  are migrated in place. A `label` on the last (row) level now logs an explicit "ignored" warning.

## [0.80.1] - 2026-07-04

### Fixed (adversarial review pass over 0.80.0)
- **Detail sections: `${selected}` / `${selected_index}` / `${selected_master_index}` / `${selected_outer_index}`
  in FIELD expressions now resolve correctly.** They were pre-substituted into the field template; a field
  that became token-free (e.g. `"${selected_index}"` → `"5"`) was then appended to the row element
  (`elem.5` — a GDB syntax error). Selected values are now carried to **row time** like every other token.
- **A section that fails to build no longer kills the whole refresh.** The refresh queue wraps each section
  build; a failure renders an explicit ⚠ error in that tab and the remaining sections still load. Same for
  the multi-level walk (its own try/catch) and details.
- **Multi-level counts are bounded at every level.** A corrupt/huge intermediate count (e.g. an
  uninitialized `0xFFFFFFFF`) used to loop for billions of GDB round-trips (only leaf rows counted toward
  `max`); every level's iteration is now clamped by `max` too.
- **JSON-number counts (`"innerCount": 4`) no longer throw.** Part expressions coerce numbers to strings.
- **Level-name validation hardened:** names ending in `_index`, names whose derived `<name>_index` token
  collides with another level or a reserved token (e.g. `selected_master`) are rejected explicitly.
- **Timeline:** lanes named `constructor`/`__proto__` no longer break the render (prototype-safe map);
  streaming no longer paints a partial table over an open timeline; a cross-reference jump into a
  timeline-view section switches it to the table to highlight the row; timeline columns that are hidden
  (thus unfetched) show an explicit ⚠ hint instead of silently empty blocks. The row-level named token now
  binds to the wrapped element, consistent with `${master}` and group-level tokens.

## [0.80.0] - 2026-07-04

### Added
- **`nested_array` mode — the categorical N-level generalization of `array2d`/`array3d`.** Levels are a
  list (`levels[]`, outermost first; the last level is the rows), each with `array`/`count`/`access`/
  `label`/`cast`/`wrap` — and a **`name`**. Naming a level `"core"` gives readable tokens in every
  field/label expression: **`${core}`** (that level's element) and **`${core_index}`** (its subscript) —
  e.g. `"${job}.name"`, `"g_stats[${core_index}]"` — no more outer/master jargon (the legacy `${master}`
  / `${outer}` tokens still work). Level names are validated (unique, identifier-shaped, not reserved).
  `array2d`/`array3d` configs are unchanged — internally they normalize to the same level list and run
  through one engine (blob batching, streaming, cancel-on-hide all apply).
- **⏱ Timeline view — round-robin lanes for any section.** A third view next to Table/Graph: rows become
  colored **blocks on horizontal lanes**. Configure per section with `"timeline": { "lane", "order",
  "label", "color", "width" }` — `lane` picks the column that defines the lane (default: the group
  header), `order` sorts within a lane, `label` is the block text, `color` picks the color-key column
  (config `badge`/`valueMap` colors win, otherwise a categorical palette), `width` makes block width
  proportional to a column (e.g. a slice duration). Hover a block for a full-field tooltip. Timeline
  settings are presentation-only — changing them re-renders without touching GDB. Demo: hidden
  `coreSched` section (named levels + timeline over per-core job items).

## [0.79.0] - 2026-07-03

### Added
- **Text templates in `array2d`/`array3d` group labels.** `label` / `innerLabel` containing `${` is now
  treated as a **literal text template** (no GDB read): `${index}` = the labeled element's own subscript
  (`label` → outer, `innerLabel` → middle), `${outer_index}` = the outer subscript, `${master_index}` =
  alias of `${index}` here. An `innerLabel` template defines the **entire** group header (no forced
  `outerLabel › ` prefix, since the template can embed `${outer_index}` itself) — e.g.
  `"innerLabel": "core ${outer_index} -> job ${index}"` → `core 0 -> job 0`. Strings without `${` keep
  the old accessor behavior (evaluated on the element via GDB).

## [0.78.1] - 2026-07-03

### Fixed
- **`array3d`: `${outer_index}` / `${outer}` cells no longer produce `A syntax error in expression,
  near '.0'.`** The outer tokens were pre-substituted into the field templates, so a field like
  `"${outer_index}"` became the token-less literal `"0"`, which the field resolver no longer recognized
  as standalone and appended to the element (`elem.0`). They are now resolved **at row time** exactly
  like `${master}`/`${master_index}` (threaded through the collector), so standalone and embedded uses
  both work — and they also resolve inside `wrap`/`when`/`bar`. Watchpoint targets on multi-level rows
  were verified against real GDB (address-capture `&(…items)[k].field` + hardware watch both accepted).

## [0.78.0] - 2026-07-03

### Added
- **New section mode `array3d` — three-level arrays.** The canonical shape:
  `struct_my* array[core_count]` where each `array[i]` points to an **array of structs** (`array[i][j]`)
  and each struct carries a second array (`array[i][j].array2[k]`). Each **(outer, middle) pair renders
  as a group** titled `outerLabel › middleLabel` (`label` on the outer element, `innerLabel` on the
  middle); rows are the innermost elements. Config: `inner`/`innerCount` = the middle array on the outer
  element, `inner2`/`inner2Count` = the innermost array on each middle element, `innerAccess` /
  `inner2Access` for middle/innermost field access. Part expressions accept an accessor, a constant, a
  `${expr}` template (`${expr}` = the parent element — a bare `"${expr}"` means the parent itself is the
  array root, exactly the pointer-array case), or the new **`::global`** prefix for a count living in a
  global (`"::g_jobs_per_core"`; also honored by `array2d`). In fields: `${index}` = innermost subscript,
  `${master}`/`${master_index}` = the **middle** element/subscript, and the new **`${outer}`** /
  **`${outer_index}`** = the **outer** element/subscript. A `selectedFrom` detail on an `array3d` master
  gets `${selected_index}`, `${selected_master_index}` (middle), and the new **`${selected_outer_index}`**
  (outer) — each with an explicit error when used on a master mode that can't provide it. Demo:
  `coreJobs` over `g_core_jobs[3]` (per-core job arrays with per-job item arrays) in the test workspace.

## [0.77.0] - 2026-07-03

### Added
- **New section mode `array2d` — two-level arrays.** For an array whose elements each hold an inner
  array (`panel_t g_panels[N]` with `widget_t widgets[M]` inside, per-port queues, per-core run lists).
  No separate master section needed: each **outer element renders as a collapsible group** (titled by
  `label`, falling back to the outer index) whose rows are its inner elements. Config: `root`/`count` =
  the outer array, `inner`/`innerCount` = the inner array on each outer element (accessor, constant, or
  `${expr}` template with `${expr}` = the outer element), `innerAccess` for inner field access;
  `cast`/`wrap` apply to the outer element. In fields, `${index}` = inner subscript, `${master}` = the
  outer element, and the new **`${master_index}`** = outer subscript (`${master_index}` also resolves in
  grouped sections when the `groupBy` target is `array`/`index_list`). A `selectedFrom` detail on an
  `array2d` master gets both `${selected_index}` (inner) and `${selected_master_index}` (outer). The
  inner pass reuses the array machinery, so whole-element batching, progressive streaming, and
  cancel-on-hide all apply. Demo: `panels` section over `g_panels[3]` in the test workspace.

## [0.76.0] - 2026-07-03

### Added
- **`${selected_master_index}` in on-demand detail sections.** When the `selectedFrom` master section is
  **grouped** (`groupBy`), this resolves to the index of the **group's master element** the clicked row
  belongs to — e.g. right-click a thread grouped under processes and the detail can use the *process's*
  array index (`"expr": "g_procs[${selected_master_index}].name"`). Same strictness as
  `${selected_index}`: it resolves only when the `groupBy` target section is **`array`/`index_list`**;
  if the master isn't grouped, or the groupBy target has no real subscript, the detail shows an explicit
  error instead of a cryptic GDB failure. Demo: hidden `procArr` (array of `g_procs`) + `thrByProc`
  (threads grouped by it) + right-click → **Show ThreadPos (detail)**.

## [0.75.0] - 2026-07-03

### Added
- **`${selected_index}` in on-demand detail sections.** Alongside `${selected}` (the selected master row's
  stable element expression), a `selectedFrom` detail can now use `${selected_index}` — the **index of the
  master row you right-clicked**. It resolves only when the master section is **`array`** (array subscript)
  or **`index_list`** (slot subscript); on any other master mode (`linked_list`, `tree`, `walk`) the detail
  shows an explicit error (*"`${selected_index}` is only valid for an array/index_list master"*) instead of
  leaking a cryptic GDB error. It's substituted anywhere in the detail's expressions — e.g. to index a
  parallel array by the selected element's position, or to show the position itself. (`${selected_index}` is
  distinct from `${index}`, which is the detail's *own* row index.)

## [0.74.0] - 2026-07-03

### Changed
- **Closing a section while it is loading now cancels its fetch and moves on to the next one.** During a
  refresh, sections are fetched one at a time (GDB is serial). Previously, hiding a section from the
  Sections menu mid-load still ran that section's fetch to completion before the next section started —
  wasting round-trips on data you no longer wanted. Now the refresh loop checks the live hidden state
  between rows/groups: a section hidden mid-load is aborted at the next row (its partial result is
  discarded, not sent, and not cached as a master), and the loader immediately proceeds to the next
  visible section. Logged at `debug`.

## [0.73.3] - 2026-07-03

### Performance
- **Clicking a `sourceLine` cell now opens the file instantly.** The previous resolver ran several
  `workspace.findFiles` **index scans in sequence** (one per path suffix), which was slow on large
  workspaces. It now resolves with **local `fs.existsSync`** — trying each path suffix under each
  workspace root, no scan — and only falls back to a **single** `findFiles(basename)` (ranked by the
  longest matching suffix) when the file isn't directly under a root. Resolved paths are **cached**, so
  repeat clicks are instant. Measured ~0.2 ms (cold) / ~0.06 ms (cached) vs. the multi-scan path.

## [0.73.2] - 2026-07-03

### Fixed
- **`sourceLine` click now opens the correct file, not just the first same-named one.** GDB reports the
  source path as recorded in the debug info — often **relative to the compilation directory**, and
  frequently with an extra leading component that isn't part of the workspace layout (a build dir, the
  project/obj name, or a `-fdebug-prefix-map` artifact — e.g. `mybuild/obj/src/foo.c`). The cell still
  displays the short `basename:line`, but the click now navigates using the **full path GDB gave**
  (carried in a per-cell side channel), resolved robustly: cygwin `/cygdrive/c/…` is mapped to Windows,
  an absolute path opens directly, otherwise the path is matched by **progressively shorter suffixes**
  (`**/mybuild/obj/src/foo.c` → `**/obj/src/foo.c` → `**/src/foo.c` → `**/foo.c`). The longest suffix
  that exists in the workspace wins — so a bogus leading prefix is skipped and two files sharing a
  basename no longer collide.

## [0.73.0] - 2026-07-03

### Added
- **Source-location field (`sourceLine`).** Set `"sourceLine": true` on a field whose value is a **code
  address** and the extension resolves it with GDB `info line *(…)`, showing the **`file:line`** the
  address maps to — the source-location sibling of `symbol` (which shows `function+offset`). The canonical
  use is a call-stack PC: put `Func` (`symbol`) and `Source` (`sourceLine`) side by side to see both the
  function and its exact line. **Clicking the cell opens that file at that line in the editor.** An address
  with no line information (e.g. code built without `-g`) leaves the cell blank. Read-only, like `symbol`
  (no `base`/edit/watchpoint); excluded from the whole-element blob batch (it needs its own `info line`).

## [0.72.3] - 2026-06-21

### Fixed
- **An anonymous `union`/`struct` member no longer corrupts the field before it.** When GDB prints an
  unnamed aggregate (`{a = 1, {x = 2, y = 3}, b = 4}`), the parser used to append it to the preceding
  member — so `a` silently became `1, {x = 2, y = 3}` and was shown as-is (no fallback). The anonymous
  part is now skipped; `a`/`b` stay clean and the inner fields fall back to a targeted `print` (correct
  value) if displayed.

### Performance
- **Adaptive "whole element" (blob) reads.** Fetching the entire struct once and parsing out fields is a
  big win for normal structs, but a **loss for a wide struct where you only show a couple of fields** —
  measured ~**34× slower** for a `struct { int id; char name[16]; unsigned data[1024]; }` showing just
  `id`/`name` (2.4 ms vs 0.07 ms per row in-process; and worse over a remote stub, since the blob makes
  GDB read the whole struct's bytes over the link). The extension now decides **per section, on the first
  row**: if the blob carries far more than the displayed fields use (chars-per-used-field over a
  threshold) — or doesn't parse — it **disables the blob for the rest of that section and reads targeted
  fields instead**. Normal/wide-but-scalar structs keep the blob (still saves round-trips); only the
  wasteful wide-array case falls back. Logged at `debug`.

## [0.72.2] - 2026-06-21

### Added
- **The output log now reports how many GDB round-trips the batching optimizations saved.** At the
  default `info` level, each refresh ends with a one-line summary — e.g. `perf: ~37 fewer GDB
  round-trip(s) this refresh (blob batch + when/bar-max from blob)`. At `debug` level each section also
  logs a breakdown: how many plain fields were served from the single struct blob, plus the
  `when`-from-blob and `bar-max`-from-blob savings. Makes the otherwise-invisible optimizations
  observable (open **Debug Inspector: Show Log**). No behavior change to the data.

## [0.72.1] - 2026-06-20

### Performance
- A **conditional field (`when`) is now evaluated from the row's struct blob** instead of issuing a
  **separate GDB `print` per conditional field per row**. Since every GDB access is serialized through a
  mutex, the round-trip count dominates load time; this removes one round-trip for each `when` field
  whose condition is resolvable from the already-fetched blob — a **bare member** (`when: "locked"`) or a
  **member-vs-integer comparison** (`when: "${expr}.locked == 0"`). For the demo `mutexes` section
  (6 rows × 2 conditional fields) that is **~12 fewer serialized GDB calls per stop**. The fast path is
  strictly guarded (plain integer member vs integer literal, or bare-member truthiness) and **falls back
  to the original `print` for anything else** (enum-name comparisons, cross-object/`${master}` conditions,
  members absent from the blob), so displayed values are unchanged. Same idea as the 0.70.2 bar-max
  optimization, applied to `when`.

## [0.72.0] - 2026-06-19

### Added
- **Progressive (per-row) section rendering.** A section's rows used to appear only once the *whole*
  section finished fetching — slow for large or grouped sections, since every GDB access is serialized.
  Now rows are **streamed as they arrive**: the table (header + bars/links/badges) shows up immediately
  and fills in live, with a pulsing **`⟳ Loading… N rows`** banner (and the tab spinner) signalling that
  the fetch is still in progress. Flat sections stream per row; grouped sections stream per group.
  Updates are throttled (~80 ms) so the stream never floods the panel. The streaming preview is purely
  cosmetic — the authoritative render still arrives at the end, so **change-highlighting, sorting,
  filters, and on-demand details are unaffected** (the change baseline is the previous *completed* stop,
  not a partial frame). Graph-view sections render once at completion (no partial graph).

## [0.71.0] - 2026-06-19

### Added
- **`walk` mode now honors `cast`, `wrap`, and `access`** (previously they were silently ignored in
  `walk` — only `${expr}` worked). A `cast` (e.g. `"frame_t *"`) types the cursor, so the new
  **`${wrapped_expr}`** placeholder is `((cast)(cursor))` (optionally `wrap`-ed). You can now write a
  callstack as typed member reads — `next: "${wrapped_expr}->prev"`, `expr: "${wrapped_expr}->pc"` —
  instead of raw pointer arithmetic. `${wrapped_expr}` works in `next`/`while` as well as fields.
  **`${expr}` in `walk` stays the raw cursor value**, so existing `${expr}`-only walk configs and all
  bounds/arithmetic are unchanged (byte-identical when no `cast`/`wrap` is set). The demo's `callstack`
  detail now dogfoods this via a `frame_t` cast.

### Fixed
- A single-row refresh (after an inline edit) on a `walk` or `tree` section now falls back to a full
  section refresh — those modes have no stable O(1) per-row expression, so the previous path could
  have produced a wrong `root->next^i` selector.

### Testing
- New gate step proves the `walk` + `cast` path end-to-end against real GDB (typed `${wrapped_expr}->pc`
  equals the raw `*(unsigned long *)(fp+8)` form, symbol resolves, `->prev` chains frames), plus unit
  asserts for the `cast`/`wrap` → `${wrapped_expr}` substitution and a regression guard that a
  cast/wrap-free walk config is unchanged.

## [0.70.2] - 2026-06-19

### Performance
- A field that pairs a `bar` with a plain-member max (e.g. the `threads` `Stack` bar over
  `stack_size`) no longer issues a **separate GDB `print` for the bar's max** — that value already
  arrives in the single struct `print` the row fetches for its other plain fields, so it is now read
  from that parsed blob. Every GDB access is serialized through a mutex, so the number of round-trips
  dominates load time; this removes **one round-trip per row**. For the grouped `threads` section
  (e.g. 8 processes × 6 threads = 48 rows) that is ~48 fewer serialized GDB calls per stop — the
  `threads` tab was the slowest because it is the only section carrying both a `bar` and a computed
  field. (No change to displayed values.)

## [0.70.1] - 2026-06-19

### Testing
- No functional change. Hardened the pre-release regression suite so **every feature is verified on
  each release**. After a coverage audit mapped each feature to its tests, the gaps were closed:
  index_list head→next-index chasing (unit + a new end-to-end GDB gate step), `${wrapped_expr}` and the
  section/field `wrap` construction, `${selected}`/`substituteSelected` (substitutes everywhere except
  `cast`), `${master}` misuse detection, `when`/`condTrue` blanking, `flags` colored pills + residual,
  the grouped Flat-view toggle, the full on-demand-detail wiring (`selectedFrom`/detail menu/accordion/
  graph panel/refresh-while-open), the `symbol` field, Config-open, graph partition collapse, the
  decoded node-detail panel, per-flag graph colors, panel-move persistence, and column reorder. The
  webview suite grew 177→201 assertions, the parser/keyword suite +24, edit +1, and the gate to 13 steps.

## [0.70.0] - 2026-06-19

### Added
- **Symbol resolution field option (`"symbol": true`).** Mark a field whose value is a **code
  address** and the extension reads it with GDB `print/a`, showing the resolved
  **`function+offset`** instead of the raw number (an unresolved address stays as the address).
  The canonical use is turning a call-stack PC into a function name, but it works for any address
  field. Read-only (no `base`/edit/watchpoint on a symbolized field). The demo's synthetic
  call-stack frames now carry **real function addresses** (`mk_thread`, `mk_sem`, `bst_insert`, …),
  and the `callstack` detail gains a `Func` column resolving each PC to its function.

### Docs
- Added screenshots of the on-demand detail (table accordion + graph panel) to the READMEs.
- Corrected several stale schema/feature statements surfaced by a pre-release docs audit: the mode
  count is now **five** (walk was missing), the `root`/`next`/`wrap` schema rows now reflect `walk`
  (walk uses `start`, consumes `next`; `wrap`/`cast` support was added later in 0.71.0), and the
  `${selected}` substitution scope
  is documented in full (`root`/`start`/`next`/`while`/`head`/`nil`/`count`/`wrap` + field
  `expr`/`wrap`/`when`/`bar`, everything except `cast`).

## [0.69.0] - 2026-06-18

### Added
- **On-demand detail sections (`selectedFrom` + `${selected}`).** A section that sets
  `selectedFrom: "<master>"` is no longer a tab — it is a **detail** built only when you
  **right-click a master row (table) or node (graph)** and choose **Show … (detail)**.
  `${selected}` resolves to the right-clicked element's stable expression (in
  `root`/`start`/`next`/`while` and field `expr`/`wrap`/`when`), and the detail is re-fetched
  on every stop **while it stays open** (close it from the **✕** in its header). In the table
  it expands as an accordion **directly below the selected row**; in the graph the detail
  panel opens and widens to hold a sub-table. A master may expose more than one detail.
- This pairs with `walk` for the canonical case: the demo's `callstack` is now
  `"selectedFrom": "threads"` with `"start": "${selected}->cs_fp"`, so right-clicking a thread
  unwinds **that thread's** frame-pointer chain. The demo gains a per-thread `cs_fp` and three
  independent synthetic chains in `g_cs_stack` (chain A / B / C), assigned round-robin to threads.

## [0.68.0] - 2026-06-16

### Added
- **`walk` traversal mode — a condition-bounded cursor unwind.** For sequences that aren't a
  plain array or `next`-pointer list — the classic case is a **call stack** unwound by frame
  pointers. A cursor starts at `start`; each step reads fields with `${expr}` = the current
  cursor, then `next` (a `${expr}` template) computes the next cursor; it continues **while**
  a boolean `${expr}` predicate (`while`) is true and stops when it goes false (plus `max` and
  a no-progress/cycle guard). Read-only. The demo gains a synthetic x86-64 frame-pointer chain
  (`g_cs_thread` / `g_cs_stack`) and a `callstack` section using it.

## [0.67.0] - 2026-06-16

### Added
- **Collapse a group from the graph view.** Right-click a group ("partition") node → **Collapse
  group** to fold its member nodes away (the header stays, marked ▸); right-click again to expand.
  It shares the table's collapse state, so a group folded in one view is folded in the other.
- **Richer node details panel.** Clicking a node now decodes its values the same way the cards do —
  `badge` / `valueMap` / `flags` text and colours — and shows the raw integer in parentheses next
  to a converted value (e.g. `RUN (1)`, `BUSY OWNED (3)`). The panel grows and wraps so values are
  no longer cut off.

## [0.66.0] - 2026-06-16

### Added
- **Per-flag colours on graph cards.** When a `flags` field assigns colours, the graph view
  now draws each set flag in its own colour (uncoloured flags use the default text colour),
  matching the coloured pills in the table. Value-map (`valueMap`) colours already applied on
  the card and continue to.

## [0.65.2] - 2026-06-16

### Changed
- **Table/Graph toggle is on the right in both views.** In the graph view, the **▤ Table**
  button moved to the right of the toolbar to match where **◉ Graph** sits in the table view.

### Fixed
- **Flag (and value-map) fields no longer overlap on graph cards.** Cards now size to the
  **displayed** text (decoded flag names / mapped text) rather than the raw integer, and an
  over-long field value is truncated with `…` so it can never overlap its label — even when
  many flags are set. Full values remain visible in the table view.

## [0.65.1] - 2026-06-16

### Fixed
- **Data no longer disappears when the panel is moved.** Moving the panel to another editor
  group or a new window reloads the webview and clears its in-memory state, and the panel
  only repopulated on the next debugger stop. The webview now signals readiness on every
  (re)load and the extension re-sends the current data, so the tables come back immediately
  after a move (while the debugger is stopped).

## [0.65.0] - 2026-06-16

### Added
- **Bit-flags field (`flags`).** Decode a flag-style integer and show its **set** bits by
  name. The key is the bit **mask** (hex `0x04` or decimal `4`); the value is a name string
  or `{ "text", "color" }`. A flag shows when `(value & mask) == mask`, so single bits and
  multi-bit masks both work. Bits not covered by any mask are appended as `+0x..` (nothing
  hidden); value `0` shows `0`. Rendered as colored pills in the table and joined names on
  the graph card.

## [0.64.0] - 2026-06-16

### Added
- **`${master}` in field expressions.** In a **grouped** section (`groupBy`), a field's `expr`
  (and `wrap`/`when`) can now use `${master}` to reference the master element the row belongs
  to — e.g. show the owning process on each child row with `{ "expr": "${master}->name" }`.
  You write the access (`->` / `.`); it's standalone like `${expr}`. (Previously `${master}`
  resolved only in the section-level `root`/`head`/`count`/`nil`.)
- **Warning for `${master}` in a non-grouped section.** It can't resolve without a master, so
  the extension logs a warning and shows a one-time prompt to add `groupBy` or remove `${master}`.

## [0.63.0] - 2026-06-16

### Added
- **Quick access to the config file.** A **⚙ Config** button in the panel's top bar opens
  your `debug-inspector.json` (and offers to create a starter if it doesn't exist yet). The
  same is exposed as the **“Debug Inspector: Open Config File”** command
  (`debugInspector.openConfig`), with a default keybinding `Ctrl/Cmd+K Ctrl/Cmd+I` when the
  editor isn't focused — rebind it to any key from *Keyboard Shortcuts*.

## [0.62.1] - 2026-06-16

### Changed
- **`${index}` is now limited to `array` and `index_list`.** Those are the only modes with a
  real container index (the array subscript / slot index). It is no longer offered in
  `linked_list` or `tree` — 0.62.0 briefly exposed it there as a row position, which was
  misleading. For tree position, use `${depth}`.

## [0.62.0] - 2026-06-16

### Added
- **`${depth}` keyword for `tree` sections.** A field can use `${depth}` to show the node's
  depth in the tree — `0` for the root, `1` for its children, `2` for grandchildren, and so
  on. Standalone like `${index}` (e.g. `{ "label": "Depth", "expr": "${depth}" }`).

### Changed
- **Clarified `${index}` for `linked_list` and `tree`.** Documented that `${index}` is the
  position from the head in `linked_list` and the breadth-first visit order in `tree` (it
  remains the array subscript in `array` and the slot index in `index_list`).

## [0.61.1] - 2026-06-16

### Fixed
- **Column header: the label and the number-base toggle no longer overlap.** The
  per-column base toggle (`raw`/`dec`/`hex`/`bin`) was floated, so a narrow numeric column
  didn't reserve width for it and it overlapped the column name. The header now uses a flex
  layout (label on the left, toggle on the right) and the column widens to fit both.

## [0.61.0] - 2026-06-16

### Added
- **`${index}` keyword in field expressions.** A field can use `${index}` to get the
  element's index — the **array subscript** in `array` mode and the **slot index** in
  `index_list` mode (the row position in `linked_list`/`tree`). Like `${expr}`, it makes the
  expression standalone, so use it alone to show the index (`"expr": "${index}"`) or inside
  another expression to index a parallel array (`"expr": "g_names[${index}]"`).

## [0.60.4] - 2026-06-15

### Fixed
- **Tree edges now clearly enter the top of each node.** With wide cards, the tree-edge
  curves became nearly flat and read as if the line entered from the side. Tree edges are
  now drawn as org-chart orthogonal routes — straight down from the parent, horizontal at
  the mid-level, then straight down into the child's top-centre (rounded corners) — so the
  entry point is unambiguously the top at any card width.

## [0.60.3] - 2026-06-15

### Fixed
- **A `groupBy` + `mode: "tree"` section now draws a tree per group.** When a section
  combined grouping with tree mode, the graph rendered each group as a flat grid, so the
  hierarchy was lost — the root and its children appeared side by side instead of stacked.
  Each group is now laid out as its own hierarchy (root on top, children below, with the
  group header as the super-root and proper tree edges). The graph layout `kind` is now
  carried through for grouped sections so the tree layout can apply.

## [0.60.2] - 2026-06-12

### Docs
- Added graph-view screenshots to the README: a linked list rendered as a node graph
  (state colours, usage bars, arrowed edges) and a binary search tree rendered as a
  top-down hierarchy.

## [0.60.1] - 2026-06-12

### Fixed
- **Re-showing a hidden section now brings its tab back.** In the Sections menu, turning a
  section off and then on again did nothing — the tab stayed gone. The show path didn't
  rebuild the tab/pane skeleton, so the refreshed data had no place to render. Showing a
  section now rebuilds the layout first (the tab reappears, then fills with its data).

## [0.60.0] - 2026-06-12

### Added
- **Value mapping (`valueMap`).** A new per-field config that renders a raw value as a
  custom **string** and **colour**. For example, map the integer `2` to the label `XXX`
  in `#ff0000`, or `0`/`1` to `free`/`HELD` in green/red. Give a plain string to change
  just the text, or `{ "text": "...", "color": "..." }` to change both (`color` is a name
  like `green` or a `#rrggbb` hex). It applies in both the table cell and the graph card
  (where the mapped colour also tints the card's accent stripe). This is the text-changing
  superset of `badge`, which only colours.
- **Collapse all / Expand all for grouped tables.** Grouped (tree) tables now have a
  one-click **Collapse all** control in the toolbar that folds every group at once; click
  again to expand them all. The button label reflects the current state.

## [0.59.0] - 2026-06-12

### Changed
- **Graph node width is dynamic per section.** Each section sizes its cards to the widest
  field it actually contains (clamped to a sensible range), instead of one fixed width for
  every graph. Sections with short values stay compact; sections with long values get wider
  cards so text no longer clips. Cards stay uniform within a section so the grid alignment is
  preserved.
- **Tree view lays out like a tree from the start.** In the default layout, tree edges now
  leave each parent from the **bottom centre** and enter each child at the **top centre**, so
  the connections read as a proper hierarchy rather than routing out the sides on wide trees.
  Dragging a child above its parent still flips the edge to stay attached correctly.
- **Minimap matches the graph's shape.** The minimap's height now tracks the graph's
  aspect ratio (width stays fixed), so a tall graph gets a tall map and a wide graph gets a
  short one — the overview lines up with what's on the canvas instead of always being a fixed
  rectangle.

## [0.58.0] - 2026-06-12

### Changed
- **Graph edges are direction-aware.** Each edge now connects the two nodes by their
  nearest facing sides, and the arrowhead always points *into* the target from the side the
  line arrives from — and it updates live as you drag nodes around (e.g. drag a child above
  its parent and the arrow flips to point up into it). Grouped (group→member) edges keep
  their gutter routing so they still never cut through the cards in between.

## [0.57.0] - 2026-06-12

### Changed
- **Graph edges and their arrowheads now read as one object.** The arrowhead takes the
  line's colour in every state — grey at rest, purple for links, blue when highlighted —
  and they transition together (previously the line changed colour but the triangle stayed
  grey). The arrowhead is also a fixed size, so it no longer balloons when a highlighted
  line thickens.

## [0.56.0] - 2026-06-12

### Added
- **Tree data structure (`"mode": "tree"`).** Traverses a tree from its `root` by following
  child pointers (`"children": ["left","right"]` by default), and the graph view draws it as a
  proper **hierarchical tree** — root on top, children below, each parent centred over its
  subtree. (Table view lists the nodes.)
- **"Show in graph" on a table row.** Right-click a row → **Show in graph** switches that
  section to the graph view and centres/highlights the row's node.

### Changed
- **The graph canvas expands in every direction.** You can now drag nodes up and left into
  open space (the graph grows that way), and **Fit** + the minimap follow; move nodes back and
  the canvas shrinks again. (Previously nodes were pinned to the top-left origin.)

## [0.55.0] - 2026-06-12

### Added
- **Field tests in the table filter.** The per-tab filter box now accepts the same
  conditions as graph search — e.g. `PID>=3`, `state=running`, `count!=0` (operators
  `> >= < <= = !=`), combinable and mixable with plain text — not just substring matching.

### Changed
- **Graph link targets sit next to what they relate to.** Cross-section link cards used to
  pile up in a far-right column; they're now placed at the row height of the node they link
  to, so the purple links are short and easy to follow.
- **Clicking a link focuses the target node.** When the linked section is shown as a graph,
  clicking a link now centers and briefly highlights the **target node** (and works even
  when that tab is already open), instead of only flashing a table row.

(You can already choose which fields a graph node shows — hide/reorder columns via **▦ Fields**;
the first visible column is the node's title.)

## [0.54.0] - 2026-06-12

### Added
- **Right-click a graph node → "Copy row as watch expression"** (paste it into VS Code's
  Watch view), matching the table's row context menu.
- **Move a whole group in the graph.** Drag a group's header in a grouped graph and the
  entire block — label and members — moves together; the placement is remembered.
- **Incoming cross-section links.** A section's graph now also shows the relationships that
  point *to* it, not just the ones it points out — e.g. the **threads** graph shows the
  mutexes that own each thread. The **⇄ Links** toggle appears whenever a section has
  outgoing **or** incoming links, and the detail panel notes the direction.

### Changed
- **Graph cards show every visible field.** Cards used to show only the first two fields;
  now they list all of a section's visible columns (e.g. a semaphore's `Discipline`), with
  the card height adjusting per section. Hide columns via **▦ Fields** to shrink them.

## [0.53.0] - 2026-06-12

### Added
- **Field tests in graph search.** Besides plain text, the **Find** box now accepts
  per-field conditions like `count>=3`, `state=running`, or `waiters>0` — operators
  `>` `>=` `<` `<=` `=` `!=`. Combine several (they AND together, and mix with plain
  text). Numeric comparisons parse the field value; `=`/`!=` fall back to a
  case-insensitive text match.

### Changed
- **Grouped graphs pack into a balanced grid.** Instead of laying every group out in one
  long row, groups are now arranged as blocks in a roughly square grid, so a section with
  many groups stays compact and readable.

## [0.52.0] - 2026-06-12

### Added
- **Graph search/focus.** A **Find** box in the graph toolbar spotlights matching nodes
  (across the title and every shown field) and dims the rest; **Enter / Shift+Enter**
  cycle through matches, centering each, with an *n / total* counter; **Esc** clears.
- **Minimap.** A small overview sits at the bottom-left with a rectangle showing the
  current viewport — **click or drag it to navigate** a large graph. Search matches light
  up on it as a heatmap. Toggle it with **◉ Map**.

### Changed
- **Larger graphs stay responsive.** The node cap was raised, and when you zoom far out
  the cards drop their text (a level-of-detail step) so big graphs pan and zoom smoothly.

## [0.51.0] - 2026-06-11

### Added
- **Cross-section relationship links in the graph (Phase 2).** When a section has `link`
  fields, the graph toolbar shows a **⇄ Links** toggle. Turning it on draws purple
  dashed edges from each node to a compact, **deduplicated** target card representing
  the linked row in another section (e.g. a mutex's owner → the owning thread). **Click
  a target** to jump to its tab and flash the matching row. A small purple dot marks
  nodes that have outgoing links. The layer is **off by default** and node/edge counts
  are capped (with a notice) to stay responsive on large sections.

### Fixed
- **Graph edges no longer pass through node cards.** Group→member edges now route
  orthogonally through the column gutter instead of cutting straight down across the
  cards above their target.

## [0.50.0] - 2026-06-11

### Added
- **Draggable graph nodes.** Drag any card to reposition it; edges follow live, and the
  placement is remembered (keyed by the row's identity, so it survives refreshes and
  follows the row even if the underlying list reorders). Background drag still pans, a
  short click still selects — a small movement threshold tells them apart.

### Changed
- **Better default graph layout (no more single tall column).**
  - **Linked / index lists** now flow as a **serpentine grid** — cards wrap into rows
    with alternating direction, so consecutive nodes stay adjacent and the chain uses
    the width instead of growing straight down.
  - **Grouped sections** now lay out as **per-group swimlane columns** (group label on
    top, members in a compact mini-grid beneath) placed side by side, instead of one
    tall stack of members.
  - **Arrays** widen up to six columns for large sets.
  - Graph edges are now direction-aware (a horizontal curve between same-row neighbours,
    a vertical curve otherwise) for a cleaner read.

## [0.49.0] - 2026-06-11

### Added
- **Graph view for any section.** Each tab now has a **◉ Graph** toggle (next to
  **▦ Columns**) that renders the same data as an interactive node graph, so node
  details and relationships are easier to follow. Switch back any time with **▤ Table**.
  - **Linked lists** (and index lists) become a top‑to‑bottom chain, with arrows
    drawn along the `next` relationship between consecutive nodes.
  - **Grouped (tree) sections** become master group nodes on the left, each linked to
    its member cards on the right.
  - **Arrays** become a grid of cards.
  - Each card shows the row title, two fields, the state colour (left stripe + dot,
    using the same rules and config‑driven badges as the table), and a usage bar when
    the column has one configured.
  - **Hover** highlights a node and its neighbours (the rest dims); **click** selects a
    node and opens a side panel listing all of its fields. **Scroll** to zoom, **drag**
    to pan, **⤢ Fit** to recentre. View mode and zoom/pan are preserved across refreshes.
  - Very large sections cap the drawn nodes (with a visible notice); use the table view
    for the full set.

## [0.48.1] - 2026-06-11

### Changed
- Removed the help (question‑mark) cursor on the watchpoint **★** marker; it now uses
  the normal cursor (the tooltip still appears on hover).

## [0.48.0] - 2026-06-11

### Changed
- **Watchpoints use address capture — fast hardware, one register each.** Instead of
  `watch <expr>` (which makes GDB watch every pointer along a linked/grouped `->`
  expression's path, using several debug registers), the extension now resolves the
  lvalue's address once — `print $w = &(expr)` then `watch *$w` — so every watchpoint
  uses exactly **one** hardware register and stays hardware (no slow software
  single‑stepping). This is what actually fixes resuming with multiple deref
  watchpoints. Software fallback now only kicks in beyond `maxHardwareWatchpoints`.
  (Falls back to watching the expression directly if its address can't be taken, e.g.
  a bit‑field.)

## [0.47.1] - 2026-06-11

### Fixed
- **Resume failing with even two watchpoints.** A watchpoint on a pointer‑dereferencing
  expression (linked/grouped cells, `->`) makes GDB watch the whole access path,
  consuming **several** hardware debug registers — so even two watchpoints could
  exceed the 4‑register limit and abort *continue* with “Couldn't insert hardware
  watchpoints.” Such expressions (and any beyond `maxHardwareWatchpoints`, now
  default **2**) are now created as software watchpoints. (v0.47.0 only handled the
  >4 count case; this is the real fix — reproduced and verified in GDB.)

## [0.47.0] - 2026-06-11

### Fixed
- **Resuming with several watchpoints no longer fails.** Most targets (x86) have only
  4 hardware watchpoint registers; a 5th made *continue* fail with “Couldn't insert
  hardware watchpoints: you may have requested too many.” Beyond
  `debugInspector.maxHardwareWatchpoints` (default 4), new watchpoints are now created
  as **software** watchpoints (slower but unlimited), so resume keeps working.

### Added
- `debugInspector.maxHardwareWatchpoints` setting (default 4; `0` = always software).

## [0.46.3] - 2026-06-11

### Changed
- Dropped the leading ★ from the **Remove watchpoint** menu label (the cell already
  shows the star); the menu item now just reads “Remove watchpoint”.

## [0.46.2] - 2026-06-11

### Fixed
- **Watched ★ / hover now appears reliably.** The watched mark no longer depends on
  parsing the watchpoint number out of GDB's `watch` reply (which `cppdbg` doesn't
  always echo) — a cell is marked watched whenever `watch` doesn't error, and the
  GDB watchpoint number is resolved from `info watchpoints` when needed for removal.

## [0.46.1] - 2026-06-11

### Changed
- **Watched-cell hover hint.** Hovering a cell that has a watchpoint now shows
  “*value* — ★ watchpoint set (break on change)” in its tooltip, in addition to the
  ★ marker.

## [0.46.0] - 2026-06-11

### Added
- **Watched cells are starred, with a Remove option.** After **Add watchpoint**, the
  cell shows a gold **★** (plus a left accent) and its right‑click menu switches to
  **★ Remove watchpoint** (runs GDB `delete <n>`). The extension tracks each watched
  l‑value → GDB watchpoint number, broadcasts the set so the stars survive refreshes,
  and clears them when the debug session ends.

## [0.45.0] - 2026-06-11

### Added
- **Add a watchpoint from a cell.** Right‑click a plain‑member (or editable) cell →
  **Add watchpoint (break on change)** sets a GDB data watchpoint (`watch <lvalue>`)
  on that field, so the program stops when the value changes. It doesn't write
  memory; remove it from the GDB session / Breakpoints view when done. Offered only
  for fields that are real l‑values (not computed/wrapped expressions). The stable
  l‑value works in every mode incl. grouped sections.

## [0.44.0] - 2026-06-11

### Added
- **Copy a row as a watch expression.** Right‑click a row → **Copy row as watch
  expression** copies the row's stable element expression (e.g. `(g_mutexes)[5]`,
  `g_process_list->next->next`, or the `${master}`‑qualified path for grouped
  sections) to the clipboard, ready to paste into VS Code's **Watch** panel. VS Code
  exposes no API to add a watch entry programmatically, so this is a copy‑and‑paste
  helper rather than a direct add.

## [0.43.2] - 2026-06-10

### Changed
- **Faster cancellation when resuming mid‑refresh.** A superseded refresh (you
  continued, or hit a new breakpoint) now aborts at the **row/group level** — not
  just between sections — so it stops issuing GDB reads to a now‑running target
  almost immediately, releases the GDB lock, and the fresh refresh for the new stop
  starts sooner. Stale results were already discarded; this just stops the wasted
  work quicker.

## [0.43.1] - 2026-06-10

### Fixed
- **No more transient ⚠ errors while a tab loads.** A targeted fetch (revealing a
  tab, showing a column, or an edit re-read) could overlap the on‑stop refresh;
  both shared the same GDB convenience cursors (`$ri_*` / `$rg_*`), so one clobbered
  the other mid‑traversal and some cells briefly resolved to GDB errors before the
  clean pass corrected them (most visible on grouped tabs like *semaphores*). GDB
  fetch operations are now **serialized through a mutex** so they never interleave.

## [0.43.0] - 2026-06-10

### Changed
- **Clearer “cannot access” indicator.** A value GDB can't read (`No symbol …`,
  `cannot access memory`, `optimized out`, or an evaluation error) now renders as a
  distinct red **⚠** with the cleaned GDB error in its tooltip — visually separate
  from a **NULL** pointer (`0x0`), which stays a plain muted `-`. (Previously both
  looked the same.) Errors are still logged to the Output channel.

## [0.42.2] - 2026-06-10

### Fixed
- **Panel closes when the debug session ends.** Previously the panel lingered with
  stale data (and a possibly-spinning indicator) after the inspected session
  terminated; it now closes automatically (`onDidTerminateDebugSession`) and resets
  its state.

## [0.42.1] - 2026-06-10

### Fixed
- **Stale-refresh cleanup when stepping fast.** Rapid step/continue already cancels
  superseded refreshes and runs only the latest (debounce + generation guard). Now,
  when the program resumes mid‑refresh, the per‑tab “updating” spinners are also
  cleared (previously only the Refresh button was), so no spinner lingers while
  running.

## [0.42.0] - 2026-06-10

### Added
- **Per-tab update status during refresh.** Each section's tab now shows a small
  spinning **⟳** while its data is still being fetched, clearing the instant that
  section arrives — so you can see which sections have updated and which are still
  queued (the active tab is fetched first). Manual **Refresh** uses the same
  prioritized streaming; the Refresh button shows the overall state.

## [0.41.1] - 2026-06-10

### Changed
- **Edit value applies instantly.** After you confirm an edit, the cell updates
  immediately with the entered value (optimistic), while the row re-reads in the
  background to recompute any dependent (`when`/`bar`/computed) cells. Removed a
  redundant `stackTrace` round-trip per edit (the stop's frame is already cached).
  Grouped sections now also tag rows with a flat source index, so instant updates
  work there too. (The input box is intentional — editing writes to the running
  program.)

## [0.41.0] - 2026-06-10

### Fixed
- **Editing a value in a grouped or linked-list section now writes the correct
  field.** The edit l-value was built from the traversal cursor (a `$ri_*` / `$rg_*`
  GDB convenience variable), which is NULL/stale after the walk — so editing e.g. a
  semaphore's `count` changed nothing (it targeted the cursor). The l-value is now a
  **stable element expression**: `root->next^i` for linked lists (with `${master}`
  substitution for grouped sections), and `((cast)root)[i]` / `base[idx]` for arrays
  and index lists (those were already correct).

### Added (tests)
- A GDB-driven **edit-write test** that verifies `set var <l-value>` actually
  changes the field for **every mode** — array, array+cast, index_list, linked_list,
  grouped-linked and grouped-index — plus sort-vs-edit row-identity checks. Wired
  into a single pre-release suite (`run-all-tests.ps1`: tsc + webview + parser-vs-GDB
  + edit) that is run before every version.

## [0.40.1] - 2026-06-10

### Added
- **Refresh button progress feedback.** The **Refresh** button now spins its icon
  and reads **“Refreshing…”** while a refresh is in progress (manual, on-stop, or
  config), and returns to **“Refresh”** when it finishes — so it's clear whether
  data is still loading. A 4 s fallback clears it if no refresh actually runs
  (e.g. the debugger isn't stopped).

## [0.40.0] - 2026-06-10

### Changed (performance)
- **Config saves only re-fetch when the data is actually affected.** Saving the
  config file no longer always re-reads everything from GDB. The extension compares
  a **data fingerprint** (mode/root/next/head/nil/count/access/cast/wrap/groupBy/
  max/label + each field's expr/wrap/when/bar.max/editable/hidden + tab order &
  visibility). If only **presentation** changed — a column's `base`, a `bar`'s
  `warn`/`crit`, a `link`, or `badge` colors — it's applied **client-side with zero
  GDB round-trips**; otherwise a normal (prioritized) refresh runs.

## [0.39.0] - 2026-06-10

### Changed
- **Edit value updates only that row.** After right-click → **Edit value…**, only
  the edited row is re-read and refreshed (recomputing that row's `when`/`bar`/
  computed cells), instead of refreshing the whole panel. `array` and `linked_list`
  rows are re-fetched by position (a single element); `index_list` and grouped
  sections fall back to a single-section refresh.

## [0.38.1] - 2026-06-10

### Added
- **“Loading…” placeholder.** While the prioritized streaming refresh is still
  fetching, sections whose data hasn't arrived yet — and newly revealed sections —
  show a pulsing **“Loading…”** placeholder (with a `…` tab count) instead of an
  empty pane, so it's clear they're queued rather than empty.

## [0.38.0] - 2026-06-10

### Changed (performance)
- **Prioritized streaming refresh.** On each stop the **active tab is fetched and
  shown first**, then the remaining visible sections stream in **in the background**,
  one section at a time. **Switching tabs re-prioritizes** — the section you switch
  to jumps the queue and is fetched next. Cross-section links on the active tab
  resolve once their target sections arrive. Replaces the previous
  fetch-all-then-render-once approach, so large multi-tab workspaces become
  interactive almost immediately.

## [0.37.0] - 2026-06-10

### Changed (performance)
- **Targeted lazy fetch.** Showing a hidden column now re-reads **only that field**
  (merged into the existing rows by position); revealing a hidden section fetches
  **only that section** — instead of refreshing the whole panel. Grouped sections
  rebuild just their master plus the affected group. If a column patch can't be
  aligned to the current rows, it safely falls back to a full refresh.

## [0.36.1] - 2026-06-09

### Fixed
- Removed a stale bundled `rtos-inspector.json` example from the package (left over
  from the rename). The README documents the config and the runnable demo lives in
  `test-workspace/`.

## [0.36.0] - 2026-06-09

### Added
- **Export all data as JSON.** A new **⤓ JSON** button in the top bar (next to
  ▤ Sections) exports every visible section's rows to a JSON file via a save
  dialog — grouped sections are nested by group. Per‑tab Copy CSV / Copy MD remain.

## [0.35.0] - 2026-06-09

### Added
- **Config-driven badge colors (`badge`).** A field can map values to colored
  badges — `{ "RUNNING": "green", "BLOCKED": "red", "2": "amber", … }` — using color
  names (`green`/`blue`/`red`/`amber`/`orange`/`purple`/`cyan`/`gray`) or a
  `#rrggbb` hex (case‑insensitive exact match). This overrides the built‑in `State`
  coloring and works for custom or **numeric** states. The demo's `threads` `State`
  uses it (READY shown cyan).

## [0.34.1] - 2026-06-09

### Changed
- Point `homepage` / `repository` / `bugs` and the README image at the renamed
  GitHub repository **`nothing-githb/debug-inspector`**.

## [0.34.0] - 2026-06-09

### Changed (renamed to the "Debug Inspector" name)

The display name was already **Debug Inspector**; the remaining `rtos-inspector` /
`rtosInspector` identifiers are now renamed to match:

- Extension id: **`debug-inspector`** (was `rtos-inspector`).
- Commands and settings namespace: **`debugInspector.*`** (was `rtosInspector.*`)
  — `debugInspector.configPath` / `debugInspector.logLevel` / `debugInspector.debugTypes`.
- Default config file: **`debug-inspector.json`** (was `rtos-inspector.json`).

**Migration:** rename your config file to `debug-inspector.json` (or point
`debugInspector.configPath` at it) and update any `rtosInspector.*` keys in your
`settings.json` to `debugInspector.*`. The GitHub repository URL is unchanged.

## [0.33.0] - 2026-06-09

### Changed
- **Docs & discoverability.** The README now covers every feature and gives a
  JSON example for each per‑column option (computed `${expr}`, `base`, `bar`,
  `link`, `when`, `editable`, `hidden`, field `wrap`), and shows a representative
  panel image. Expanded Marketplace keywords (freertos / zephyr / threadx /
  microcontroller / firmware / inspector / …). No functional change.

## [0.32.1] - 2026-06-09

### Fixed
- **Batch parser:** a string field value **ending in a backslash** (e.g. a Windows
  path `"C:\\"` or a regex) is now closed correctly, so the following fields are no
  longer swallowed — batched values stay byte‑identical to per‑field reads. (The
  only real feature‑parity regression from 0.32.0; found by an adversarial audit
  and covered by a regression test.)

## [0.32.0] - 2026-06-08

### Changed (performance)
- **Per‑element batch fetch.** When a section has ≥2 plain member fields, each row
  is now read with **one** `print *elem` (or `print elem`) and parsed client‑side,
  instead of one `print` per field — **~5× fewer GDB round‑trips per row**
  (measured: array **5.1×**, linked list **3.8×** in raw GDB; far more over the
  debug adapter). Computed `${expr}`/`${wrapped_expr}`, `cast`/`wrap` (section and
  field), `when`, `bar.max`, and any value the parser can't extract **fall back**
  to a per‑field `print`, so every feature behaves exactly as before. Validated
  against real GDB output for value structs, pointer nodes, and char‑array members
  (batched values are byte‑identical to per‑field). See `docs/PERFORMANCE.md`.

## [0.31.0] - 2026-06-08

### Changed (performance)
- **Stateless linked‑list walk.** Merged the per‑node null‑check `print $cursor`
  and the `set $cursor = $cursor->next` advance into a single
  `print $cursor = $cursor->next` — **one fewer GDB round‑trip per node**
  (24,001 → 22,001 commands on the 2000‑node benchmark; the saving scales with
  list length over the debug adapter).
- **`frameId` cached per stop** — config / edit / manual refreshes no longer issue
  a `stackTrace` round‑trip.
- **Hot‑path trimmed** — `gdbExec`'s whitespace‑collapse + failure‑regex now run
  only when logging is on; plus a one‑time `set print pretty off` +
  `set max-value-size unlimited` per session.

See `docs/PERFORMANCE.md` for the measured before/after (real GDB 15.2 numbers).

## [0.30.2] - 2026-06-08

### Changed
- Removed the automatic **amber** styling of `Waiting > 0` cells (matching the
  earlier `Count = 0` change). Changed‑cell highlighting and state badges are
  unaffected.

## [0.30.1] - 2026-06-08

### Changed
- A **`link` field links only when a matching row exists** in the target section,
  so `0` / "none" values (e.g. a free mutex's `Owner = 0`) stay plain text instead
  of dead links.
- Removed the automatic **red** styling of `Count = 0` cells.

## [0.30.0] - 2026-06-08

### Changed
- **Refresh is debounced and cancels superseded runs.** Saving the config many
  times quickly (or fast stepping) no longer piles up refreshes: requests within
  ~140 ms collapse to one, an in‑flight refresh never runs concurrently, and a
  newer request **aborts the older one between sections** so only the **latest**
  runs to completion. Resuming the program cancels a pending refresh.

### Added
- **Per-field `wrap` (post-access transform).** A field can `"wrap"` its value
  *after* access — `${expr}` is the accessed field value — e.g. `"expr": "data"`
  with `"wrap": "((widget_t *)${expr})->x"`. Lets each column reinterpret an
  untyped member differently (variant payloads), distinct from the section‑level
  `wrap`. The demo's `boxes` tab now uses a field `wrap`.

## [0.29.0] - 2026-06-08

### Added
- **Edit values (opt-in).** Right-click a cell → **Edit value…** to change it in
  the running program (GDB `set var`). Only fields marked **`"editable": true`**
  are editable (assignable L-values; the exact write target is captured at fetch
  time so it's correct in every mode). The cell context menu also offers **Copy
  cell**. The demo's `mutexes` `Locked` is editable — toggling it flips the
  conditional Owner / Waiting columns on the next refresh.

### Changed
- Clarified the read-only stance: **read-only by default**; writing happens only
  for fields you explicitly opt into with `"editable": true`.

## [0.28.0] - 2026-06-08

### Added
- **Conditional fields (`when`).** A field can set **`"when": "<bool expr>"`**
  (evaluated on the element, `${expr}`/`${wrapped_expr}` supported). When the
  condition is false the cell stays **blank** and isn't fetched. Put several
  `when` fields on one discriminator for **tagged‑union / variant** rows — e.g.
  show `Owner` only when a mutex is **locked**, otherwise `Waiting`. *(Conditional
  values were already possible via a GDB ternary in `expr`.)* The demo's `mutexes`
  tab shows Owner ⇄ Waiting by `locked`.

## [0.27.0] - 2026-06-08

### Added
- **Cross-reference links.** A field can declare
  **`"link": { "section": "<target>", "match": "<column>" }`** to render its value
  as a clickable link to another object. Clicking switches to the target section
  and highlights the row whose `match` column equals the value (expanding a
  collapsed group, or revealing a hidden tab, as needed). `match` defaults to the
  target's first column. The demo's `mutexes` tab links **Owner → the owning thread**
  in `threads`.

## [0.26.0] - 2026-06-08

### Added
- **Computed field expressions.** A field's `expr` (and a `bar`'s `max`) may now
  reference the element via **`${expr}`** (raw) / **`${wrapped_expr}`** (after
  `cast`/`wrap`) — the same placeholders as `wrap` / `next`. This enables
  arithmetic across **two members**, e.g. free stack as
  `"${expr}->stack_size - ${expr}->stack_used"`. Without a placeholder, `expr` is
  still appended after the element exactly as before. The demo's `threads` tab
  adds a computed **Free** column.

## [0.25.3] - 2026-06-08

### Fixed
- The top-bar **"N changed"** badge now counts only **visible (open) sections**.
  Hiding a section recomputes it so a hidden section's changes drop out of the
  total; the per-tab "changed" markers are also restored after a reorder/hide.

## [0.25.2] - 2026-06-08

### Fixed
- Hiding or reordering a section **no longer zeroes the other tabs' count
  badges**. The client-side relayout rebuilt the tab strip (counts start at 0) but
  only repainted tables; it now restores each visible tab's count from cache.

## [0.25.1] - 2026-06-07

### Changed
- Moved the **▦ Columns** button to the left of **⧉ CSV** / **⧉ MD** in the table
  toolbar.

## [0.25.0] - 2026-06-07

### Changed
- **Reordering and hiding sections (tabs) is now instant.** It no longer triggers
  a full GDB re-read of every section — the panel reorders/hides client-side from
  cached data, exactly like columns. Only *showing* a previously-hidden section
  refetches (it had no data while hidden).

### Added
- **Drag-to-reorder rows inside the ▤ Sections menu** (with grips), like the
  Columns menu — in addition to dragging the tabs themselves.

### Fixed
- **Section order no longer scrambles** when you hide / show / reorder. Order is
  now one interleaved list end-to-end, so hidden sections keep their place and a
  re-shown section returns to its slot instead of jumping to the end. Hiding the
  active tab now focuses a neighbor instead of the first tab.

## [0.24.1] - 2026-06-06

### Added
- A section can set **`"hidden": true`** in config to start its tab hidden (show
  it later from the ▤ Sections menu). The config default applies until you change
  section visibility in the UI, after which your choice is remembered. The demo's
  `boxes` section starts hidden.

## [0.24.0] - 2026-06-06

### Added
- **Show / hide / reorder sections (tabs).** A new **▤ Sections** button in the
  top bar lists every section with a checkbox to hide or show it, and you can
  **drag a tab** to reorder. Both are remembered per workspace (hidden sections
  aren't fetched until shown again).

### Changed
- The **▦ Columns** button moved out of its own strip into each table's toolbar,
  next to **⧉ MD** (the columns menu opens beneath it).

## [0.23.2] - 2026-06-06

### Fixed
- In a grouped (tree) section, **collapsing a group made the whole group —
  including its header — disappear** and it couldn't be re-expanded. `applyFilter`
  was hiding any group header with no visible rows beneath it, which also caught
  collapsed groups (whose rows aren't rendered). It now keeps a collapsed group's
  header visible and only hides a group when an active filter / changed-only
  removes all of its rows.

## [0.23.1] - 2026-06-06

### Fixed
- The **sorted column was nearly invisible in dark themes** (the header text was
  recolored to a dim `focusBorder`). The sorted header now keeps full-contrast
  text on a blue tint, the sort arrow is a fixed bright blue, and the sorted
  column's cells get a subtle blue highlight.

## [0.23.0] - 2026-06-06

### Added
- **Usage bars.** A field can set **`"bar"`** to render its value as a horizontal
  usage bar — `used / max · NN%` with green → amber → red thresholds. `bar.max` is
  a sibling expression (e.g. `stack_size`) or a constant; `warn` / `crit` set the
  percent thresholds (default 75 / 90). The demo's `threads` tab shows per-thread
  **stack usage** (`stack_used` / `stack_size`).

### Changed
- **Column headers are more visible** — full-contrast text on a header-tint
  background with a 2px blue underline; the sorted column's title is blue.

## [0.22.3] - 2026-06-06

### Changed
- The header base button now cycles **raw → bin → dec → hex** and shows a clearer
  label — `raw` / `bin` / `dec` / `hex` (uppercased in the header) instead of
  `#` / `2` / `10` / `16`.

## [0.22.2] - 2026-06-06

### Changed
- The header base picker is now a **single click-to-cycle** button showing the
  current base (`#` raw / `10` / `16` / `2`); each click advances raw → dec → hex
  → bin → raw — instead of three separate `10 / 16 / 2` options.

## [0.22.1] - 2026-06-06

### Changed
- The per-column number base is now chosen from a **`10 / 16 / 2`** selector in
  the **column header's top-right** (dec / hex / bin; the active one is
  highlighted, click it again to reset to raw) — instead of a button in the ▦
  Columns menu. Quicker and visible at a glance.

## [0.22.0] - 2026-06-06

### Changed
- **Number base is now per-column** (was a single per-tab toggle). Cycle any
  numeric column through **dec → hex → bin → raw** from the ▦ Columns menu (the
  header shows a small base tag), and set a default in config with a field's
  **`"base": "dec"|"hex"|"bin"`**. **Binary** is new. The demo's `widgets` shows
  `X` in hex and `Y` in binary.

## [0.21.0] - 2026-06-06

### Removed
- **Master-detail (`${selected}`).** Relate sections with **grouping**
  (`groupBy` + `${master}`) instead — it shows every parent (and its children) at
  once in one tab, with no row to click. The `${selected}` placeholder,
  click-to-select, and the `selectMaster` plumbing were removed.

### Added
- A field may set **`"hidden": true`** to start collapsed and **unfetched**
  (enable it later from the ▦ Columns menu). Applied only when there is no saved
  column preference for that section.

### Changed
- Example config drops the `${selected}` `threads`/`mutexes` tabs; the demo `pool`
  gains a default-hidden `Next` column.

## [0.20.2] - 2026-06-06

### Fixed
- **Panel rendered nothing (blank, no data).** The table-toolbar code added in
  0.20.0 contained regex/string literals whose backslash escapes were stripped by
  the webview's HTML *template literal*: `/[",\n]/` and the `'\n'` joins in the
  CSV/Markdown copy became an invalid regex / unterminated string, so the entire
  webview script failed to compile and nothing rendered. Escaped them
  (`\\n`, `\\d`, `\\s`, `\\(` …) and also repaired the silently-degraded
  `isNumStr` / `isNullPtr` / whitespace regexes. Verified by compiling and
  executing the webview against mock data.

### Changed
- Example config no longer uses `${selected}` master-detail; all relationships
  use grouping (`groupBy` + `${master}`), so every section populates on each stop
  without clicking a row.

## [0.20.1] - 2026-06-06

### Fixed
- Reverted two 0.20.0 CSS changes that could distort the panel layout: the
  per-cell `max-width`/ellipsis and the document-level sticky first column. The
  filter box, changed-only toggle, number-base toggle, Copy CSV/MD, numeric
  right-alignment, and full-value cell tooltips are unchanged. (A robust frozen
  first column will return later via a dedicated scroll container.)

## [0.20.0] - 2026-06-06

### Added
- **Per-tab table toolbar:**
  - **Filter box** — live-filter rows by text across visible columns; focus is
    preserved while typing, and grouped tabs hide groups that become empty.
  - **Changed-only** toggle — show only rows that changed since the last stop.
  - **Number base** toggle — render numeric/hex columns as raw → decimal → hex.
  - **Copy CSV / Copy Markdown** — copy the (filtered) table to the clipboard
    (grouped tables include a leading `Group` column).
- **Frozen first column** on horizontal scroll (the header already stuck on
  vertical scroll).
- Numeric/hex columns are **right-aligned** with tabular figures; long cells are
  ellipsized with the **full value shown in a tooltip**.

## [0.19.3] - 2026-06-06

### Changed
- Fixed-size `char` arrays are now shown only up to the first `\0`. GDB renders
  the whole buffer (`"abc\000\000"` or `"abc", '\000' <repeats N times>`); the
  trailing NULs / repeat counts are dropped, and an all-NUL array shows as `""`.
  Applied at read time, so sorting/summaries/change-detection see the clean
  string. The demo's `pool` gains a `Tag` (`char[8]`) column.

## [0.19.2] - 2026-06-06

### Added
- New **`${wrapped_expr}`** placeholder for the `index_list` `next` template — the
  element **after** `cast`/`wrap` (vs `${expr}`, the un-wrapped element). Lets the
  `next` template reuse the wrap-cast without rewriting it, e.g. with
  `wrap: "((node_t *)${expr})"` you can write `"next": "${wrapped_expr}->nxt"`.

## [0.19.1] - 2026-06-06

### Changed
- In the `index_list` `next` template, `${expr}` now resolves to the
  **un-wrapped** element — the same `${expr}` that `wrap` receives — so the
  placeholder means the same thing in both places. (Previously `next`'s `${expr}`
  was the post-`wrap` element.)

## [0.19.0] - 2026-06-06

### Added
- **`index_list` `next` accepts a `${expr}` template** (like `wrap`). When `next`
  contains `${expr}` (the element), the next index is computed from that template
  instead of the default `element<access>next` — enabling non-suffix next-index
  expressions such as `"${expr}.link.idx"` or a lookup `"g_succ[${expr}.id]"`.
  Backward compatible (plain field names work unchanged). The demo's `procSlots`
  now uses `"next": "${expr}.next"`.

## [0.18.4] - 2026-06-06

### Other
- Reworked both READMEs (root + Marketplace) to be more detailed yet clearer and
  more scannable: a complete config-schema table, a per-mode walkthrough,
  master–detail vs. grouping, `cast`/`wrap`/field-hop and placeholder semantics,
  a settings table, and a logging/troubleshooting guide. Documentation only;
  every claim verified against the source.

## [0.18.3] - 2026-06-06

### Other
- Documented and demoed a **pre-cast field hop**: when each array slot is a
  `{ void *data; }` wrapper, reach the data field inside `wrap` before casting —
  `"wrap": "((widget_t *)(${expr}.data))"` → `((widget_t *)(box[i].data))->field`.
  The demo gains a `boxes` section. (No engine change — `wrap` already supports
  this.)

## [0.18.2] - 2026-06-06

### Fixed
- The `wrap` output is now wrapped in parentheses before the field access is
  appended (`(wrap)<access>field`). This prevents operator-precedence mis-parsing
  for a `wrap` that dereferences — e.g. `"wrap": "*(${expr})"` now yields
  `(*(elem)).field` instead of `*(elem).field` (which C parses as
  `*((elem).field)`).

## [0.18.1] - 2026-06-06

### Fixed
- When substituting `${master}` / `${selected}`, the value is now the master's
  **fully-processed element** — its `cast` and `wrap` applied — matching how the
  master reads its own fields. Previously the raw `(root)[i]` / `root->next` was
  used, so a master stored behind a `void*` (needing a `cast`/`wrap`) produced
  invalid child expressions.

## [0.18.0] - 2026-06-06

### Added
- `${master}` (grouping) and `${selected}` (master–detail) placeholders now
  resolve in a section's **`head`**, `count`, and `nil` too — not just `root`. An
  `index_list` can therefore start its walk at a per-parent head, e.g.
  `"head": "${master}->slot_head"`. Master–detail detection also triggers when
  `${selected}` appears only in `head`/`count`. The demo gains a grouped
  `procSlots` index-list (each process walks its own chain via
  `${master}->slot_head`).

## [0.17.2] - 2026-06-06

### Changed
- The Output channel is now rendered with VS Code's built-in **`log`** syntax, so
  timestamps, severities (`INFO`/`DEBUG`/`WARN`/`ERROR`), and quoted values are
  **color-coded** by the theme. Lines are formatted as
  `YYYY-MM-DD HH:MM:SS.mmm [LEVEL] message`.

## [0.17.1] - 2026-06-06

### Changed
- Selectable log levels reduced to **off / info / debug**. `info` shows
  milestones plus warnings/errors; `debug` folds in the former trace-level
  per-step traversal detail.

## [0.17.0] - 2026-06-06

### Added
- **`rtosInspector.logLevel` setting** — choose the Output channel verbosity
  (`off`/`error`/`warn`/`info`/`debug`/`trace`) from settings; applied live on
  change. (Replaces reliance on the VS Code log-level gear.)

### Changed
- **More detailed, leveled logging.** At `debug`, each section logs its resolved
  traversal: the element expression and the **next-access** expression
  (`linked_list` → `cursor->next`; `index_list` → `root[idx].next`; `array` →
  element/access). At `trace`, every traversal **step** is logged — for
  `index_list` each hop shows `idx → next [ root[idx].next ] = "v" → idx N`, and
  `linked_list` logs each node's cursor and advance. Stop reasons (NULL / nil /
  cycle / max) are logged too.

## [0.16.0] - 2026-06-06

### Added
- **`index_list` traversal mode.** Walk a list that lives inside an array and is
  linked by an *index* field (not a pointer): start at `head` (an index
  expression), read `root[idx]`, then follow `next` (the next index) until it
  equals `nil` (default `-1`). Unused/empty slots are skipped. Supports
  `access`/`cast`/`wrap` like array mode; a visited-set + `max` guard against
  cycles. The demo gains a `pool` section (chain `0 → 2 → 5`, slots 1/3/4 empty).

## [0.15.1] - 2026-06-06

### Changed
- Cells whose value is **unreadable** (GDB could not access the address / errored)
  or a **NULL pointer** (`0x0`) now display as a muted `-`. A plain integer `0`
  is left as-is (so e.g. `Count = 0` still shows its red highlight). Raw values
  are unchanged underneath, so sorting/summaries/change-detection still work.

## [0.15.0] - 2026-06-06

### Added
- **Grouping (tree view).** A section can set `"groupBy": "<masterSection>"` and
  use `${master}` in its `root` to render — in its **own tab** — as a tree
  grouped under each master element (e.g. semaphores grouped under each process).
  The master's `label` expression titles each node; nodes are collapsible and a
  **Flat view** toggle switches to an ungrouped list. Distinct from master–detail
  (`${selected}`), which drives separate detail tabs from the selected row.

## [0.14.1] - 2026-06-06

### Changed
- Lowercased the publisher id to `halistahasahin` (matches the Marketplace
  publisher; it was uppercase in the manifest).

## [0.14.0] - 2026-06-06

### Changed
- Renamed the display name to **Debug Inspector** (the extension id
  `rtos-inspector`, command/settings namespaces and config file name are
  unchanged).
- New icon: rows with status dots plus a magnifier.

## [0.13.2] - 2026-06-06

### Changed
- `cast` is no longer auto-suffixed with ` *`. Write the cast **in full**
  (e.g. `"cast": "widget_t *"`) → `((cast)(root))[i]`. This avoids a double
  pointer and composes for any type.

## [0.13.1] - 2026-06-06

### Changed
- `wrap` is now a **section** option that wraps the **element** (cast + index, or
  the linked-list node) *before* field access — instead of wrapping the whole
  field expression. This lets a `void*` element be cast first, e.g.
  `"wrap": "((widget_t *)${expr})"` with `"access": "->"` →
  `((widget_t *)(slots[i]))->field`. The demo gains a `void*` pointer-array
  `slots` section. (Supersedes the per-field `wrap` introduced in 0.13.0.)

## [0.13.0] - 2026-06-06

### Added
- **Per-field `wrap` template.** Post-process the generated access expression
  with a `${expr}` placeholder — e.g. `"wrap": "*(${expr})"` dereferences a
  pointer field (`a[5].id` → `*(a[5].id)`). The demo's widgets array gains a
  dereferenced `X*` column.

### Changed
- Logging levels clarified: **`debug`** logs every prepared GDB access string;
  **`trace`** logs each result; GDB access failures are logged as **warnings**
  (visible at `info`, which otherwise shows only milestones and errors).

## [0.12.1] - 2026-06-06

### Changed
- `rtosInspector.configPath` now accepts an **absolute path** (used as-is, and
  works even with no workspace folder open); relative paths still resolve against
  the workspace root. The file watcher follows the absolute path too.

## [0.12.0] - 2026-06-06

### Added
- **`cast` field for array sections.** Set `"cast": "T"` to read a generic
  `void*` buffer as an array of `T`: the element access becomes
  `((T *)(root))[i]`. Useful for dynamic-array containers that store elements
  behind a `void *data` + `size`. The demo gains a `widgets` dynamic array.

## [0.11.0] - 2026-06-06

### Added
- **Leveled logging** to an *Debug Inspector* Output channel
  (trace / debug / info / warn / error). Pick the level from the Output panel's
  gear or via "Developer: Set Log Level…". At `trace`, every GDB command and its
  result is logged; `debug` shows section/column/selection activity. A new
  command **"Debug Inspector: Show Log"** opens the channel.

## [0.10.0] - 2026-06-06

### Added
- **Master–detail sections.** A section whose `root` contains `${selected}`
  becomes a *detail* table. Clicking a row in a master section resolves
  `${selected}` to that element and re-fetches the detail sections — e.g. click a
  process to see *its* thread / semaphore / mutex lists. The first master row is
  auto-selected; the selected row is highlighted.

### Other
- The bundled demo is now process-based: two processes, each with its own
  thread/semaphore/mutex lists, plus an independent timer array — to showcase
  master–detail.

## [0.9.2] - 2026-06-06

### Changed
- While dragging a column (header or Columns-menu row), a clear blue **preview
  chip** with the column name now follows the cursor, replacing the browser's
  faint default drag image.

## [0.9.1] - 2026-06-06

### Changed
- Change highlighting now shows the **previous value faded (struck-through)**
  next to the new value, instead of a ▲/▼ direction arrow.

## [0.9.0] - 2026-06-06

### Added
- **Pause / Resume** toolbar button. When paused, the panel no longer
  auto-refreshes (or queries GDB) on each stop — useful when you don't need it
  always on. The **Refresh** button still does a one-shot update, and the choice
  persists per workspace.

### Changed
- Drag-to-reorder drop indicators are now a bolder **blue** line with a light
  blue tint (both column headers and the Columns menu), so the drop position is
  much clearer.

## [0.8.0] - 2026-06-06

### Changed
- **Clearer column reordering.** Dragging a column header now shows a blue
  insertion line on the target column so you can see where it will land. In the
  ▦ Columns menu, rows are draggable (with a ⠿ grip) and show a drop line while
  dragging — the up/down arrow buttons were removed in favor of drag-to-reorder.

## [0.7.0] - 2026-06-06

### Changed
- **Any number of sections.** The config is now a map of named sections; each
  becomes its own dynamically-generated tab/table — `threads`, `semaphores`,
  `mutexes`, `queues`, or any name you choose. Column styling is applied by
  column name, so it works for any structure. (Previously limited to two fixed
  `threads`/`semaphores` sections.)

### Other
- The bundled `test-workspace` example gains a third structure (a mutex list) to
  demonstrate multiple sections.

## [0.6.0] - 2026-06-06

### Added
- **Drag-and-drop column reorder.** Drag a column header to move it (the ↑/↓
  menu buttons remain for keyboard/discoverability).
- **Right-click a column header** to open the columns menu at the cursor for
  quick show/hide.

## [0.5.0] - 2026-06-06

### Added
- **Column show/hide and reorder.** A "▦ Columns" menu per tab lets you toggle
  which columns are visible and move them up/down. Preferences persist per
  workspace.

### Changed
- **Hidden columns are no longer fetched from GDB.** Only visible columns issue
  `print` commands; enabling a column fetches its data on the spot (when stopped).

## [0.4.0] - 2026-06-06

### Added
- **Change highlighting.** When the panel refreshes at a new stop, cells whose
  value changed since the previous stop are highlighted (amber), numeric values
  get a ▲/▼ direction arrow, a "N changed" badge appears in the toolbar, and a
  tab that changed while not focused gets its count badge highlighted. Rows are
  matched by their first column (e.g. ID).

## [0.3.0] - 2026-06-05

### Added
- **Refresh** button in the panel toolbar that re-reads `rtos-inspector.json` and
  re-collects the data without continuing/restarting the debugger.
- Automatic refresh when the config file changes on disk (file watcher bound to
  the resolved `rtosInspector.configPath`), while the debugger is stopped.

## [0.2.0] - 2026-06-05

### Added
- Click a column header to sort the table by that column; click again to toggle
  ascending/descending. Numeric and hex values sort numerically, text sorts
  alphabetically. The active column shows a ▲/▼ indicator and the sort choice
  is preserved across debugger stops.

## [0.1.0] - 2026-06-05

### Added
- Initial public release.
- Config-driven (`rtos-inspector.json`) inspection of custom thread and semaphore
  structures during GDB (`cppdbg`) debugging.
- Two traversal modes: `linked_list` (head pointer + `next` field) and `array`
  (`count` elements, with `.`/`->` element access).
- Arbitrary `root` expressions (e.g. `g_kernel.pools[0]->thread_list`).
- Tabbed Webview panel with colored state badges, depleted/waiter highlighting,
  and per-tab summaries.
- Live refresh on debugger `stopped`/`continued` events.
- Settings: `rtosInspector.configPath`, `rtosInspector.debugTypes`.
