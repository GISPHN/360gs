# v0.3c9 field test expectation

For the same high-quality 30,000-Gaussian test case, the first browser growth boundary is expected near iteration 1,600. With an 8% configured growth fraction and sufficient cap headroom, the Gaussian count should increase to approximately 32,400 without invoking the c8 full-refine host readback path. A second growth boundary near iteration 3,200 can raise the count to approximately 34,992. Growth is disabled once the configured growth stop iteration is reached.
