"""Starts `mlx_lm server` for CodeFlow (written next to the training folder by src-tauri/src/learning/serving.rs).

One change to the stock server: a malformed tool call no longer kills the request. Stock
`mlx_lm server` passes the text between the tool-call tags to `json.loads`, and the exception ends
the request without a response, so the client sees a dropped connection rather than an answer.
Here a Python literal (`{'name': 'x', ...}`, what small models often write) or doubled braces are
read, and anything else comes back as a call to `invalid_tool_call` carrying the text, which the
agent reports to the model like any unknown tool. Only the tool-call parser is affected: the request
body and the CLI flags still fail on bad JSON as before.
"""

import ast
import json
import sys

import mlx_lm.server as server


class _TolerantJson:
    JSONDecodeError = json.JSONDecodeError
    dumps = staticmethod(json.dumps)

    @staticmethod
    def loads(text, *args, **kwargs):
        try:
            return json.loads(text, *args, **kwargs)
        except json.JSONDecodeError:
            if sys._getframe(1).f_code.co_name != "parse_function":
                raise
            return _tool_call(text)


def _tool_call(text):
    body = text.strip() if isinstance(text, str) else ""
    while body.startswith("{{") and body.endswith("}}"):
        body = body[1:-1].strip()
    for read in (json.loads, ast.literal_eval):
        try:
            value = read(body)
        except Exception:
            continue
        if isinstance(value, dict):
            return value
    return {"name": "invalid_tool_call", "arguments": {"text": body[:2000]}}


server.json = _TolerantJson
sys.argv[0] = "mlx_lm.server"
server.main()
