---
"@fastijs/scheduler": patch
---

A search's 10,000-Grid-time limit now counts Grid times by the day: the span in days times the Grid times in a day, rounded up, because the Grid restarts at each midnight. An `interval` that divides a day is counted as before; one that doesn't reaches the limit slightly sooner.
