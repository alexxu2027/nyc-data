"""The API error shape: {"error": {"code", "message"}} with 400 / 404 / 503 / 500 (§2.1)."""

from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

log = logging.getLogger(__name__)

CODES = {400: "bad_request", 404: "not_found", 503: "unavailable", 500: "internal"}


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def bad_request(message: str) -> ApiError:
    return ApiError(400, "bad_request", message)


def not_found(message: str) -> ApiError:
    return ApiError(404, "not_found", message)


def error_response(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse({"error": {"code": code, "message": message}}, status_code=status)


def install(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api(_: Request, e: ApiError) -> JSONResponse:
        return error_response(e.status, e.code, e.message)

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, e: RequestValidationError) -> JSONResponse:
        parts = []
        for err in e.errors():
            loc = ".".join(str(x) for x in err.get("loc", ()) if x not in ("query", "path"))
            parts.append(f"{loc}: {err.get('msg')}" if loc else str(err.get("msg")))
        return error_response(400, "bad_request", "; ".join(parts) or "invalid request")

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, e: StarletteHTTPException) -> JSONResponse:
        status = e.status_code if e.status_code in CODES else (400 if e.status_code < 500 else 500)
        return error_response(status, CODES[status], str(e.detail))

    @app.exception_handler(Exception)
    async def _internal(_: Request, e: Exception) -> JSONResponse:
        log.exception("unhandled API error")
        return error_response(500, "internal", f"{type(e).__name__}: {e}"[:300])
