---
"@fastijs/scheduler": patch
---

The package ships a `fasti` skill for coding agents, at `skills/fasti/SKILL.md`. `npx skills experimental_sync` links it into a project, so it updates with the installed version. It sends the agent to the guides and lists the mistakes agents make most often: `Date` instead of `Temporal`, booking a slot's `ZonedDateTime`, writes outside `tx` in `also`, and emails inside the transaction.
