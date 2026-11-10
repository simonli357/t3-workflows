# Worker names

`t3w profile [--project NAME_OR_PATH]` prints the project's naming policy,
repository prefixes, account aliases and model suffixes. Names are a convention;
the tools accept any title.

- All lowercase, ending in the model suffix once (`_opus`, `_sol`, ...). Resolve
  the model before naming (`t3_allocate_account` with `preview: true` shows an
  automatic choice).
- Issue work: `<epic>_<repository-prefix><issue-number>_<keyword>_<model>`, for
  example `a569_c344_camera_sol`. Use the nearest explicitly identified epic and
  omit `<epic>_` when there is none (`c344_camera_sol`); never invent one.
- `<keyword>` is exactly one word that best describes the work, not a phrase,
  generic verb, account name or date.
- Other work: `<short-description>_worker_<model>`, for example
  `camera_preview_worker_opus`.
- Keep the full repository and issue reference in the assignment text.
- Existing workers keep their titles unless reassigned to another task; never
  change a title on a retry.

The Scandy profile's prefixes are in [scandy.md](scandy.md).
