import re
from urllib.parse import parse_qs, urlparse

import httpx
from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.services.cookie_manager import CookieConfigManager
from app.utils.response import ResponseWrapper as R

router = APIRouter()

FAVORITE_API = "https://api.bilibili.com/x/v3/fav/resource/list"
PAGE_SIZE = 20


class FavoritePageRequest(BaseModel):
    favorite_url: str = Field(min_length=1, max_length=2048)
    page: int = Field(default=1, ge=1, le=10000)


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
        bvid = media.get("bvid")
        if not bvid:
            continue
        videos.append({
            "bvid": bvid,
            "title": media.get("title") or "无标题视频",
            "cover": media.get("cover") or "",
            "duration": media.get("duration") or 0,
            "uploader": (media.get("upper") or {}).get("name") or "",
            "video_url": f"https://www.bilibili.com/video/{bvid}",
        })

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
