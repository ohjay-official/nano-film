# nano-film

Throwaway filming probe. Public so GitHub Actions gives a 4 vCPU / 16 GB
runner, the size that already ran Gemini Nano in ohjay-official/nano-probe.

A private-repo `ubuntu-latest` runner is 2 vCPU / 7.7 GB and cannot load
the on-device backend.

This repo has no product source. The workflow opens a public site URL in
branded Chrome with Nano enabled, records the screen, and saves the
inference source label.

Dispatch only. It does not run on push.
