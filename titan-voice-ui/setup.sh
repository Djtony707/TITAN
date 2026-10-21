#!/bin/bash
# This retired UI lacks an authenticated, scoped token issuer.
# Refuse before cloning, installing, generating credentials or touching .env.local.
printf '%s\n' \
  'Legacy standalone voice UI setup is on security hold.' \
  'Use the authenticated TITAN gateway voice interface and the documented private LiveKit stack.' \
  'Existing operator files have not been changed.' >&2
exit 1
