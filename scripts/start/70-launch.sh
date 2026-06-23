# shellcheck shell=bash
# Hand off to the actual Gateway process. Must be the last sourced module.
# Uses exec so signals propagate cleanly to the Node process.
echo ""
exec pnpm start "$@"
