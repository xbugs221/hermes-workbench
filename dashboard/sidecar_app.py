"""Run Hermes Workbench assets and APIs as an independently deployable sidecar.

The browser still reaches this app through the authenticated Hermes Caddy
origin. API and WebSocket requests additionally require Caddy's trusted-proxy
secret and an instance-scoped Remote-User value.
"""

from __future__ import annotations

import asyncio
import hmac
from contextlib import asynccontextmanager
import json
import os
import sys
from pathlib import Path
from typing import Any, Awaitable, Callable

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse

_MODULE_ROOT = Path(__file__).resolve().parent
if str(_MODULE_ROOT) not in sys.path:
    sys.path.insert(0, str(_MODULE_ROOT))

import plugin_api
import skill_files
from workbench_version_manager import create_router as create_version_router, begin_mutation, end_mutation

ASGIApp = Callable[
    [dict[str, Any], Callable[..., Awaitable[Any]], Callable[..., Awaitable[Any]]],
    Awaitable[None],
]

_API_PREFIX = "/api/plugins/workbench"
_ASSET_HEADERS = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
}


class TrustedProxyGate:
    """Fail closed unless Caddy vouches for an allowed Hermes dashboard user."""

    def __init__(self, app: ASGIApp) -> None:
        """Capture instance authentication settings once at process startup."""

        self.app = app
        self.secret = os.environ.get("HERMES_DASHBOARD_TRUSTED_PROXY_SECRET", "")
        configured = os.environ.get("HERMES_WORKBENCH_ALLOWED_USERS", "")
        self.allowed_users = {
            value.strip().lower() for value in configured.split(",") if value.strip()
        }

    def _authorized(self, scope: dict[str, Any]) -> bool:
        """Validate both the unforgeable proxy secret and mapped user identity."""

        headers = {
            key.decode("latin-1").lower(): value.decode("latin-1")
            for key, value in scope.get("headers", [])
        }
        supplied = headers.get("x-hermes-proxy-secret", "")
        remote_user = headers.get("remote-user", "").strip().lower()
        return bool(
            self.secret
            and supplied
            and self.allowed_users
            and hmac.compare_digest(supplied, self.secret)
            and remote_user in self.allowed_users
        )

    async def __call__(
        self,
        scope: dict[str, Any],
        receive: Callable[..., Awaitable[Any]],
        send: Callable[..., Awaitable[Any]],
    ) -> None:
        """Protect Workbench APIs while leaving health and static assets probeable."""

        path = str(scope.get("path", ""))
        requires_auth = path == _API_PREFIX or path.startswith(f"{_API_PREFIX}/")
        if not requires_auth:
            await self.app(scope, receive, send)
            return
        if self._authorized(scope):
            scope.setdefault("state", {})["workbench_authenticated"] = True
            mutation = (scope.get('type') == 'websocket' or scope.get('method') not in ['GET', 'HEAD', 'OPTIONS']) and path != _API_PREFIX + '/versions/switch'
            if mutation and not begin_mutation():
                if scope.get('type') == 'websocket':
                    await send({'type': 'websocket.close', 'code': 1013, 'reason': 'Workbench updating'})
                else:
                    await JSONResponse({'detail': 'Workbench 正在更新，请稍后重试。'}, status_code=409)(scope, receive, send)
                return
            try:
                await self.app(scope, receive, send)
            finally:
                if mutation:
                    end_mutation()
            return
        if scope.get("type") == "websocket":
            await send({"type": "websocket.close", "code": 4401, "reason": "Unauthorized"})
            return
        response = JSONResponse({"detail": "Unauthorized"}, status_code=401)
        await response(scope, receive, send)


def _release_version(root: Path) -> str:
    """Read the release identity from the thin-plugin manifest."""

    try:
        payload = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
        return str(payload.get("version") or "unknown")
    except (OSError, ValueError, TypeError):
        return "unknown"


