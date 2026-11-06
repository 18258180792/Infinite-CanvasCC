import base64
import sys
import unittest
from email import policy
from email.parser import BytesParser
from pathlib import Path
from unittest.mock import patch

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main

REAL_ASYNC_CLIENT = httpx.AsyncClient


class InlineImageEditTests(unittest.IsolatedAsyncioTestCase):
    async def generate(self, refs):
        provider = {
            'id': 'soonstudio', 'name': 'SoonStudio',
            'base_url': 'https://api-us.soonstudio.ai/v1',
            'protocol': 'openai', 'image_request_mode': 'openai',
        }
        self.requests = []

        def handler(request):
            self.requests.append(request)
            return httpx.Response(200, json={'data': [{'url': 'https://cdn.example.test/result.png'}]})

        with patch.object(main, 'get_api_provider', return_value=provider), \
             patch.object(main, 'provider_env_key_value', return_value='test-key'), \
             patch.object(main.httpx, 'AsyncClient', side_effect=lambda **kw: REAL_ASYNC_CLIENT(transport=httpx.MockTransport(handler), **kw)):
            await main.generate_ai_image('edit prompt', '2048x2048', 'auto', 'gpt-image-2', refs, 'soonstudio')

    def inline_ref(self, raw, role='source'):
        return {'url': 'data:' + 'image/png;base64,' + base64.b64encode(raw).decode(), 'kind': 'image', 'role': role}

    def image_parts(self):
        request = self.requests[0]
        self.assertEqual(request.url.path, '/v1/images/edits')
        message = BytesParser(policy=policy.default).parsebytes(
            b'Content-Type: ' + request.headers['content-type'].encode() + b'\r\n\r\n' + request.content
        )
        return [(part.get_param('name', header='content-disposition'), part.get_payload(decode=True))
                for part in message.iter_parts() if part.get_filename()]

    async def test_inline_references_survive_multipart_encoding_in_order(self):
        raw_images = [b'first image content', b'second image content']
        refs = [self.inline_ref(raw) for raw in raw_images]
        self.assertEqual(len(main.image_references(refs)), 2)
        await self.generate(refs)
        self.assertEqual(self.image_parts(), [('image', raw) for raw in raw_images])
        self.assertEqual(len(self.requests), 1)

    async def test_inline_mask_survives_multipart_encoding(self):
        await self.generate([self.inline_ref(b'image'), self.inline_ref(b'mask', 'mask')])
        self.assertEqual(self.image_parts(), [('image', b'image'), ('mask', b'mask')])

    async def test_invalid_inline_image_is_rejected_before_submit(self):
        with self.assertRaises(main.HTTPException) as caught:
            await self.generate([{'url': 'data:' + 'image/png;base64,***', 'kind': 'image'}])
        self.assertEqual(caught.exception.status_code, 400)
        self.assertEqual(self.requests, [])


if __name__ == '__main__':
    unittest.main()
