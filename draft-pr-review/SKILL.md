---
name: draft-pr-review
description: Use when the user asks to review a GitHub PR (e.g. "/draft-pr-review 123", "review PR 668"). Audits the PR and delivers is a *pending* (draft) review created on GitHub via the API — inline line-anchored comments, plus a short body (one paragraph.
---

# Draft PR Review

## Usage

User invokes with a PR number: `/draft-pr-review <number>` (e.g. `/draft-pr-review 668`).

If no number is given, run `gh pr list` and ask which one.

## What this review is for

The author can already see their own diff. What they cannot see from inside the
branch is how it sits against the rest of the codebase, the other open PRs, the
library they depend on, and what they said they were building. The findings
worth the reader's time come from that comparison. So one rule runs through
every step below: **a structural finding names what the diff was compared
against** — an existing helper, a sibling file, a convention, a library's
source, another PR, the ticket, or the author's own description. A finding that
compares against nothing is a correctness bug at best and a nit by default.

## Workflow

### 1. Fetch everything, not just the diff

```bash
gh pr view <number>                                                      # title, body, draft status
gh pr view <number> --json headRefOid -q '.headRefOid'                  # exact SHA for comments
gh repo view --json owner,name -q '.owner.login + "/" + .name'          # owner/repo for API URLs
mkdir -p /tmp/claude
gh pr diff <number> > /tmp/claude/pr<number>.diff
gh pr view <number> --json files -q '.files[].path' > /tmp/claude/pr<number>.files
```

Then fetch **every changed file at the head SHA**. You will read whole files and
use the diff only as an index of what changed — a hunk hides the function it
sits in.

```bash
# paths with [brackets] must be URL-encoded: [ -> %5B, ] -> %5D
while read -r p; do
  enc=$(printf '%s' "$p" | sed 's/\[/%5B/g; s/\]/%5D/g')
  mkdir -p "/tmp/claude/pr<number>/$(dirname "$p")"
  gh api "repos/<owner>/<repo>/contents/$enc?ref=<head-sha>" -q '.content' | base64 -d > "/tmp/claude/pr<number>/$p"
done < /tmp/claude/pr<number>.files
```

Files the PR deletes return 404; skip them. These fetched files are the only
legitimate source of line numbers later (step 8).

Also fetch what has already been said, so you do not repeat it, and find out
whether you already hold a pending review on this PR (step 10 needs its ids):

```bash
gh api repos/<owner>/<repo>/pulls/<number>/comments --paginate -q '.[] | "\(.user.login) \(.path):\(.line) \(.body[:120])"'
gh api repos/<owner>/<repo>/pulls/<number>/reviews -q '.[] | select(.state=="PENDING") | "\(.id) \(.node_id) \(.user.login)"'
```

If the description links a ticket and you have a tool that can read it, read
it. The ticket is the intent; the description is the author's account of
meeting it.

Do NOT try `gh pr view --json baseRepository` or similar — that field does not
exist and the command fails. Re-fetch the head SHA right before posting;
branches move during reviews.

Use your local working copy to grep the wider codebase, but verify every claim
about a changed file against the fetched-at-head copy.

### 2. Audit the description before reading any code

The description is a list of claims and decisions, and the author has usually
flagged the exact places they want a second opinion. Extract them into
`/tmp/claude/pr<number>-claims.md`, one row each:

- **Claims.** "X no longer happens", "now does Y", "covers all N criteria",
  "tests pass", "not run locally".
- **Decisions.** "deliberate", "chose", "rather than", "sibling of", "happy to
  consolidate later", "left for a follow-up".
- **Flags and open items.** "worth reviewing", "flagged below", "not built",
  and any question the author asks.

Each row gets a verdict in step 5 — *holds*, *does not hold*, *holds only for
case A* — with the evidence that decided it. Author-flagged decisions are the
cheapest large findings available: the author has asked for a review of a
design choice, and a review that answers a question they did not ask while
ignoring the one they did has failed them. A claim that does not hold is a
Tier 0 finding whether or not any single line is wrong.

### 3. Write the expected shape before reading the implementation

From the title, the description, and the ticket — and before reading the
diff — write three to five lines as if you were assigning the work:

```
Layer:     server action + one column on study; the UI is a thin call site
Extends:   src/server/actions/study.actions.ts (updateStudyAction) — grep confirmed it exists
Data:      one nullable column, no new table
Size:      ~6 files
Concepts:  0 new abstractions expected
```

Name the existing abstraction you expect the PR to extend and grep to confirm
it exists. Then, after reading the whole changeset, diff the actual PR against
each line. Divergences are the highest-value findings this review produces,
and they cannot be found line by line:

- **Wrong layer.** A rule enforced in the UI that the server must own; a data
  fix done in a component; a permission check at a call site instead of the
  chokepoint.
- **Symptom, not cause.** A retry, a guard, a flag, or a wrapper around a
  defect that lives one level down. Go one level down and look.
- **Test knows what the user cannot.** A flaky-test fix that waits on an
  internal signal — a mutation counter, a mock being called, a query-cache
  flag, a store subscription — is a symptom fix twice over. The test should
  wait on what the user sees: the form closing, the toast, the row rendering,
  the button re-enabling. And if the test could race, a user could too; find
  the control that stays enabled while the work is in flight, or the state
  that renders before the data lands. That product gap is the Tier 0 finding,
  the test rewrite is the inline comment.
- **A new abstraction where an existing one covers the case.** If you expected
  an extension and got a new hook, table, or component, check whether the
  existing one could have been extended. If it could not, say why in the
  terminal output; if it could, that is the finding.
- **Over-built.** Count the concepts the PR introduces — new tables, types,
  hooks, components, props, states, flags, context providers. Each must earn
  its place against the ticket. Ask outright: could this PR be half the size?
- **Scope.** Two features, or a refactor mixed with a feature, is a finding in
  the body: harder to review, harder to revert, and it hides which change
  caused a regression.

### 4. Build the change map and read in permanence order

Group the changed files by layer and read them **whole, hardest-to-change
first**. A wrong component is fixed in the next PR; a wrong column or message
shape is fixed by a migration and a coordinated deploy. Spend review time in
proportion.

1. **Schema and migrations.**
2. **Contracts.** Exported types, action and endpoint params and return shapes,
   events and messages between services, feature flags, env config.
3. **Routes and permission rules.**
4. **Shared hooks, helpers, components** — anything with more than one caller.
5. **Leaf components and pages.**
6. **Tests.**

Put these questions to every item in layers 1–3; each is a defect that gets
more expensive every week it stays:

- A name or string column that should be a foreign key, or any stored value
  that can dangle — the thing it names can be deleted or renamed without it
  changing. Find the delete path and check whether it clears the reference.
- A nullable column the code then treats as required, or the reverse.
- Status modelled as a log where the newest row is not the truth, so every
  reader has to scan.
- A type that permits states the code then defends against; a boolean about
  to become a third state; an enum extended in one place and not the others.
- An action that returns more than the caller needs, or takes a whole object
  to read one field.
- A message or event with no version and no tolerance for an older sender.
- A migration with no thought for existing rows, or no way back.
- A rule enforced only in the UI — the server accepts what the button forbids.
- Coupling to a framework or library internal (an error name, a private field,
  an unstable API) with nothing that fails when it changes.

**Every contract change gets one line in the terminal output** (step 11), even
when the line is "fine" — that is how the user sees the hard parts were looked
at. A contract that is fine is NOT review-body material: the author does not
need to be told their migration is acceptable. Only a contract change that is
*wrong* becomes a finding, and it goes inline on the line that defines it.

### 5. Mandatory investigation

These are the moves that produce the findings the author cannot see from inside
the branch. Do them; do not decide they are unnecessary. Record each as one
line in `/tmp/claude/pr<number>-checked.md` — what you looked at and what you
found — because that list is printed in the terminal (step 11) and is how the
user sees the coverage. It is for the user, not for the PR: never post it.

- **Callers.** For every changed exported symbol, grep its callers (cap 10) and
  confirm the change is right for each. A widened type that forces a
  placeholder argument at one call site, or a removed prop that another PR
  still passes, is found here and nowhere else.
- **Siblings.** For every new file, component, hook, or action, find the
  nearest sibling — same directory, same suffix, same job (cap 3) — and
  compare structure. Near-identical is duplication; a different shape for the
  same job is a consistency finding; a sibling holding a fix this one lacks is
  a bug.
- **The established way.** For every new pattern — a fetch, a form, an error
  shape, a route string, a context, a modal, a table, a query — search for how
  the codebase already does it. A second way to do a thing is a structural
  finding, not a nit.
- **Dependency source.** When correctness rests on how a library behaves — a
  transaction helper, a StrictMode double-invoke, a websocket client's
  queueing — read the library's source in `node_modules`. Do not trust the
  docs or memory; the strongest findings in this skill's history came from
  reading the actual code.
- **Other open PRs.** `gh pr list --limit 20 --json number,title,files`, and
  for any that touch the same files, check for collisions git will not report:
  a prop removed here and passed there, a helper renamed here and called there.
- **Completeness sweep.** For the concept the PR changes — a status, a prop, a
  token, a column, a route — grep every place that handles the old thing and
  confirm each was updated. Four of five updated is a bug. Five places at all
  is a chokepoint finding: the next change will miss one too.
- **Test signals.** For every test the PR adds or changes, name the signal each
  wait or assertion keys on and ask whether a user could observe it. Read the
  hook or handler under test to find the user-visible completion — the state
  change that closes a form, the notification, the rendered result — and
  whether it comes after the write. A test-only helper, a mock call, or an
  internal counter used as the wait signal is a finding, and a defect it hides
  in production (a control left enabled while pending, an early render) is a
  larger one.
- **Description verdicts.** Return to the rows from step 2 and fill in each
  verdict with the evidence that decided it.

The caps exist so a 40-file PR finishes. Say in the checked list when a cap was
hit.

### 6. Tiers and the magnitude test

Work the tiers in order. Do NOT start writing comments until Tiers 0 and 1 are
done for the whole changeset. The failure mode this ordering exists to prevent
is real and common: reading top-to-bottom, flagging the first wrong comment or
style slip you see, and shipping a review of trivia that never mentions the
200-line function or the third copy of the same fetch logic.

**Tier 0 — Design and contracts.** Divergences from the expected shape (step
3), contract and data findings (step 4), description claims that do not hold
and author-flagged decisions with your verdict (step 2), scope. Most of these
are not line-anchored; they go in the review body, with an inline comment only
where a specific line is the place to act.

**Tier 1 — Structure.**

  * **Duplication.** Does this repeat logic that already exists? Search for it —
    do not assume it is new. `grep` the codebase for the distinctive names,
    string literals, query shapes, and prop lists in the diff. Three near-copies
    of the same thing is a finding even when each copy is individually fine.
    Prefer "extend the existing hook/helper/component" over "extract a new one".
  * **Function and component size.** Any function doing more than one thing, any
    component holding state + fetching + rendering, any `useEffect` with several
    unrelated concerns. Name the seams where it should split.
  * **Misplaced logic.** Business rules in a component, data processing inline in
    JSX, permission or validation checks scattered across call sites instead of
    living at one chokepoint. Per this project: state/handlers/processing belong
    in `useFeatureName` hooks or helpers, not the component body.
  * **Abstraction boundaries.** A helper that takes six params, or a boolean
    param that switches behaviour, usually wants to be two functions.
  * **Reinventing what exists.** Functionality already in a library or in our own
    utilities. Treat DOM manipulation, hand-rolled date/currency math, manual
    deep-clones, and bespoke caching with suspicion.
  * **Consistency with surrounding code.** A new pattern where an established one
    already covers the case — a second way to fetch, a second error shape, a
    second route-building convention — is a structural finding, not a nit.
  * **Violations of local CLAUDE.md / CONVENTIONS.md.** Read them if present.

**The magnitude test — every Tier 0 and Tier 1 finding must pass all three
parts, in writing, before it is posted.** Matching a category name ("this is
duplication") is not enough; a one-consumer type alias matches "duplication"
and is still a nit.

1. **Reach.** It touches two or more files, or a contract others depend on, or
   a future edit that will land in the wrong place because of it. Say which.
2. **Cost if left.** A concrete future failure, named: "a new status renders
   blank here", "the next document kind needs a fourth copy", "a deleted file
   stays marked as main". "This is cleaner" is not a cost. If the honest
   version is "not load-bearing either way", cut the finding.
3. **The alternative.** One to three lines of the better shape, naming the
   existing thing to extend or the place the logic should live. If you cannot
   name it, downgrade to a question in the body.

A finding that fails any part drops a tier. This is the rule that keeps the
review from filling with plausible-sounding structure.

**One root cause, one comment.** When a root finding has consequences at other
lines — the helper that is not needed once the root is fixed, the call site
that goes back to a plain call — list them inside the root comment. Do not
post them as separate comments; four comments for one cause reads as four
problems.

**Tier 2 — Correctness.** Logic errors, unhandled failure and error paths,
swallowed exceptions, missing `await`, race conditions, N+1 queries, auth or
permission gaps, missing test coverage for new branching behaviour, and tests
that wait on or assert against a signal the user cannot observe (see "Test
signals" in step 5).

**Tier 3 — Nits.** Naming, dead code, and comment problems. Worth mentioning
only when the budget in step 7 leaves room. Comment findings live here and
nowhere else: a new comment that narrates the line below it, restates a name,
or is longer than the code it describes. One exception that ranks with Tier 2 —
a refactor that DELETED a comment recording a non-obvious reason (a library
quirk, a workaround, a rejected alternative) has lost that reason; say so.

If Tiers 0 and 1 turn up nothing, say so in the terminal output rather than
padding the review with Tier 3 material to look thorough. A clean structural
review is a legitimate outcome — and on GitHub it looks like a review with a
few inline comments and no body, which is correct. Do not post a body whose
content is "I checked and it is fine".

**The six-month re-read.** After drafting and before building the payload,
re-open each Tier 0/1 finding's cited counterpart — the sibling, the helper,
the library file — and check it says what the comment claims. Then ask: does
this matter more in six months than it does today? A wrong "this duplicates X"
costs more trust than a missed nit. Delete or downgrade whatever fails either
check.

**If the PR is in DRAFT status**: note the draft status to the user and ask if
they would like a summary instead of posting the review. If they do want the
summary, give a broad overview of what the code is doing and any large concerns
you have, or suggestions on how it can be simplified.

### 7. Group findings, budget, and gate

For each finding, capture: file path, line number (in the *new* file at PR
head), and a comment body. Keep tone informal and constructive — these are
inline review comments, not a verdict.

**Budget and ordering.** Rank every finding by tier before you write the
payload, then apply these caps:
- Tier 0, 1 and 2 findings: all of them, no cap.
- Tier 3 nits: **at most two per review, and zero if the review already has
  four or more Tier 0/1/2 findings.** Nits are the first thing cut, never the
  thing that crowds out structure.
- A review consisting only of Tier 3 findings is a failed review. If that is
  what you have, go back to step 3 and read the changeset as a whole — you
  almost certainly reviewed it line-by-line instead.

**The gate.** For each comment, before it goes in the payload, ask: *would a
senior engineer hold up the merge for this, or is it something they would
mention in passing?* Hold-up findings get inline comments — an inline comment
reads as "change this", and spending that weight on trivia is what makes a
review feel noisy while missing the real problems.

Passing-mention findings are **not posted at all**. They go in the terminal
output (step 11) for the user to raise if they want to. The review body is not
the overflow bin for findings too small to post inline — a finding that did not
earn an inline comment has not earned a place in the body either.

Anchor Tier 0/1 findings to the most structural line available — the function
signature, the component declaration, the duplicated block's first line, the
migration's `addColumn` — not to an incidental line in the middle.

### 8. Anchoring rule — the #1 source of 422 errors

Every `line` value must be a line number *as it appears in the file fetched at
the head SHA* (step 1). NEVER read line numbers from `gh pr diff` output — the
unified diff renumbers across hunks and bears no relation to file-relative line
numbers in existing files. For new files added in the PR, file lines and hunk
lines happen to coincide, which is what makes this trap easy to fall into.

Concretely: before writing each comment, `grep -n` the fetched-at-head file,
locate the exact line you intend to anchor to, and copy that line number. Then
verify two things before continuing to the next finding:
- The line number is `<=` the file's total line count.
- The content at that line in the fetched file actually matches what your
  comment is about (grep for a distinctive substring from your comment body).

Skipping this verification is what produces `422 "Line could not be resolved"`
at POST time, which costs a round trip and a payload rewrite.

### 9. Build the payload — comments, and a body only if earned

```json
{
  "commit_id": "<head-sha>",
  "body": "<one paragraph, or omit the field entirely>",
  "comments": [
    { "path": "src/foo.ts", "line": 42, "side": "RIGHT", "body": "..." }
  ]
}
```

**The body is for findings that have no line to anchor to — nothing else.**

Default to **no body at all**. Inline comments are the deliverable; a body is
the exception, for the case where something important is true of the changeset
as a whole and there is no single line to pin it to: a collision with another
open PR, a claim in the description that does not hold, two features in one PR,
an abstraction that should exist across several new files.

When one is warranted, the whole body is **one paragraph, under ~120 words**,
written in the same STE as the comments (see Comment style — the 25-word
sentence limit and the banned list apply here too), and it must:

- **Lead with the problem in one sentence.** What is wrong, not what you did.
- **Name the change.** The concrete thing to do — the file to delete, the
  component to extract, the PR to rebase on. A body that describes a problem
  without naming the fix is not finished.
- **Show it in code when the change is a code change.** A short fenced block of
  the proposed shape — a signature, a call site, a few lines — beats a
  paragraph describing it. Trim it to the lines that carry the idea.

If two unanchored findings both clear the bar, use two short paragraphs. Three
is the ceiling, and by then ask whether the lesser ones are really findings.

Do NOT put in the body: a summary of the PR (the author wrote it), contracts
that are fine, description claims that hold, the checked list, praise, restated
inline comments, or any heading structure (`## Shape`, `## Checked`) — those
are terminal output (step 11). The magnitude test in step 6 applies here
unchanged: a body item that fails cost-if-left is cut, not shortened.

Worked example — the whole body for a PR whose second page duplicated the first:

> `edit-initial-request-section.tsx` is `proposal/form.tsx` with a different
> heading, and the two already disagree (`w="50%"` vs `w="60%"`, placeholders
> kept vs removed), so the next card change lands in one and not the other.
> Both providers expose the same `{ studyId, form, yjsForm, websocketProvider }`,
> so the card can move into one component both pages mount:
> ```tsx
> <ProposalFieldsSection {...ctx} heading={heading} isDraftCreator={isDraftCreator} />
> ```
> That deletes this file and `footer.tsx`. Also worth rebasing on #956 — it
> rewrites the `onError` this PR replaces.

**Omit the `event` field** — that leaves the review in pending/draft state for
the user to review and submit. Including `event: APPROVE/REQUEST_CHANGES/COMMENT`
submits it immediately, which is almost never what's wanted.

### 10. Post the pending review

This step is part of the skill — invoking `/draft-pr-review` means "draft the
review on GitHub for me to look over." Posting is **not** publishing: omitting
`event` leaves the review in `PENDING` state, visible only to the PR
author/owner of the token, with nothing visible to other reviewers until the
user clicks Submit on github.com. Treat this `gh api` call as the equivalent of
writing to a local scratch file under the user's account.

```bash
gh api -X POST repos/<owner>/<repo>/pulls/<number>/reviews --input /tmp/claude/review.json
```

On success the response includes `"state": "PENDING"` and an `html_url` — share
that link so the user can open the draft on github.com to revise and submit.

**If a pending review already exists** (found in step 1), the create call
returns `422 "User can only have one pending review per pull request"`. Its
existing comments are the user's draft; keep every one of them. Which path
depends on whether that review already has a body.

*It has a body.* Append the new comments and replace the body in place:

```bash
# One call per new comment. ALWAYS pass pullRequestReviewId: with only a
# pullRequestId the thread is published immediately, outside any draft.
# zsh trap: never name the shell variable `path` — it is tied to PATH and every
# command after the assignment fails with "command not found". Use `cpath`.
gh api graphql -F reviewId=<review-node-id> -F path="$cpath" -F line="$cline" -F body=@/tmp/claude/comment.md -f query='
mutation($reviewId: ID!, $path: String!, $line: Int!, $body: String!) {
  addPullRequestReviewThread(input: {pullRequestReviewId: $reviewId, path: $path, line: $line, side: RIGHT, body: $body}) { thread { id } }
}'

gh api graphql -F id=<review-node-id> -F body=@/tmp/claude/body.md -f query='
mutation($id: ID!, $body: String!) {
  updatePullRequestReview(input: {pullRequestReviewId: $id, body: $body}) { pullRequestReview { state } }
}'
```

*It has no body* (empty in the step 1 listing). GitHub refuses to add one
afterwards — `updatePullRequestReview` and `PUT .../reviews/<id>` both answer
`"Could not edit a review with a missing body"` — so rebuild the review. Back
up every existing comment through GraphQL (the REST listing returns
`line: null` for pending comments and `GET /pulls/comments/<id>` 404s on them),
merge in the new comments, validate, then delete and recreate in one go:

```bash
gh api graphql -F id=<review-node-id> -f query='query($id: ID!) { node(id: $id) { ... on PullRequestReview {
  body comments(first: 100) { nodes { path line body } } } } }' -q '.data.node' > /tmp/claude/backup.json
# review.json = commit_id + body + comments (backup nodes with side RIGHT, then the new ones)
gh api -X DELETE repos/<owner>/<repo>/pulls/<number>/reviews/<review-id>
gh api -X POST repos/<owner>/<repo>/pulls/<number>/reviews --input /tmp/claude/review.json
```

Validate the merged payload before the DELETE and keep the backup file. If the
POST fails, say so immediately — the draft is gone until the retry succeeds.

If the call is denied, do not silently fall back to printing comments. There are
two distinct denial modes — they look similar in the tool error but require
different recoveries:

- **Permission prompt denied (non-auto mode).** A normal "Allow Bash command?"
  prompt fired and the user declined or it wasn't auto-approved. Offer to add
  an allow-rule (e.g. `Bash(gh api -X POST repos/<owner>/<repo>/pulls/*/reviews:*)`)
  to `.claude/settings.local.json`, or retry with the prompt approved.
- **Auto-mode classifier denial (auto mode on).** No prompt was ever shown to
  the user — the classifier intercepted and refused as too high-blast-radius
  for unattended execution. The error text mentions an "auto mode classifier."
  A permission allow-rule does NOT clear this gate. The user must either (a)
  exit auto mode and retry (a pre-existing allow-rule will then bypass the
  prompt), or (b) accept the manual-paste fallback. **Do not claim a permission
  prompt was shown when in auto mode** — there isn't one, and that's confusing
  to the user.

In either case, tell the user exactly what was blocked and offer: (a) the right
unblock path for their mode, or (b) print the comments for manual paste. Don't
quietly downgrade the deliverable.

## Important

- `gh pr review` (the subcommand) does NOT support inline comments. Always use `gh api` for this.
- The PR head SHA in `commit_id` must match the actual current head; otherwise GitHub rejects line numbers that don't exist at that commit. If you fetched the diff a while ago, re-fetch the SHA before posting.
- If the API returns `422 Unprocessable Entity`, read the `errors` array first. `"Line could not be resolved"` means a line number in your payload doesn't exist at the head SHA (see step 8) — fix the offending entries and retry, don't blanket-retry. Only treat 422 as transient if the error array is empty or unrelated to line resolution.
- `422 "User can only have one pending review per pull request"` means append to, or back up and rebuild, the existing pending review (step 10). Never drop its comments.
- Comments are ALWAYS pending/draft. NEVER add `event` unless the user explicitly says "submit" / "approve" / "request changes".

## Comment style

Every comment is written in ASD-STE100 Simplified Technical English. This is a
hard rule with a check at the end of this section, not a tone preference. The
author reads the review to learn what to change; prose costs them time and
buries the change under the reasoning for it.

**Open with the change, as an imperative.** The first sentence names the requested action clearly:
"Can we add the gate to X." "We should renumber both migrations." "This prop is not needed". Evidence
comes after, and only the evidence that makes the case. Do NOT open with the
observation and make the reader infer the fix.

- Use code suggestions as much as possible.
- One issue per comment; pin to the most relevant line.
- **25 words per sentence, hard.** Split anything longer. Code spans in
  backticks count as one word (STE Rule 8.6).
- **150 words per comment, hard**, code blocks excluded. A Tier 0/1 finding
  earns more evidence, not longer sentences. Over 150 means the comment carries
  reasoning the author did not ask for — cut that, not the finding.
- One fact per sentence. No sentence does two jobs.
- Conditions go first: "If the build fails, read the log" — never the reverse.

**Banned in comment bodies.** These are the hedges that turn a finding into an
essay. Search for each before you post:

| Banned | Write instead |
|---|---|
| "worth a look", "worth a note", "worth doing X" | the imperative with a single softening word: "Can we do X." or "We should do X", "Please change X" |
| "it is worth noting that", "note that", "keep in mind" | delete; state the fact |
| "I'd suggest", "I think", "in my opinion" | delete; the comment is already yours |
| "simply", "just", "clearly", "obviously" | delete |
| semicolons | two sentences |

Keep in mind that **directness is not rudeness**: the
imperative names a change, it does not judge the author and respects their time
by keeping the request clear and concise.

**Before you post, run this on every comment body:**

```bash
# 1. sentences over 25 words (strip code blocks first)
python3 -c "
import re,sys
t=re.sub(r'\`\`\`.*?\`\`\`','CODE',open(sys.argv[1]).read(),flags=re.S)
for s in re.split(r'(?<=[.!?])\s+',t):
    if len(s.split())>25: print('LONG', len(s.split()), s[:60])
" /tmp/claude/comment.md

2. total length

wc -w /tmp/claude/comment.md   # under 150, code blocks excluded
```

(zsh: do not name a shell variable `status` in these loops — it is read-only.
Use `verdict`. Same trap as `path` in step 10.)

Fix every hit before building the payload. A comment that fails these is not
ready to post, however correct the finding is.

### Do not propose code comments as the fix

"Worth a comment explaining…" is the default suggestion to reach for and it is
almost always the wrong one. Code comments are for the exceptional case — a
reason a reader genuinely cannot recover from the code. Before writing a comment
suggestion, try in this order:

1. **Change the code so the question does not arise.** A name that states the
   constraint, a type that makes the bad state unrepresentable, a guard clause,
   an extracted helper whose name IS the explanation. Prefer this always.
2. **Add a test.** "Is this behaviour intentional?" is answered permanently by a
   test that fails when it changes — and unlike a comment, a test cannot go
   stale silently. Reach for this whenever the concern is "nothing pins this".
3. **Ask the question, propose no remedy.** A finding can stand on its own. If
   you do not know the right fix, say what looks wrong and stop.
4. **Only then** suggest a comment — and only for a genuine "why": a library
   quirk, a rejected alternative, an invariant enforced elsewhere. Never to
   restate what the code does.

Concretely, do not write comments like these:

- "worth a note saying this is deliberate" → propose a test, or ask if it is.
- "a comment here would help the next reader" → rename it instead.
- "document that X assumes Y" → assert Y, or make X take Y as a parameter.

Cap yourself: **at most one comment-suggesting finding per review**, and if you
reach for a second, that is the signal the underlying code needs a structural
change instead. This cap sits inside the Tier 3 budget in step 7 — it does not
add to it. If a project's CLAUDE.md / CONVENTIONS.md states a comment policy,
follow that over this section.

## Step 11 — Output (terminal only)

**This is where the full structural read goes.** The user asked for the review
and wants to see the work; the PR author wants only what to change. That split
is the whole point — everything cut from the body in step 9 lands here, and
this section can be as long as it needs to be.

Print out, in this order:

 * **The structural read** — expected shape (step 3) against actual, and the
   Tier 0/1 findings, whether or not each became an inline comment. If Tiers 0
   and 1 were clean, say that plainly. This leads because it is the part the
   user cannot get from skimming the diff themselves.
 * **Contracts** — one line per migration, type, action signature, route,
   permission or message change, including the ones that are fine.
 * **Description verdicts** — each claim and author-flagged decision from step
   2, with its verdict and the evidence.
 * Correctness (Tier 2) findings, and whether each was posted inline.
 * Nits held back by the budget, as a short list — not as inline comments.
 * The checked list, so the user can see what was compared and where a cap was
   hit.
 * At least one point of praise.
 * **What was posted** — the inline comment count, and the body if there is one,
   quoted in full so the user can judge its length before submitting.
 * The pending review's URL.

Do not lead with, or dwell on, comment and naming observations. If the printed
output is mostly Tier 3 material, the review did not do its job.
