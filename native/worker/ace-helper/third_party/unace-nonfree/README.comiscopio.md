## Vendored Source Notes

This directory contains a vendored snapshot of Debian's `unace-nonfree` source package.

Origin:

- package: `unace-nonfree`
- source copied from a Debian-patched working tree, not from raw upstream
- Debian source package: https://packages.debian.org/source/sid/unace-nonfree
- Debian source repository: https://salsa.debian.org/fabian/unace-nonfree
- Debian hosted sources: https://sources.debian.org/src/unace-nonfree/2.5-10/

Comiscopio-specific adjustments:

- keep the Debian patchset applied
- add a small downstream patch in `source/apps/exe/acefuncs/acefuncs.c`
  to emit machine-readable listing lines when
  `COMISCOPIO_UNACE_LIST_PREFIX` is set
- harden `source/base/all/lfn/lin.c`
  to avoid `sprintf` overflow and null `PATH` dereference in
  `BASE_LFN_CompleteArg0`

This vendored code is used only for ACE decompression support.

When updating this snapshot:

- reapply or verify the Comiscopio-specific adjustments above
- rebuild `comiscopio-unace` and `comiscopio-ace-helper`
- re-run the ACE smoke tests against real `.ace/.cba` inputs and
  ACE files disguised as `.cbr`
