"""Independent service credentials; never use a gateway token or URL query token."""
import re
import secrets
from urllib.parse import urlsplit

from fastapi import HTTPException, Request, WebSocket
from config import cfg

TOKEN_PATTERN = re.compile(r"[A-Za-z0-9_-]{32,256}")
VOICE_PATTERN = re.compile(r"[A-Za-z0-9_-]{1,64}")
APPLICATION_PROTOCOL = "titan-voice-v1"


def validate_security_config():
    if not isinstance(cfg.AUTH_TOKEN, str) or not TOKEN_PATTERN.fullmatch(cfg.AUTH_TOKEN):
        raise RuntimeError("Set TITAN_VOICE_AUTH_TOKEN to a separate random URL-safe token (32-256 characters).")
    if not valid_voice(cfg.TTS_VOICE):
        raise RuntimeError("TTS_VOICE must be a bounded voice name, not a file path.")
    for origin in cfg.ALLOWED_ORIGINS:
        if "*" in origin or any(ord(char) <= 32 or ord(char) == 127 for char in origin):
            raise RuntimeError("TITAN_VOICE_ALLOWED_ORIGINS cannot contain wildcards or whitespace/control characters.")
        parsed = urlsplit(origin)
        parsed.port  # Reject invalid numeric port syntax before model startup.
        if (parsed.scheme not in ("http", "https") or not parsed.hostname
                or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment
                or origin != f"{parsed.scheme}://{parsed.netloc}"):
            raise RuntimeError("TITAN_VOICE_ALLOWED_ORIGINS must contain exact HTTP(S) origins, never wildcards.")


def _origin_allowed(headers):
    origins = headers.getlist("origin")
    return not origins or (len(origins) == 1 and origins[0] in cfg.ALLOWED_ORIGINS)


def _header_token(headers):
    values = headers.getlist("authorization")
    if len(values) != 1:
        return None
    matched = re.fullmatch(r"(?i:Bearer) ([A-Za-z0-9_-]{32,256})", values[0])
    return matched[1] if matched else None


def _matches(candidate):
    return (isinstance(candidate, str) and TOKEN_PATTERN.fullmatch(candidate) is not None
            and secrets.compare_digest(candidate, cfg.AUTH_TOKEN))


def authorize_http(request: Request):
    try:
        validate_security_config()
    except (RuntimeError, ValueError):
        raise HTTPException(503, "Voice service authentication is not configured.") from None
    if request.url.query:
        raise HTTPException(400, "Query parameters are not accepted.")
    if not _origin_allowed(request.headers):
        raise HTTPException(403, "Origin is not allowed.")
    if not _matches(_header_token(request.headers)):
        raise HTTPException(401, "Voice service authentication required.", headers={"WWW-Authenticate": "Bearer"})


def authorize_websocket(ws: WebSocket):
    """Return only the non-secret application protocol, or raise before accept()."""
    validate_security_config()
    if ws.url.query or not _origin_allowed(ws.headers):
        raise ValueError("Voice connection denied.")
    values = ws.headers.getlist("sec-websocket-protocol")
    if len(values) > 1:
        raise ValueError("Ambiguous protocols.")
    protocols = [value.strip() for value in values[0].split(",")] if values else []
    authorization = ws.headers.getlist("authorization")
    if authorization:
        if protocols not in ([], [APPLICATION_PROTOCOL]) or not _matches(_header_token(ws.headers)):
            raise ValueError("Voice connection denied.")
    elif (len(protocols) != 2 or protocols[0] != APPLICATION_PROTOCOL
          or not protocols[1].startswith("bearer.") or not _matches(protocols[1][7:])):
        raise ValueError("Voice connection denied.")
    return APPLICATION_PROTOCOL if protocols else None


def valid_voice(value):
    return isinstance(value, str) and VOICE_PATTERN.fullmatch(value) is not None
