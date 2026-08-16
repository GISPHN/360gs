# v0.3c9 CI note

The build workflow now uses a per-branch concurrency group so binary WebAssembly outputs cannot be pushed concurrently by overlapping c9 runs. This removes the binary rebase conflict observed during development while retaining complete rebuild validation.
