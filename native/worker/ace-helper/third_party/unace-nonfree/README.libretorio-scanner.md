## Vendored Source Notes

This directory contains a vendored snapshot of Debian's `unace-nonfree` source package,
ported into `Libretorio-Scanner` for ACE decompression support.

Origin:

- package: `unace-nonfree`
- source copied from the vetted `Comiscopio` working tree, which already carried
  the Debian patchset plus downstream hardening
- Debian source package: https://packages.debian.org/source/sid/unace-nonfree
- Debian source repository: https://salsa.debian.org/fabian/unace-nonfree
- Debian hosted sources: https://sources.debian.org/src/unace-nonfree/2.5-10/

Scanner-specific notes:

- keep the Debian patchset applied
- keep the downstream patch in `source/apps/exe/acefuncs/acefuncs.c` that emits
  machine-readable listing lines when `COMISCOPIO_UNACE_LIST_PREFIX` is set
- keep the hardening in `source/base/all/lfn/lin.c` to avoid `sprintf` overflow
  and null `PATH` dereference in `BASE_LFN_CompleteArg0`
- build output is renamed to `comic-cache-unace`
- the helper executable is renamed to `comic-cache-ace-helper`

This vendored code is used only for ACE decompression support.

When updating this snapshot:

- reapply or verify the downstream adjustments above
- rebuild `comic-cache-unace` and `comic-cache-ace-helper`
- re-run the ACE smoke tests against real `.ace/.cba` inputs and ACE files
  disguised as `.cbr`
