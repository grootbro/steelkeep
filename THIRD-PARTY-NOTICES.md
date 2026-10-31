# Interface references and adapted material

## Databasement

Steelkeep's dashboard composition and operation-list structure are adapted from Databasement's
MIT-licensed views, rewritten for React/TanStack Start. Retention selection semantics
are adapted from its retention action, rewritten in TypeScript. Source commit:
`e7535032de8570f97b982c857b809caa7f1f4a24`.

- resources/views/livewire/dashboard.blade.php
- resources/views/livewire/dashboard/snapshots-card.blade.php
- resources/views/livewire/dashboard/storage-card.blade.php
- resources/views/livewire/dashboard/success-rate-card.blade.php
- resources/views/livewire/dashboard/jobs-activity-chart.blade.php
- resources/views/livewire/dashboard/latest-jobs.blade.php
- resources/views/livewire/dashboard/job-status-grid.blade.php
- resources/views/livewire/dashboard/storage-distribution-chart.blade.php
- resources/views/livewire/database-server/show.blade.php (profile composition, rewritten in React)
- resources/views/livewire/database-server/_backup-form.blade.php (plan summary and configuration hierarchy)
- resources/views/livewire/configuration/_tabs.blade.php
- resources/views/components/configuration-header.blade.php
- resources/views/livewire/snapshot/index.blade.php
- resources/views/livewire/snapshot/_filters.blade.php
- resources/views/partials/job-logs-modal.blade.php (operation detail hierarchy)
- app/Actions/Snapshot/ApplyRetentionPoliciesAction.php (latest-N/GFS selection semantics)

Upstream: https://github.com/David-Crty/databasement

MIT License

Copyright (c) 2025 David Courtey

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the “Software”), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Salt.md

Reviewed as a secondary interaction/technology reference, including navigation, neutral
surface hierarchy, local font delivery and workspace context. No Salt.md source code or
assets have been copied into Steelkeep. The inspected local source is AGPL-3.0, commit
`82c727943020d7d8a5e03c33db7aa73be1375898`, upstream https://github.com/saltmd/salt.md.

## Fonts

Instrument Sans and Inter are self-hosted through Fontsource packages, under their supplied
OFL-1.1 font licenses. Keep package license notices when distributing built assets.

## Optional Microsoft SQL Server tooling

The source-only `tools/Steelkeep.DacFx` helper references Microsoft.SqlServer.DacFx
170.5.96. Microsoft binaries are not included in this repository or the base image.
That NuGet artifact has Microsoft Software License Terms, not this repository's MIT
license: https://www.nuget.org/packages/Microsoft.SqlServer.DacFx/170.5.96/License.
An operator provisioning that optional profile must retain the actual package terms,
notices and dependencies and review applicable distribution obligations. The helper
was not executed during the initial code-only phase. A later authorized checkpoint compiled it; the owner explicitly accepted Microsoft SQL Server terms for the isolated A-server acceptance stand on 31 October 2026. Runtime evidence is recorded separately.
