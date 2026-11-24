---
"@fastijs/scheduler": patch
---

In the Effect form, interrupting an Action (a timeout, a client disconnect) before its unit of work commits now rolls the unit back; it used to carry on in the background and commit. Work already running isn't cut short, so no statement runs outside the transaction. Interrupted during the commit, the Action waits for it, and the after-commit Hooks run if it committed.
