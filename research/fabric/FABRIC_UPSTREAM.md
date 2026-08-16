# Upstream

This directory is imported as a git subtree from the `omdsh-dev/fabric`
repository. The upstream commit history and original authorship are preserved
in this repository's history.

- URL: https://github.com/omdsh-dev/fabric.git
- Imported history HEAD: `3fd1a567743110e7331f637e1200e226191f57e8`
- Last upstream commit at import:
  - Subject: `test(trio): exercise the real browser services via happy-dom + a ModuleLoader materializer`
  - Author: inschrift.spruch.raum <inschrift.spruch.raum@outlook.com>
  - Date: Sat Aug 15 22:18:30 2026 +0800
- Import method:

  ```sh
  git subtree add --prefix=research/fabric 3fd1a567743110e7331f637e1200e226191f57e8
  ```

- Inspect the original upstream history:

  ```sh
  git log --format='%h | %an <%ae> | %s' 3fd1a567743110e7331f637e1200e226191f57e8
  ```

Local dsh-forge overlays on top of the upstream files:

- `FABRIC_UPSTREAM.md` (this file)
- `pnpm-lock.yaml` (dsh-forge dependency-resolution adjustments)
