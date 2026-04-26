# Changelog

## [0.2.1] - 2026-04-26

### Security

- Transcript compactor now routes JSONL lines through a sanitize helper (ported from consult/acp/run.js) that redacts AWS AKIA, ghp_/gho_/ghu_/ghs_, OpenAI sk-/Anthropic sk-ant-, JWTs, generic hex tokens (>=32 chars), and Shannon-entropy-detected secrets. Previously transcripts with accidentally-pasted API keys flowed unredacted into knowledge files.

## [0.2.0] - 2026-03-16

Initial tracked release.
