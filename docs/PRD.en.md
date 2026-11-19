# TingProof product requirements

English current contract · [简体中文 and detailed requirements](听校_PRD_V1.0.0.md)

Version: V1.1.11

Let a reviewer listen to an audio source while checking timestamped subtitle segments and produce a corrected transcript. The user controls the final correction and can return to the relevant source segment.

## Review workflow

Select a project and subtitle source, associate the audio and review segments in order. Support focused playback and keyboard navigation, preserve segment timing, and distinguish an inaudible or unresolved segment from one the reviewer accepted.

## Managed assignments

An owner assigns a specific task and bounded segments. An authorized reviewer reads assigned material and submits corrections. Validate identity, task, revision and deadline on the server. Task access must not imply access to other projects, tasks, original audio or exports.

## Failure and persistence

A late project or subtitle response cannot replace a newer choice. Keep drafts when a submission fails; if the result is uncertain, reread before retrying. Task history, revisions and accepted corrections survive restart. Report original-audio recovery separately from SQLite backup.

This English brief covers the current product contract. The linked specification retains the detailed feature definitions, original acceptance records and release history.

The interface defaults to English, with a persistent Simplified Chinese choice. Translate interface copy before release and retain the original language of user data.

## Built-in distribution

Publish the native application and its scoped data API as a pinned Praxis app. A fresh installation starts with empty private storage. Public source and synthetic tests ship independently of host configuration and records.
