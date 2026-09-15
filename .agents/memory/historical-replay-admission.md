---
name: Historical replay admission
description: Historical Visual Review replays are long-running and must not accumulate a user-visible queue.
---

Different historical replay requests must not wait behind one another in an in-memory generation queue. Admit one replay at a time, report the admitted request as preparing/running, and reject a conflicting request with its active job identity so the user can wait or retry.

**Why:** Replay durations can span minutes; a second date request previously sat in `Queued for historical replay` behind the first and looked stuck.

**How to apply:** Preserve same-request active-job reuse, but never create a second queued job while another replay or start admission is active.