# Security policy

## Reporting

Report suspected vulnerabilities through GitHub's private vulnerability reporting for this repository. Do not include secrets or exploit details in a public issue.

## Dependency policy

Release and CI gates run:

```bash
npm run audit:production
```

This audits shipped dependencies only and fails on moderate-or-higher findings. `pi-loop` ships one runtime dependency and receives Pi, Pi TUI, and TypeBox from the host through peer dependencies.

Development dependencies remain visible in the full `npm audit` report and are triaged separately. Never use `npm audit fix --force` to silence an advisory by downgrading Pi or changing its API contract.

## Temporary Pi 0.83 development exception

`@earendil-works/pi-coding-agent@0.83.0` is an exact development pin used for type, package, and compatibility tests. Its published npm shrinkwrap pins:

- `undici@8.5.0`, producing GHSA-4cwx-7wf7-3272, GHSA-8xcm-r25x-g524, GHSA-jr45-8vmc-qm54, GHSA-m8rv-5g2x-5cg5, and GHSA-v3r7-h72x-cjcm;
- `brace-expansion@5.0.7`, producing GHSA-mh99-v99m-4gvg and GHSA-rgw5-rvv9-x895 in local npm audit output.

These packages are not included in the published `pi-loop` artifact. The production-only audit currently reports zero vulnerabilities.

Upstream Pi fixed the pins in commit [`221a842c`](https://github.com/earendil-works/pi/commit/221a842c136ab3af23aef9e70034af86061d27c1), but no fixed npm release newer than `0.83.0` was available when this exception was recorded. Root npm overrides do not remediate this safely because the published Pi shrinkwrap still installs the vulnerable nested versions.

The exception ends when a compatible fixed Pi release is published. Dependabot checks npm weekly; upgrade the exact Pi and Pi TUI development pins together, regenerate the lockfile normally, run the full validation suite, and require full `npm audit` to return zero before removing this section.
