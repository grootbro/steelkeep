# Interface quality pass

Scope: preserve Steelkeep's original PNG brand, Inter, Milk/Graphite/Violet and
Databasement operational composition while fixing everyday interaction defects.
No runtime or browser runs on the owner's Mac. Source work stays uncommitted until
the Drive release is merged; production publication belongs to the root release.

| User criterion | Current evidence / defect | Planned completion | Status |
| --- | --- | --- | --- |
| Resize and collapse desktop navigation | Fixed 250/220/200px sidebar, no user control | Bounded pointer/keyboard separator, persistent width, icon rail | Source implemented; remote proof pending |
| Owner/avatar/theme/logout on one row | `.app .sidebar-bottom{display:block}` moves utilities below owner | Aligned footer with one theme icon | Source implemented; remote proof pending |
| Civilized dialog scrolling | Native dialog focus/Escape exists; background body is not locked and dialog scrolls as a whole | Shared nested-safe body lock; fixed header and one scrolling body; restore prior state | Source implemented; remote proof pending |
| Internal navigation without full refresh | Ordinary anchors remain in plan hints and Drive success notices | TanStack Link for app routes; preserve downloads, external links and local fragment anchors | Source implemented; remote proof pending |
| One first-load experience | AuthLoading then separate Connecting spinner | Reuse shared auth/workspace loader, retain actionable errors | Source implemented by parallel appearance/auth slice; remote proof pending |
| Dark theme on first paint | Preference applied after mount | Prepaint preference with hydration-safe initial state | Source implemented by parallel appearance/auth slice; remote proof pending |
| Dropdown clarity | Filters use 34/37/38px heights and narrow horizontal padding | Consistent compact control height and arrow clearance; long labels ellipsize | Source implemented; remote proof pending |
| Responsive polish | Drive header overflow fixed in `23131af`; modal captured at390/1440 | Preserve mobile drawer, check intermediate widths and long scroll | Remote verification pending |

## Verification to perform remotely

Use the real compiled application and actual synthetic owner authentication.
Capture desktop, tablet and mobile in light/dark; inspect exact document width,
first painted theme, dialog and page scroll positions, focus/Escape/return,
keyboard and pointer resize/collapse persistence, in-app navigation without a new
document, native select dimensions and long option labels. Report mocked provider
boundaries separately from real backup/restore acceptance. No new dependencies.

The prior Drive-only proof (`45213914585`) qualified its earlier interface at
1440px and390px in both themes, including seven connection requests, one scrubbed
claim and two same-key import requests. It does not qualify this later UI pass.

## Source checkpoint

Desktop navigation is now a shared Sidebar with a220–340px pointer/keyboard
separator, saved width and an accessible72px icon rail. Mobile retains its drawer.
The owner row aligns avatar/account, theme and sign-out without a second toolbar.
Common Modal instances share a reference-counted body lock, preserving inline
position/overflow/padding and page position when the last dialog closes. The
header remains fixed while only the dialog body scrolls. Route changes close stale
dialogs; plan/restore hints use client routing and the Drive success link targets
the real `/backups` route. Downloads and external/local fragment anchors remain
native links. No operational state is changed optimistically.

Appearance uses the document theme as its prehydration authority; application and
dashboard light selectors follow that document attribute. The shared initial
loader is reused by authentication and workspace data readiness. The Impeccable
launcher was not run because local execution/install is forbidden; its refinement
and craft-floor references and existing DESIGN.md were read directly.

The guarded `.github/scripts/check-interface.cjs` is called once inside the
existing Drive browser fixture. It captures six device/theme cases, delays
hydration to check the initial theme, verifies fresh/blocked storage behavior,
resize/rail persistence, mobile drawer, owner alignment, same-document navigation,
modal scroll/focus/Escape return and native select geometry. Dialog long-content
checks explicitly use a720px-high viewport after the full-size captures.
Remote results and screenshot inspection are still pending for this checkpoint.
