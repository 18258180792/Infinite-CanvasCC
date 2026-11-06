import base64
import io
import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main

REAL_ASYNC_CLIENT = httpx.AsyncClient
MODEL = 'Dola-Seedream-5.0-Flash'
RESULT = {'data': [{'url': 'https://cdn.example.test/result.png'}]}


class SoonStudioDolaTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.provider = {
            'id': 'soonstudio', 'name': 'SoonStudio',
            'base_url': 'https://api-us.soonstudio.ai/v1',
            'protocol': 'openai', 'image_request_mode': 'openai',
            'model_groups': {MODEL: 'sd-global'},
        }
        self.requests = []

    def inline_png(self, size=(16, 16), pixels=None):
        image = Image.frombytes("RGB", size, pixels) if pixels is not None else Image.new("RGB", size, (20, 30, 40))
        output = io.BytesIO()
        image.save(output, format="PNG")
        return {"url": "data:" + "image/png;base64," + base64.b64encode(output.getvalue()).decode(), "kind": "image"}

    async def generate(self, refs=None, resolution='2k', replies=None, model=MODEL):
        remaining = list(replies if replies is not None else [RESULT])

        def handler(request):
            self.requests.append(request)
            self.assertTrue(remaining, 'Unexpected upstream request')
            reply = remaining.pop(0)
            if isinstance(reply, Exception):
                raise reply
            if isinstance(reply, tuple):
                return httpx.Response(reply[0], json=reply[1])
            return httpx.Response(200, json=reply)

        with patch.object(main, 'get_api_provider', return_value=self.provider), \
             patch.object(main, 'provider_env_key_value', return_value='test-key'), \
             patch.object(main.asyncio, 'sleep', new=AsyncMock()), \
             patch.object(main.httpx, 'AsyncClient', side_effect=lambda **kw: REAL_ASYNC_CLIENT(transport=httpx.MockTransport(handler), **kw)):
            return await main.generate_ai_image(
                'test prompt', '2048x2048', 'auto', model, refs, 'soonstudio', resolution=resolution,
            )

    async def test_inline_and_https_images_use_compact_json_edits_contract(self):
        refs = [
            self.inline_png(),
            {'url': 'https://cdn.example.test/reference.png', 'kind': 'image'},
        ]
        result, _ = await self.generate(refs)
        self.assertEqual(result['value'], RESULT['data'][0]['url'])
        self.assertEqual(len(self.requests), 1)
        request = self.requests[0]
        self.assertEqual(request.method, 'POST')
        self.assertEqual(request.url.path, '/v1/images/edits')
        self.assertEqual(request.url.params['async'], 'true')
        self.assertEqual(request.headers['content-type'], 'application/json')
        body = json.loads(request.content)
        self.assertEqual(body['imageUrls'][1], refs[1]['url'])
        self.assertTrue(body['imageUrls'][0].startswith("data:" + "image/jpeg;base64,"))
        image_fields = {"image", "imageUrl", "images", "imageUrls"} & set(body)
        self.assertEqual(image_fields, {"imageUrls"})
        self.assertEqual(request.content.count(body['imageUrls'][0].encode()), 1)
        self.assertEqual(body['resolution'], '2k')
        self.assertEqual(body['outputFormat'], 'jpeg')
        self.assertNotIn('size', body)
        self.assertNotIn('quality', body)
        self.assertEqual(request.headers['x-studio-channel-group'], 'sd-global')
        self.assertEqual(request.headers['x-studio-request-model'], MODEL)

    async def test_large_inline_reference_is_resized_and_sent_once(self):
        size = (1800, 1200)
        ref = self.inline_png(size=size, pixels=os.urandom(size[0] * size[1] * 3))
        request_limit = 1024 * 1024
        with patch.object(main, "SOONSTUDIO_SEEDREAM_MAX_REQUEST_BYTES", request_limit):
            await self.generate([ref])

        request = self.requests[0]
        body = json.loads(request.content)
        self.assertEqual(set(body) & {"image", "imageUrl", "images", "imageUrls"}, {"imageUrls"})
        data_url = body['imageUrls'][0]
        self.assertEqual(request.content.count(data_url.encode()), 1)
        self.assertLess(len(request.content), request_limit)
        _header, encoded = data_url.split(",", 1)
        with Image.open(io.BytesIO(base64.b64decode(encoded))) as image:
            self.assertEqual(image.size, (1024, 683))
            self.assertEqual(image.format, "JPEG")

    async def test_text_to_image_uses_generations_without_references(self):
        await self.generate([])
        self.assertEqual(self.requests[0].url.path, '/v1/images/generations')
        body = json.loads(self.requests[0].content)
        for key in ('images', 'imageUrls', 'image', 'imageUrl'):
            self.assertNotIn(key, body)

    async def test_local_reference_is_converted_without_cloud_upload(self):
        refs = [{'url': '/assets/uploads/reference.png'}]
        encoded = 'data:' + 'image/png;base64,' + base64.b64encode(b'local image').decode()
        with patch.object(main, 'reference_to_data_url', return_value=encoded) as convert, \
             patch.object(main, 'upload_local_video_to_cloud', new=AsyncMock()) as upload:
            await self.generate(refs)
        convert.assert_called_once_with(refs[0], max_size=1536)
        upload.assert_not_awaited()
        self.assertEqual(json.loads(self.requests[0].content)['imageUrls'], [encoded])

    async def test_seedream_pro_uses_same_json_edit_contract(self):
        await self.generate([{'url': 'https://cdn.example.test/input.png'}], model='seedream-v5-pro')
        self.assertEqual(self.requests[0].url.path, '/v1/images/edits')
        self.assertEqual(json.loads(self.requests[0].content)['model'], 'seedream-v5-pro')

    async def test_polling_preserves_group_and_model_headers(self):
        task_id = 'task-seedream-123'
        await self.generate([{'url': 'https://cdn.example.test/input.png'}], replies=[
            {'task_id': task_id},
            {'data': {'status': 'IN_PROGRESS'}},
            {'data': {'status': 'SUCCESS', 'data': RESULT}},
        ])
        self.assertEqual([r.method for r in self.requests], ['POST', 'GET', 'GET'])
        for request in self.requests[1:]:
            self.assertEqual(request.url.path, '/v1/images/tasks/' + task_id)
            self.assertEqual(request.content, b'')
            self.assertEqual(request.headers['x-studio-channel-group'], 'sd-global')
            self.assertEqual(request.headers['x-studio-request-model'], MODEL)

    async def test_failed_task_preserves_task_id_without_resubmission(self):
        with self.assertRaises(main.HTTPException) as caught:
            await self.generate(replies=[{'task_id': 'task-seedream-123'}, {'status': 'FAILURE', 'fail_reason': 'rejected'}])
        self.assertEqual(caught.exception.upstream_task_id, 'task-seedream-123')
        self.assertEqual([r.method for r in self.requests], ['POST', 'GET'])

    async def test_lost_submission_response_does_not_retry(self):
        with self.assertRaises(main.HTTPException) as caught:
            await self.generate(replies=[httpx.ReadError('connection lost')])
        self.assertIn('无法确认', caught.exception.detail)
        self.assertEqual(len(self.requests), 1)

    async def test_http_error_does_not_fallback_to_generations(self):
        with self.assertRaises(httpx.HTTPStatusError):
            await self.generate([{'url': 'https://cdn.example.test/input.png'}], replies=[(400, {'error': 'bad request'})])
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(self.requests[0].url.path, '/v1/images/edits')

    async def test_mask_is_rejected_before_submission(self):
        with self.assertRaises(main.HTTPException) as caught:
            await self.generate([{'url': 'https://cdn.example.test/mask.png', 'role': 'mask'}])
        self.assertEqual(caught.exception.status_code, 400)
        self.assertEqual(self.requests, [])

    async def test_excess_references_are_not_silently_truncated(self):
        with self.assertRaises(main.HTTPException) as caught:
            await self.generate([{'url': f'https://cdn.example.test/{i}.png'} for i in range(11)])
        self.assertEqual(caught.exception.status_code, 400)
        self.assertEqual(self.requests, [])

    async def test_dola_defaults_to_documented_group(self):
        self.provider['model_groups'] = {}
        await self.generate()
        self.assertEqual(self.requests[0].headers['x-studio-channel-group'], 'sd-global')

    async def test_supported_resolution_is_preserved(self):
        await self.generate(resolution='1.5k')
        self.assertEqual(json.loads(self.requests[0].content)['resolution'], '1.5k')

    async def test_other_provider_keeps_existing_protocol(self):
        self.provider['base_url'] = 'https://other.example.test/v1'
        await self.generate()
        body = json.loads(self.requests[0].content)
        self.assertIn('size', body)
        self.assertNotIn('x-studio-request-model', self.requests[0].headers)


if __name__ == '__main__':
    unittest.main()
