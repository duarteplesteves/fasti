---
"@fastijs/scheduler": patch
---

After-commit Hooks now run when the caller is interrupted, in the Effect form. The unit of work already finished and committed, but its Hooks were lost. The caller still returns at once: the unit and its Hooks finish in the background.
