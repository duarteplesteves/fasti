---
"@fastijs/scheduler": patch
---

On a spring-forward day, an availability rule's window with an edge in the missing hour is now clipped to the times that exist, and one wholly inside it opens nothing. Before, the edge moved forward, so people could be booked outside the rule's hours, and `expandRules` could return a window ending before it starts.
