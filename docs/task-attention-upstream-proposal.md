# Proposal: cross-project attention and human responses

Status: local implementation under validation, not an upstream submission.

## User problem

The session monitor omits useful work without a session, including drafts and
tasks waiting for information. A person using several projects must open boards
and terminal transcripts to discover what requires a decision. A held card can
also display a running database record without a corresponding live process.

## Proposed upstream slices

1. Cross-project task overview, independent of the terminal session list.
   Include project identity, column, partial-read failures, live/queued state,
   and an explicit next action. Reads must not launch an LLM or load transcripts.
2. Human question and answer lifecycle with project-scoped revision checks.
   Save an answer separately from resuming work. Preserve manual/safety holds,
   fail closed for agent callers, and never convert an answer into tool approval.
3. Companion parity: read all boards, capture inert drafts, answer and resume
   through authenticated capabilities using the same desktop handlers.

The local implementation currently uses workflow label/heading conventions and
named execution columns. Those conventions should become an explicit configurable
contract or a first-class typed state before a general-purpose upstream merge.
Spanish UI copy also needs integration with upstream's localization policy.

## Safety and compatibility

- Unknown or incomplete state stays unknown. Silence is not evidence of failure.
- A manual resume requires a previously approved scope and a current revision.
- Working sessions and permission prompts are not automatically interrupted or approved.
- Duplicate requests must not spawn duplicate agents. Uncertain startup fails held.
- The mobile protocol's optional human_response_revision advertises support.
  Older desktops omit it; newer phones hide these actions rather than guessing.
- The new board-write commands validate human provenance and explicit project.
  They are not registered as model-facing MCP tools.
- Publish a coordinated protocol version before upstream mobile consumption.
  The private relative file dependency is not an upstream distribution strategy.

## Not part of the generic PR

Personal model routing, subscription thresholds, private service connectors,
project names, personal task evidence, local deployment configuration, and
business integrations. No credentials, task databases, transcripts or telemetry
payloads should be included.

## Validation still required before proposing merge

Real desktop/mobile lifecycle validation including reconnect during save/resume,
stale revisions, repeated taps, queued sessions, aborted startup and partial reads.
Component and unit tests cover part of this, not the full native lifecycle.
The first PR should contain only the independent overview if human-response
semantics cannot yet be made generic and proven end to end.

No PR, public branch, package publication, or store release has been created.
