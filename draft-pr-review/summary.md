# PR summary

A short read of what a PR actually changes and how well it meets its Jira
ticket. pr-triage runs this once per Review / Re-review item; draft-pr-review
leads its step 11 output with the same block. It never writes to GitHub.

The description is the author's claim, not the source. Every line of the block
comes from the diff or the ticket; use the description only to find ticket keys
and to spot claims the diff does not back.

## Inputs

- `<repo>` (owner/name) and `<number>`. `<name>` below is the repo part of
  `<repo>`; it keeps parallel runs on two repos from sharing files.
- Optional `<compare>`: a compare range `<from>...<to>` for a re-review. When
  given, `changes:` and `UI:` cover only that range; ticket coverage still
  covers the whole PR.

## 1. Fetch

```bash
mkdir -p /tmp/claude
gh pr view <number> --repo <repo> --json title,body,headRefName,headRefOid,files \
  > /tmp/claude/<name>-pr<number>.json
gh pr diff <number> --repo <repo> > /tmp/claude/<name>-pr<number>.diff
# re-review only:
gh api repos/<repo>/compare/<from>...<to> -H 'Accept: application/vnd.github.diff' \
  > /tmp/claude/<name>-pr<number>-since.diff
```

**Fetch the Jira tickets.** The ticket is the intent; the description is the
author's account of meeting it. Find every key on the OTTER or SHIMP board in
the PR title, body, and branch name:

```bash
jq -r '.title + "\n" + .body + "\n" + .headRefName' /tmp/claude/<name>-pr<number>.json \
  | grep -oE '\b(OTTER|SHIMP)-[0-9]+\b' | sort -u
```

For each key, call `mcp__jira-atlassian__jira_get_issue` with
`include: "comments,remote_links"`, `comment_limit: 100`,
`fields: "summary,status,description,issuetype,parent,issuelinks,subtasks,attachment"`
and `update_history: false`. Read the description **and every comment**.
Comments often add, narrow, or cancel scope after the ticket was written (a QA
note that adds an item, a product decision that drops one). The newest decision
wins. If the ticket has a parent epic or linked issues that the description
refers to, fetch those too, but only the ones the ticket depends on.

If no key is found, say so. If a fetch fails, say so; do not guess the
ticket's contents.

## 2. Ticket requirements

One row per requested change from each ticket — each item in "expected
behaviour" or acceptance criteria, and each item that a comment adds or
changes. Tag each row with its source (`OTTER-814 desc #2`,
`OTTER-814 comment 48353`). Mark rows that a later comment cancelled or
deferred, with that comment's id.

## 3. Verdicts

For each row, find the code in the diff that makes the change and the test
that proves it. Verdict: *done*, *partly done* (say which case is missing),
*not done*, or *out of scope* (a ticket comment or the description defers it —
cite which). A comment that says "not blocking" still counts as a requirement
unless someone deferred it.

Also check the reverse: a behaviour change in the diff that no ticket asks for.

The summary reads the diff, not whole files, so a verdict that depends on code
outside the hunks is *partly done* with "unverified: <what>" rather than a
guess.

## 4. UI touched

Name the screens a user would see change, not the files.

- `src/app/**` files map to their route: drop `src/app`, route groups like
  `(root)`, and the file name — `src/app/[orgSlug]/study/[studyId]/review/code/page.tsx`
  is `/[orgSlug]/study/[studyId]/review/code`.
- A changed component outside `src/app`: grep the local checkout
  (`~/code/si/<name>`) for its importers, one hop, and name up to three
  routes that render it. Name the component too.
- Changes with no rendered effect (actions, migrations, tests, config) are not UI.
- `none` when nothing a user sees changes, including repos with no UI.

## 5. Output

Return exactly this block and nothing else. Keep `changes:` to three lines at
most, written from the diff.

```
changes: <what the code now does differently, from the diff>
UI:      <routes, with component names> | none
<KEY>:   <n>/<m> done — not done: "<requirement>" (<source>); partly: "<requirement>" (<what is missing>)
unasked: <behaviour changes no ticket asks for> | none
```

- One `<KEY>:` line per ticket. Omit the `not done` / `partly` parts when
  there are none. Count *out of scope* rows in neither n nor m.
- No ticket: `ticket:  none found`. Fetch failed: `<KEY>:   fetch failed`.
