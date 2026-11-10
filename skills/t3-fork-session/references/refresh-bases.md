# Refresh the prepared bases

Only when the user asks. Run it on the computer that holds the bases.

```bash
t3w refresh-bases --project NAME_OR_PATH            # preview
t3w refresh-bases --project NAME_OR_PATH --apply
```

Each account's base is replaced by a fresh session prepared with
`understand project`, or with `--prompt TEXT` (for example
`--prompt "understand the key ara repos"` when the bases serve other
repositories). Missing bases are created; existing worker forks are untouched.
`--provider XL` (repeatable) limits it to selected accounts.

A busy or ambiguous base stops the run before anything changes. A failed
preparation keeps the old base and a `<base>_refresh` session: resolve the
provider error in that session, then rerun for that provider, which reuses it.
`--timeout` bounds each preparation (1 to 600 seconds, default 600).
