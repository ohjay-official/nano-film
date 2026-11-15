# nano-film

Throwaway filming probe. Public so GitHub Actions gives a 4 vCPU / 16 GB
runner, the size that already ran Gemini Nano in ohjay-official/nano-probe.

A private-repo `ubuntu-latest` runner is 2 vCPU / 7.7 GB and cannot load
the on-device backend.

This repo has no product source. The workflows open a public site URL, or
download the public judge zip of the Chrome extension, in branded Chrome
with Nano enabled. They record the screen and save the inference source
label. The extension job adds a local Gmail-fixture host to the installed
manifest's content script matches, because the runner cannot sign into
Gmail; the JavaScript in the zip is unchanged.

Dispatch only. They do not run on push.
