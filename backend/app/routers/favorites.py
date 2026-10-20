import logging
import re
from urllib.parse import parse_qs, urlparse

import httpx
from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.services.cookie_manager import CookieConfigManager
from app.utils.response import ResponseWrapper as R

router = APIRouter()

FAVORITE_API = "https://api.bilibili.com/x/v3/fav/resource/list"
VIDEO_INFO_API = "https://api.bilibili.com/x/web-interface/view"
PAGE_SIZE = 20
logger = logging.getLogger(__name__)


class FavoritePageRequest(BaseModel):
    favorite_url: str = Field(min_length=1, max_length=2048)
    page: int = Field(default=1, ge=1, le=10000)


def _page_count(media: dict) -> int:
    try:
        return max(int(media.get("page") or 1), 1)
    except (TypeError, ValueError):
        return 1


def _get_page_titles(bvid: str, headers: dict) -> dict[int, str]:
    try:
        response = httpx.get(VIDEO_INFO_API, params={"bvid": bvid}, headers=headers, timeout=20.0)
        response.raise_for_status()
        payload = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        logger.warning("读取 Bilibili 分 P 标题失败 (%s): %s", bvid, exc)
        return {}

    if payload.get("code") != 0:
        logger.warning("读取 Bilibili 分 P 标题失败 (%s): %s", bvid, payload.get("message") or payload.get("msg"))
        return {}

    titles = {}
    for page in (payload.get("data") or {}).get("pages") or []:
        try:
            page_number = int(page.get("page"))
        except (TypeError, ValueError):
            continue
        title = (page.get("part") or "").strip()
        if title:
            titles[page_number] = title
    return titles


def _expand_media(media: dict, page_titles: dict[int, str] | None = None) -> list[dict]:
    bvid = media.get("bvid")
    if not bvid:
        return []

    page_count = _page_count(media)
    base = {
        "bvid": bvid,
        "title": media.get("title") or "无标题视频",
        "cover": media.get("cover") or "",
        "duration": media.get("duration") or 0,
        "uploader": (media.get("upper") or {}).get("name") or "",
        "page_count": page_count,
    }
    if page_count == 1:
        return [{
            **base,
            "video_key": bvid,
            "video_url": f"https://www.bilibili.com/video/{bvid}",
        }]

    return [{
        **base,
        "video_key": f"{bvid}_p{page_number}",
        "title": (page_titles or {}).get(page_number) or base["title"],
        "page_number": page_number,
        "video_url": f"https://www.bilibili.com/video/{bvid}?p={page_number}",
    } for page_number in range(1, page_count + 1)]


def parse_favorite_id(value: str) -> str:
    value = value.strip()
    if re.fullmatch(r"\d+", value):
        return value

    if not re.match(r"^https?://", value, re.IGNORECASE):
        value = f"https://{value}"

    parsed = urlparse(value)
    hostname = (parsed.hostname or "").lower()
    if not (hostname == "bilibili.com" or hostname.endswith(".bilibili.com")):
        raise ValueError("请输入 Bilibili 收藏夹链接或收藏夹 ID")

    match = re.search(r"/list/ml(\d+)(?:/|$)", parsed.path)
    if match:
        return match.group(1)

    folder_id = parse_qs(parsed.query).get("fid", [None])[0]
    if folder_id and folder_id.isdigit():
        return folder_id

    raise ValueError("链接中没有识别到收藏夹 ID，请使用 /list/ml... 或 favlist?fid=... 链接")


@router.post("/bilibili/favorites/page")
def get_bilibili_favorite_page(data: FavoritePageRequest):
    try:
        favorite_id = parse_favorite_id(data.favorite_url)
    except ValueError as exc:
        return R.error(msg=str(exc), code=400)

    cookie = CookieConfigManager().get("bilibili")
    if not cookie:
        return R.error(
            msg="请先在「设置 → 下载器配置 → Bilibili」保存登录 Cookie，再读取私人收藏夹",
            code=401,
        )

    params = {
        "media_id": favorite_id,
        "pn": data.page,
        "ps": PAGE_SIZE,
        "keyword": "",
        "order": "mtime",
        "type": 0,
        "tid": 0,
        "platform": "web",
    }
    headers = {
        "Cookie": cookie,
        "Referer": "https://www.bilibili.com/",
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    }

    try:
        response = httpx.get(FAVORITE_API, params=params, headers=headers, timeout=20.0)
        response.raise_for_status()
        payload = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        return R.error(msg=f"读取 Bilibili 收藏夹失败：{exc}", code=502)

    if payload.get("code") != 0:
        api_message = payload.get("message") or payload.get("msg") or "未知错误"
        if payload.get("code") in (-101, -111, -352):
            return R.error(msg="Bilibili 登录状态无效或需要重新验证，请更新设置中的 Cookie", code=401)
        return R.error(msg=f"Bilibili 收藏夹读取失败：{api_message}", code=502)

    data_payload = payload.get("data") or {}
    info = data_payload.get("info") or {}
    medias = data_payload.get("medias") or []
    videos = []
    for media in medias:
        page_count = _page_count(media)
        page_titles = _get_page_titles(media["bvid"], headers) if page_count > 1 and media.get("bvid") else {}
        videos.extend(_expand_media(media, page_titles))

    media_count = int(info.get("media_count") or 0)
    return R.success(data={
        "favorite_id": favorite_id,
        "title": info.get("title") or "Bilibili 收藏夹",
        "media_count": media_count,
        "page": data.page,
        "page_size": PAGE_SIZE,
        "videos": videos,
        "has_more": bool(data_payload.get("has_more", data.page * PAGE_SIZE < media_count)),
    })
