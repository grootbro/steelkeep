# Interface quality pass

Scope: preserve Steelkeep's original PNG brand, Inter, Milk/Graphite/Violet and
Databasement operational composition while fixing everyday interaction defects.
No runtime or browser runs on the owner's Mac. The Drive release was merged before this focused UI checkpoint. Production
publication belongs to the root release process.

| User criterion | Original issue | Implemented behavior | Status |
| --- | --- | --- | --- |
| Resize and collapse desktop navigation | Fixed 250/220/200px sidebar, no user control | Bounded pointer/keyboard separator, persistent width, icon rail | Verified in CI45222655345 |
| Owner/avatar/theme/logout on one row | `.app .sidebar-bottom{display:block}` moves utilities below owner | Aligned footer with one theme icon | Verified in CI45222655345 |
| Civilized dialog scrolling | Native dialog focus/Escape exists; background body is not locked and dialog scrolls as a whole | Shared nested-safe body lock; fixed header and one scrolling body; restore prior state | Verified in CI45222655345 |
| Internal navigation without full refresh | Ordinary anchors remain in plan hints and Drive success notices | TanStack Link for app routes; preserve downloads, external links and local fragment anchors | Verified in CI45222655345 |
| One first-load experience | AuthLoading then separate Connecting spinner | Reuse shared auth/workspace loader, retain actionable errors | Verified in CI45222655345 |
| Dark theme on first paint | Preference applied after mount | Prepaint preference with hydration-safe initial state | Verified in CI45222655345 |
| Dropdown clarity | Filters use 34/37/38px heights and narrow horizontal padding | Consistent compact control height and arrow clearance; long labels ellipsize | Verified in CI45222655345 |
| Responsive polish | Drive header overflow fixed in `23131af`; modal captured at390/1440 | Preserve mobile drawer, check intermediate widths and long scroll | Verified in CI45222655345 |

## Verification method

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
## Remote qualification

The final interface/browser run [45222655345](https://github.com/grootbro/steelkeep/actions/runs/45222655345)
passed on `fd835e00c7dcc5350fb5f455a574253aa8eeefa6`, including its runtime package.
The existing source/typecheck and PostgreSQL integration jobs had passed in
[45220463185](https://github.com/grootbro/steelkeep/actions/runs/45220463185); the
final targeted run repeated the affected compiled UI proof only.

All six cases passed at1440×1000,820×1180 and390×844 in both themes: document width
matched the viewport; the saved document theme and background matched before
hydration; each case recorded four consistent native filter controls and zero
uncaught browser errors. The proof exercised pointer/keyboard resizing, rail
reload persistence, mobile drawer, footer alignment, same-document navigation,
modal background lock/internal scroll/focus/Escape return, fresh and blocked
storage defaults and blocked-storage theme choice across navigation. Existing
Drive source/storage/restore/recovery, single-claim and same-key import controls
also passed with synthetic Google responses.

Visual inspection found narrow tablet tables wrapping names one character per
line. The final correction switches the existing connection card layout by its
actual panel width below700px. Final tablet PNG was inspected and the proof now
asserts at least120px of readable name width at every device/theme breakpoint.
Desktop dark, mobile dark and earlier desktop light captures were also inspected.

Artifacts: `google-drive-ui` ID14842370673 (887,549bytes ZIP), release
`steelkeep-release-fd835e00c7dcc5350fb5f455a574253aa8eeefa6` ID14842890236
(3,870,439bytes ZIP). This browser proof does not establish real Google backup or
restore; those have separate native evidence. The shared modal counter supports
overlapping dialogs in source, while this browser pass exercised individual
dialog instances. Local application runtimes remained stopped.

The qualified UI package was deployed to the existing installation on 24 November
2026 (local time), reusing the pinned image and dependencies. Every runtime file was
checked against the package manifest. Authenticated HTTPS/API checks passed, the
public HTML contained the early theme bootstrap, and the web/worker processes became
ready. Metadata and the prior deployment configuration were preserved for rollback.
