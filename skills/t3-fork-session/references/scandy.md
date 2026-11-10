# Scandy worker names

Apply [conventions.md](conventions.md) with these prefixes, for the Scandy
profile only:

- `a` plus the issue number for ScandyAutonomy, `c` plus the issue number for
  ScandyControl, without `#`. The repository that owns the issue determines the
  letter, not the files being changed.
- The epic prefix uses the epic's own repository letter: a Control issue under an
  Autonomy epic is `a569_c344_camera_sol`.
- Read the issue's parent or explicit epic reference to find its epic. For nested
  tasks use the closest explicitly identified epic, not every intermediate parent.

`t3w profile --project scandy` prints the accounts, base names and models. Both
Scandy repositories share the configured Scandy base project.
