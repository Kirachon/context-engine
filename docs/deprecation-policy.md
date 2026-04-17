# Deprecation Removal Policy

A deprecated document path must not be removed until maintainers record **documented zero-usage evidence**. Acceptable evidence can include access logs, telemetry, support or onboarding references, and repo-level grep checks across known consumers.

If any active dependency is found, removal is blocked. The default response is to extend the deprecation window, keep the doc in place or redirect it, and update the banner or archive note.

When evidence is incomplete or ambiguous, treat that the same as usage: extend the window. Final removal requires a short written record that names the evidence source, the time window checked, and the conclusion that no active dependency remains.
