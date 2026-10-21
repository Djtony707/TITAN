"""No-network credential preflight. Never print credentials or import model/SDK code."""
import os
import re
import sys
from collections.abc import Mapping

KEY_PATTERN = re.compile(r"[A-Za-z0-9_-]{8,128}")
SECRET_PATTERN = re.compile(r"[A-Za-z0-9_-]{32,256}")
ERROR = ("Configure private LIVEKIT_API_KEY (8-128 URL-safe characters) and "
         "LIVEKIT_API_SECRET (32-256 URL-safe characters); shared development credentials are not accepted.")


def validate_livekit_credentials(environment: Mapping[str, str] | None = None):
    environment = os.environ if environment is None else environment
    key, secret = environment.get("LIVEKIT_API_KEY"), environment.get("LIVEKIT_API_SECRET")
    if (not isinstance(key, str) or not isinstance(secret, str)
            or key == "devkey" or secret == "secret"
            or not KEY_PATTERN.fullmatch(key) or not SECRET_PATTERN.fullmatch(secret)):
        raise ValueError(ERROR)


if __name__ == "__main__":
    try:
        validate_livekit_credentials()
    except ValueError:
        print(ERROR, file=sys.stderr)
        raise SystemExit(1) from None
    print("LiveKit credential preflight passed.")
