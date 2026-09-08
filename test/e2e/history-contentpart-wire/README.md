# History ContentPart wire harness

This directory is a controlled headless harness only. It does not implement the
history/content-part product fix and it must not be used as proof that the real
Studio UI or a third-party provider accepts a request.

The driver uses the real `ForgeaxCoreKernel` and the real CLI provider factory:

```bash
cd /Users/you/extensions/github/forgeax-studio4/.worktrees/history-image-fix-e2e

# Terminal 1: one provider phase, bound to loopback only.
bun packages/cli/test/e2e/history-contentpart-wire/gateway.ts \
  --provider openai-compat --case HIST-INLINE-01 --port 29612 \
  --manifest /tmp/history-contentpart-wire/HIST-INLINE-01.manifest.json

# Terminal 2: real kernel -> resolveProvider() -> real adapter -> loopback gateway.
bun packages/cli/test/e2e/history-contentpart-wire/headless-driver.ts \
  --provider openai-compat --case HIST-INLINE-01 \
  --gateway-url http://127.0.0.1:29612 \
  --output /tmp/history-contentpart-wire/HIST-INLINE-01.driver.json
```

Supported case entry points are `HIST-INLINE-01`, `HIST-TOOL-01`,
`HIST-TOOL-FILE-01`, `DEGRADE-AV-01`, `WIRE-ANT-01`, `WIRE-OAI-01`,
`WIRE-RESP-01`, `WIRE-GEM-01`, `NEG-UNKNOWN-01`, `NEG-EMPTY-01`,
`NEG-PATH-01`, and `GEM-NAME-01`. Use one gateway process per provider phase;
the gateway port and `--provider` must agree.

The gateway writes only redacted JSONL and validator summaries when `--manifest`
is supplied. It rejects unknown routes, non-loopback startup, malformed case or
turn headers, host residue, path/sentinel leaks, empty protocol messages, and
Gemini `unknown_tool`. A rejected request is supporting negative evidence; it is
not a product PASS.

`HIST-TOOL-01` records the raw `tool.result` event and then uses a controlled
canonical projection to exercise the next real provider call. The harness does
not claim that this projection proves product ledger persistence; the product
projection gap remains a separate acceptance blocker until the host/orchestrator
path is wired.

For all live acceptance cases, preserve the evidence directory and add fresh
provenance, gateway wire/validator output, driver output, and cleanup records.
Do not use `mapHistory()` directly, patch provider behavior here, or call a
neighboring checkout.
