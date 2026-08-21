# Triage labels

The private local tracker uses the canonical triage role strings directly.

| Canonical role    | Local status      | Meaning                                              |
| ----------------- | ----------------- | ---------------------------------------------------- |
| `needs-triage`    | `needs-triage`    | Maintainer needs to evaluate the ticket              |
| `needs-info`      | `needs-info`      | Work is waiting for missing information              |
| `ready-for-agent` | `ready-for-agent` | Fully specified and ready for AFK implementation     |
| `ready-for-human` | `ready-for-human` | Requires a human decision, review, or implementation |
| `wontfix`         | `wontfix`         | Will not be actioned                                 |

`completed` is a local lifecycle status, not a triage role. Apply it only after
all acceptance criteria and the ticket's verification evidence pass.

When an AFK ticket is approved and has no unresolved blocker, use
`ready-for-agent`. Keep HITL tickets at `ready-for-human` until their named
decision has been made.
