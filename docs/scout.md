# Question and metadata inspection

The optional guard is off by default. Enable FW_SCOUT_GUARD=1 only for a reviewed measurement; it has not been tested in a full live question batch.

The independent poisoned-description set has 30 cases covering instruction overrides, role headers, privilege escalation, tool references, invented figures, exfiltration, Unicode separators, HTML/URL encoding and base64. Finder integration tests show rejected candidates do not enter its model prompt, and malicious field aliases cannot reach Wirer.

The recorded metadata component uses the real free content-safety endpoint on suspicious inputs, with the daily preparation budget capped at 880 without changing the configured 900 cap. Thirty poisoned inputs were blocked. Twenty-five distinct nonempty public catalog descriptions were allowed; none triggered the second classifier. This is an input-component result, not a question answer-quality result. See evidence/scout/metadata-components.json and the captured public fixture for exact inputs and provenance.

The first two-call endpoint attempt expected JSON and failed. The failure artifact is retained. NVIDIA documents native labeled text; the corrected two-call check accepted ordinary metadata and marked the poisoned control unsafe. See the two content-safety artifacts and https://build.nvidia.com/nvidia/nemotron-3.5-content-safety/modelcard.

The unchanged upstream example corpus passes its measured intent, injection and capability thresholds with no skipped cases. It contains 32 examples and no measured override data. Broader validation and the existing out-of-scope refusal checks belong to the next authorized question measurement.

A separate regression test inspects every saved source title, description and selected field schema from the previous 25-question batch (run-2026-10-26T15-23-10-225Z). It includes empty source sets for refusals/failures rather than inventing sources. This reuses saved metadata and does not rerun those questions.
