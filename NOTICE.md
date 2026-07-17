# Attribution and project status

NSCF (Nightscout for Cloudflare) is an independent, unofficial downstream
port of the Nightscout project (`nightscout/cgm-remote-monitor`). Nightscout
and its contributors are the upstream authors of the API and product concepts
that this project seeks to preserve.

NSCF is not endorsed by, affiliated with, or an official release of the
Nightscout Foundation or the upstream maintainers. Sugar AI may support the
project as an initiator or maintainer, but NSCF has no runtime or account
dependency on Sugar AI.

Upstream project: https://github.com/nightscout/cgm-remote-monitor

Upstream copyright notice:
https://github.com/nightscout/cgm-remote-monitor/blob/master/COPYRIGHT

This phase-one prototype uses simulated glucose values only. It is not a
medical device and must not be used for diagnosis, dosing, insulin advice, or
any other medical decision.

The official Nightscout v15.0.7 source snapshot is vendored under
`vendor/nightscout` and retains its upstream COPYRIGHT and LICENSE. Its UI,
charts, plugins, translations and client calculations are built without an NSCF
redesign. NSCF-authored code supplies only the Cloudflare platform adaptation.
