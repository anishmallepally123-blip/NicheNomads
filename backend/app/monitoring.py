"""Optional Sentry error reporting. Off unless SENTRY_DSN is set."""
from __future__ import annotations

import logging

from . import config

log = logging.getLogger(__name__)


def init_monitoring() -> bool:
    if not config.SENTRY_DSN:
        return False
    try:
        import sentry_sdk
    except ImportError:
        log.warning("SENTRY_DSN is set but sentry-sdk is not installed; error reporting is off")
        return False
    sentry_sdk.init(
        dsn=config.SENTRY_DSN,
        environment=config.SENTRY_ENVIRONMENT,
        release=config.APP_VERSION,
        traces_sample_rate=config.SENTRY_TRACES_SAMPLE_RATE,
        send_default_pii=False,
    )
    log.info("Sentry error reporting is on (%s)", config.SENTRY_ENVIRONMENT)
    return True
