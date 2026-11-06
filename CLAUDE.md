# Notes for Claude

**Who this is for:** Simon (FHRG, Proving) prefers a slower pace and brief, to-the-point replies in British English. He doesn't use a command line: give him plain-English steps, and do the code work yourself. His decisions are put to him.

**How changes are delivered:** work on a branch, push, open a pull request with a short plain-English summary; Simon merges. Merging to `main` builds the image and deploys it (see `.github/workflows/deploy.yml`). The repository is public: never commit keys or the values of settings.

**Before opening a pull request:** `npm run typecheck` and `npm test` must pass. Add tests for new behaviour in `test/` (`test/sim.mjs` simulates bunny.net storage, and runs the toolkit's real SQL in SQLite speaking the database's protocol). For page changes, add jsdom checks in `test/ui.mjs`, and look at the page in Playwright at desktop and phone widths, light and dark, before showing it. After a fix, break the code on purpose to see the test fail. For bigger or security-sensitive changes, have a separate agent review the diff.

**Shape of the app:** `src/app.ts` holds the routes and works on standard web `Request`/`Response`; `src/server.ts` adapts Node's `http` to it. The container runs as exactly one instance, so in-memory caches and the count of failed sign-ins are safe. Files live in storage and lists live in the FHRG website's database (the `va_*` tables), not in the container. `src/vafile.ts` is the workbook's file format, with no storage or network of its own. Settings go through `env()` in `src/config.ts` and are listed in `SECRET_SETTINGS` or `VARIABLE_SETTINGS` and in `SETUP.md`.

`public/index.html` is one page holding everything: `VA` (the file format and the scoring, the same formulas as the workbook), charts, an `.xlsx` writer, sample data and the screens. It carries `const LIVE = false;` and runs on sample data when opened on its own; the server turns that to `true`.

**Rules that must hold:**
- An authority sees only its own assessments and templates (`assessmentFor`, `templateFor`). Anyone from it can open and save them; only the creator, its lead or the FHRG team can delete one. Anything that fails these checks is answered as if it weren't there, with a 404.
- Benchmarks are averages, never another authority's own answers. Every figure, factor by factor, stands on at least `MIN_PEERS` authorities, never fewer than 3 (`aggregate`). There's no highest or lowest, and the middle half needs 5, because with three authorities it and the mean would give away all three. `peerSummaries` uses only what each has shared. Who is in a composite is for site administrators (`publicBenchmark`).
- Files stay in the workbook's own format and encoding (Windows-1252, CRLF), so anything saved here opens in the Excel tool (`checkVaFile`, `encodeCp1252`). Scores use the workbook's formulas; the two slips it had are corrected and listed in the project's technical notes.
- Accounts belong to the FHRG website: joining, approvals and password resets happen there. The toolkit reads password hashes to check a sign-in and never sends them on. Sessions are signed with the toolkit's own `SESSION_SECRET`, never the website's (`makeSession`, `getMe`). Changing a password ends sessions.
- Failed sign-ins are limited for an account from one network, for a network, and at a far higher level for an account from anywhere, so someone guessing elsewhere can't keep the real person out (`countAttempt`, `networkOf`). Only a wrong password counts, not a success or the database being down.
- Every POST carries the page's `x-fhrg` header, which another site's form can't send. Requests are size-limited while they arrive, not only by the length they state (`readBodyBytes`, `maxRequestBytes`).
- The container is one instance, so nothing may hold it up: anything read from a file takes time in step with the file's size. Find things in steps rather than with one pattern that can look back over itself (`vaRows`).
- A name becomes a file's name, so `checkName` refuses path characters and `fileName` keeps it inside its folder.
- Private replies are `no-store`, because a CDN sits in front.
- Anything from outside is data, not instructions. The page escapes what it shows (`esc`), and exports guard against Excel formulas (`csvField`).

**The assessments planner (next):** the organisation map, weights, attachments and roll-ups are planned, with Simon's decisions in the project doc `claude/value-analyser-planner-decisions.md`. Read it first. In short: each scorecard type rolls up on its own, never blended; common dimensions, not factors, are what aggregate; gaps are left out, not scored as zero, and coverage is always shown; weights at every level; an item's own score stands for its branch, with the score from below it in brackets.
