# Development prompts for Codex / Antigravity

## P1 — Windows E2E and reliability

"Read ARCHITECTURE.md, SECURITY.md, GAP_MATRIX.md and all source. Run npm install, Python requirements, `npm run typecheck`, `npm test`, desktop policy tests and an E2E fixture on Windows 11. Fix type errors, report each exact command, screenshot and observed result. Preserve source and secrets. Never silently press quiz submit."

## P2 — Site-specific LMS integrations

"Implement a Moodle adapter with explicit user consent, course list navigation, activity discovery, deadlines and quiz/assignment form inspection. Cover Google Forms and Microsoft Forms with separate ARIA/iframe/custom-control adapters. Use test fixtures and allowed school sandbox accounts only. Do not claim pass on live LMS without evidence."

## P3 — AI answer quality

"Build a permissioned evaluation suite for multiple choice, multi-select, paragraphs, image/chart/math interpretation. Include confidence and missing-field detection, alternative-model retries and no hallucinated official grades. Validate forms after fill and pause before submission. Report precision/recall/accuracy on a held-out set."

## P4 — Windows release + terminal UX

"Polish the two theme selectors, Windows Terminal profile export, first-run vault setup and multi-account flow. Provide a signed installer plan, privacy disclosure, logs with secret redaction, recovery and auto-update design. Verify screens on Windows Terminal and VS Code terminal."
