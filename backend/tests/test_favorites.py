import json
import unittest
from unittest.mock import patch

from app.routers.favorites import (
    FavoritePageRequest,
    get_bilibili_favorite_page,
    parse_favorite_id,
)


class TestFavoriteIdParsing(unittest.TestCase):
    def test_parses_ml_favorite_url(self):
        self.assertEqual(
            parse_favorite_id("https://www.bilibili.com/list/ml123456789?spm_id_from=333"),
            "123456789",
        )

    def test_parses_space_favlist_url(self):
        self.assertEqual(
            parse_favorite_id("https://space.bilibili.com/123/favlist?fid=456"),
            "456",
        )

    def test_rejects_non_bilibili_hosts(self):
        with self.assertRaises(ValueError):
            parse_favorite_id("https://example.com/list/ml123")


class TestFavoritePageEndpoint(unittest.TestCase):
    def test_returns_video_page_without_returning_cookie(self):
        api_payload = {
            "code": 0,
            "data": {
                "info": {"title": "My List", "media_count": 1},
                "medias": [{
                    "bvid": "BV123",
                    "title": "Video title",
                    "cover": "https://example.com/cover.jpg",
                    "duration": 60,
                    "upper": {"name": "Uploader"},
                }],
                "has_more": False,
            },
        }
        response = type("Response", (), {
            "raise_for_status": lambda self: None,
            "json": lambda self: api_payload,
        })()
        with (
            patch("app.routers.favorites.CookieConfigManager.get", return_value="SESSDATA=secret"),
            patch("app.routers.favorites.httpx.get", return_value=response) as request,
        ):
            result = get_bilibili_favorite_page(
                FavoritePageRequest(favorite_url="https://www.bilibili.com/list/ml456", page=1)
            )

        body = json.loads(result.body)
        self.assertEqual(body["code"], 0)
        self.assertEqual(body["data"]["title"], "My List")
        self.assertEqual(body["data"]["videos"][0]["video_url"], "https://www.bilibili.com/video/BV123")
        self.assertNotIn("secret", result.body.decode("utf-8"))
        self.assertEqual(request.call_args.kwargs["headers"]["Cookie"], "SESSDATA=secret")

    def test_requires_saved_cookie(self):
        with patch("app.routers.favorites.CookieConfigManager.get", return_value=None):
            result = get_bilibili_favorite_page(
                FavoritePageRequest(favorite_url="https://www.bilibili.com/list/ml456", page=1)
            )

        body = json.loads(result.body)
        self.assertEqual(body["code"], 401)


if __name__ == "__main__":
    unittest.main()
