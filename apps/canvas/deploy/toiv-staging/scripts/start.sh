#!/usr/bin/env bash
# BeefTV staging is managed by systemd --user (linger=yes, user-approved 2026-10-05).
# DO NOT start tmux sessions for :8271/:8272 -- they fight these units.
systemctl --user restart beeftv-backend beeftv-web
