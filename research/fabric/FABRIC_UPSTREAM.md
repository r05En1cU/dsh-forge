# Upstream

This directory is imported as a git subtree from the `omdsh-dev/fabric`
repository. The upstream commit history and original authorship are preserved
in this repository's history.

- URL: https://github.com/omdsh-dev/fabric.git
- Imported history HEAD: `68e8d34704fac4a20f94c9d405ae17b089935893`
- Last upstream commit at import:
  - Subject: `fix: make the fabric-dsh bin executable`
  - Date: Sun Aug 16 02:07:02 2026 +0800
- Import method:

  ```sh
  git subtree add --prefix=research/fabric 3fd1a567743110e7331f637e1200e226191f57e8
  git subtree pull --prefix=research/fabric fabric-upstream main
  ```

- Inspect the original upstream history:

  ```sh
  git log --format='%h | %an <%ae> | %s' 68e8d34704fac4a20f94c9d405ae17b089935893
  ```

Local dsh-forge overlays on top of the upstream files:

- `FABRIC_UPSTREAM.md` (this file)
- `pnpm-lock.yaml` (dsh-forge dependency-resolution adjustments)
