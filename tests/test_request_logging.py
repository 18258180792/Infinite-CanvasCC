import sys
import unittest
from pathlib import Path

from fastapi import Query
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import main


@main.app.get("/__test_request_id_ok")
async def request_id_ok():
    return {"ok": True}


@main.app.get("/__test_request_id_validation")
async def request_id_validation(value: int = Query(...)):
    return {"value": value}


@main.app.get("/__test_request_id_failure")
async def request_id_failure():
    raise RuntimeError("request logging contract failure")


class RequestLoggingTests(unittest.TestCase):
    def request(self, path, request_id):
        with TestClient(main.app, raise_server_exceptions=False) as client:
            return client.get(path, headers={"X-Request-ID": request_id})

    def test_request_id_is_returned_on_success(self):
        response = self.request("/__test_request_id_ok", "contract-200")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["X-Request-ID"], "contract-200")

    def test_request_id_is_returned_on_validation_error(self):
        response = self.request(
            "/__test_request_id_validation?value=invalid",
            "contract-422",
        )

        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.headers["X-Request-ID"], "contract-422")
        self.assertEqual(response.json()["request_id"], "contract-422")

    def test_request_id_is_returned_on_unhandled_error(self):
        response = self.request("/__test_request_id_failure", "contract-500")

        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.headers["X-Request-ID"], "contract-500")
        self.assertEqual(response.json()["request_id"], "contract-500")


if __name__ == "__main__":
    unittest.main()
