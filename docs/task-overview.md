# Task overview

Open Agent Monitor and choose Todas las tarjetas, Necesita de mí, or Sesiones.
The task overview includes non-archived cards from all registered projects, even
Draft cards without a session. Search matches project, title, column and labels.
Opening a card preserves its project identity and uses the monitor task-detail host.

The overview reads board metadata and the live process registry. It does not call
an LLM, scan repositories, load transcripts, start agents, or approve operations.
Refresh runs every 15 seconds only while the overview is mounted; a failed project
read is visible as an incomplete snapshot, not an empty healthy project.

Held cards outrank session state. `needs-info` identifies missing information or
access; `needs-human` identifies a decision. A live session without telemetry is
unknown, not stalled. An active stage without a live or queued session needs review
before a retry. Ready means review pending, not verified deployment.

Human Draft-to-Approved moves also refresh the router-authored approval text.
This does not remove safety holds, authorize production, or rewrite task scope.

## Scope

This is the desktop surface. The companion mobile application requires its own
UI and protocol integration; a desktop change alone does not update the phone.
This change does not introduce automatic recovery or a delivery/commit action.
