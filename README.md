# nano-film

Filming probe and uptime monitor. Public so GitHub Actions gives a 4 vCPU / 16 GB
runner, the size that already ran Gemini Nano in ohjay-official/nano-probe.

A private-repo `ubuntu-latest` runner is 2 vCPU / 7.7 GB and cannot load
the on-device backend.

This repo has no product source. The workflows open a public site URL, or
download the public judge zip of the Chrome extension, in branded Chrome
with Nano enabled. They record the screen and save the inference source
label. The extension job adds a local Gmail-fixture host to the installed
manifest's content script matches, because the runner cannot sign into
Gmail; the JavaScript in the zip is unchanged.

The two filming workflows are dispatch only. `uptime.yml` also runs on a
schedule (every 30 minutes, best effort) to probe the live site through
judging, which ends 16 Dec 2026. Nothing runs on push.
