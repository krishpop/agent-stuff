## Bounded search

Never run open-ended `find`, recursive `ls -R`, `grep -r`, `rg` without a path, or `du` from `/`, `$HOME`, `/home`, `/mnt/shared`, or any other large tree. Those stall.

Use a known directory (`ls` one level), `grep`/`rg` with an explicit file or small folder `path`, or a glob under one project. If the root is unknown, ask or `ls` one level — do not recurse to discover it.

## Workflow progress updates

`progress.data` takes a closed allowlist: `schema`, `status`, `label`, `phase`,
`completed`, `total`, `unit`, `sourceUpdatedAt`, `sourceEstimatedFinishAt`.
Anything else throws `progress.<field> is not supported` and the update is lost.
Host, job id, and similar context go in `label`, not a new field.
