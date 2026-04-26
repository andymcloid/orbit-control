#!/usr/bin/env bash
# Thin wrapper around scripts/orbit-ssh.js so the same invocation works
# from bash without needing sshpass or other native tools.
exec node "$(dirname "${BASH_SOURCE[0]}")/orbit-ssh.js" "$@"