def create_app(release_root: Path | None = None, *, codex_service: Any = None) -> FastAPI:
    """Build the sidecar app around one immutable release directory."""

    root = (release_root or Path(__file__).resolve().parent).resolve()
    assets = root / "dist"
    update_manager = None
    if os.environ.get("CODEX_APP_SERVER_ENDPOINT"):
        from codex_update_manager import CodexUpdateManager, run_auto_updates

        update_manager = CodexUpdateManager()

    @asynccontextmanager
    async def lifespan(application: FastAPI):
        """Start update checks and release client connections on sidecar shutdown."""
        bridge = getattr(application.state, "codex_bridge", None)
        if bridge is not None and hasattr(bridge, "start_integrations"):
            await bridge.start_integrations()
        update_task = None
        if update_manager is not None:
            update_task = asyncio.create_task(run_auto_updates(update_manager))
        try:
            yield
        finally:
            if update_task is not None:
                update_task.cancel()
                await asyncio.gather(update_task, return_exceptions=True)
            bridge = getattr(application.state, "codex_bridge", None)
            if bridge is not None:
                await bridge.close()

    app = FastAPI(
        lifespan=lifespan,
        title="Hermes Workbench Sidecar",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.include_router(plugin_api.router, prefix=_API_PREFIX)
    app.include_router(create_version_router(), prefix=_API_PREFIX)
    app.include_router(skill_files.router, prefix=_API_PREFIX)
    if update_manager is not None:
        from codex_update_manager import create_router as create_codex_update_router

        app.include_router(create_codex_update_router(update_manager), prefix=f"{_API_PREFIX}/codex-runtime")
    if codex_service is not None or os.environ.get("CODEX_APP_SERVER_ENDPOINT"):
        from codex_files import create_router as create_files_router
        from codex_bridge import create_router
        from codex_integration import build_bridge

        service = codex_service or build_bridge()
        app.state.codex_bridge = service
        app.include_router(create_router(service), prefix=f"{_API_PREFIX}/codex")
        app.include_router(create_files_router(service), prefix=f"{_API_PREFIX}/codex")

    @app.get(f"{_API_PREFIX}/capabilities")
    async def capabilities() -> dict[str, bool]:
        """Declare chat ownership without probing or launching a model connection."""
        return {"codexChat": getattr(app.state, "codex_bridge", None) is not None}

    @app.get("/health")
    async def health() -> dict[str, str]:
        """Report readiness only when both browser assets are present."""

        if not (assets / "index.js").is_file() or not (assets / "style.css").is_file():
            raise HTTPException(status_code=503, detail="Workbench assets are missing")
        return {"status": "ok", "version": _release_version(root)}

    @app.get("/workbench-sidecar/index.js")
    async def javascript() -> FileResponse:
        """Serve the immutable Workbench browser runtime through the Hermes origin."""

        target = assets / "index.js"
        if not target.is_file():
            raise HTTPException(status_code=404, detail="Workbench JavaScript is missing")
        return FileResponse(target, media_type="text/javascript", headers=_ASSET_HEADERS.copy())

    @app.get("/workbench-sidecar/style.css")
    async def stylesheet() -> FileResponse:
        """Serve Workbench styles separately so the thin loader stays stable."""

        target = assets / "style.css"
        if not target.is_file():
            raise HTTPException(status_code=404, detail="Workbench stylesheet is missing")
        return FileResponse(target, media_type="text/css", headers=_ASSET_HEADERS.copy())

    app.add_middleware(TrustedProxyGate)
    return app


app = create_app()


def main() -> None:
    """Start the sidecar on its private Docker-network port."""

    import uvicorn

    port = int(os.environ.get("HERMES_WORKBENCH_PORT", "8787"))
    uvicorn.run(app, host=os.environ.get("HERMES_WORKBENCH_HOST", "0.0.0.0"), port=port, log_level="info", proxy_headers=False)


if __name__ == "__main__":
    main()
