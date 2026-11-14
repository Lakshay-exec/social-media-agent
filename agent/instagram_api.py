"""
agent/instagram_api.py
API client for Instagram Graph API via Meta Graph API v27.0.
Implements automated 60-day token exchange, automatic Page-to-Instagram ID resolution,
fetching recent media, reading comments, liking comments with rate-limit delays, and automated replies.
"""
import logging
import os
import time
import requests

logger = logging.getLogger(__name__)

GRAPH_API_VERSION = "v27.0"
GRAPH_BASE_URL = f"https://graph.facebook.com/{GRAPH_API_VERSION}"


def get_active_ig_token(state: dict) -> str | None:
    """Retrieves active Instagram token from state or environment."""
    return state.get("active_ig_token") or os.environ.get("IG_ACCESS_TOKEN")


def resolve_instagram_user_id(target_id: str, token: str) -> str:
    """
    Resolves an Instagram Business Account ID. If target_id is a Facebook Page ID,
    automatically queries Meta to extract the linked instagram_business_account ID.
    """
    url = f"{GRAPH_BASE_URL}/{target_id}"
    params = {
        "fields": "instagram_business_account,connected_instagram_account,name",
        "access_token": token,
    }
    try:
        res = requests.get(url, params=params, timeout=25)
        if res.status_code == 200:
            data = res.json()
            ig_acc = data.get("instagram_business_account") or data.get("connected_instagram_account")
            if ig_acc and ig_acc.get("id"):
                resolved_id = str(ig_acc["id"])
                logger.info(
                    "Auto-resolved Instagram Business ID '%s' from Facebook Page '%s' (%s).",
                    resolved_id, target_id, data.get("name")
                )
                return resolved_id
            else:
                logger.info("Page data returned from Meta for %s: %s", target_id, data)
    except Exception as e:
        logger.warning("Could not auto-resolve Page ID %s: %s", target_id, e)

    return target_id


def auto_refresh_ig_token(state: dict, app_id: str | None = None, app_secret: str | None = None) -> bool:
    """
    Exchanges an active long-lived Instagram/Meta user token for a refreshed 60-day token.
    Endpoint: GET https://graph.facebook.com/v27.0/oauth/access_token
    Parameters:
      grant_type=fb_exchange_token
      client_id=META_APP_ID
      client_secret=META_APP_SECRET
      fb_exchange_token=active_token
    If META_APP_ID or META_APP_SECRET are not provided, gracefully skips refresh without crashing.
    """
    token = get_active_ig_token(state)
    if not token:
        logger.info("No Instagram token provided. Skipping Instagram token refresh.")
        return False

    client_id = app_id or os.environ.get("META_APP_ID")
    client_secret = app_secret or os.environ.get("META_APP_SECRET")

    if not client_id or not client_secret:
        logger.info("META_APP_ID / META_APP_SECRET not provided. Using active Instagram token as-is.")
        return False

    try:
        logger.info("Attempting automated 60-day Instagram token renewal via Meta OAuth...")
        url = f"{GRAPH_BASE_URL}/oauth/access_token"
        params = {
            "grant_type": "fb_exchange_token",
            "client_id": client_id,
            "client_secret": client_secret,
            "fb_exchange_token": token,
        }
        res = requests.get(url, params=params, timeout=25)
        res.raise_for_status()
        data = res.json()

        new_token = data.get("access_token")
        expires_in = data.get("expires_in", 5184000)

        if new_token:
            state["active_ig_token"] = new_token
            logger.info("Instagram token renewed successfully! Valid for approx %s seconds.", expires_in)
            return True
        else:
            logger.warning("Meta OAuth response did not contain new access_token: %s", data)
            return False
    except requests.exceptions.RequestException as e:
        logger.warning("Instagram auto-refresh returned error: %s. Using existing token.", e)
        return False


def get_recent_media(ig_user_id: str, token: str, limit: int = 5) -> list[dict]:
    """
    Fetches the user's most recent published Instagram media objects.
    Endpoint: GET /{ig_user_id}/media
    """
    url = f"{GRAPH_BASE_URL}/{ig_user_id}/media"
    params = {
        "fields": "id,caption,media_type,timestamp,permalink",
        "limit": limit,
        "access_token": token,
    }
    try:
        res = requests.get(url, params=params, timeout=25)
        res.raise_for_status()
        media = res.json().get("data", [])
        logger.info("Retrieved %d recent Instagram media posts for %s.", len(media), ig_user_id)
        return media
    except requests.exceptions.RequestException as e:
        logger.error("Failed to fetch Instagram recent media for user %s: %s", ig_user_id, e)
        return []


def get_media_comments(media_id: str, token: str) -> list[dict]:
    """
    Retrieves top-level comments on a specific Instagram media post.
    Endpoint: GET /{media_id}/comments
    """
    url = f"{GRAPH_BASE_URL}/{media_id}/comments"
    params = {
        "fields": "id,text,username,timestamp,like_count",
        "access_token": token,
    }
    try:
        res = requests.get(url, params=params, timeout=25)
        res.raise_for_status()
        return res.json().get("data", [])
    except requests.exceptions.RequestException as e:
        logger.error("Failed to fetch comments for Instagram media %s: %s", media_id, e)
        return []


def like_comment(ig_user_id: str, comment_id: str, token: str) -> bool:
    """
    Likes an Instagram comment on behalf of the business/creator account.
    Endpoint: POST /{ig_user_id}/likes with JSON {"comment_id": comment_id}
    Includes a 1.5s sleep to strictly respect Meta Graph API rate limits.
    Gracefully catches permission/private account errors.
    """
    url = f"{GRAPH_BASE_URL}/{ig_user_id}/likes"
    headers = {"Authorization": f"Bearer {token}"}
    payload = {"comment_id": comment_id}

    try:
        res = requests.post(url, headers=headers, json=payload, timeout=25)
        res.raise_for_status()
        logger.info("Liked Instagram comment %s successfully.", comment_id)
        time.sleep(1.5)
        return True
    except requests.exceptions.RequestException as e:
        logger.warning("Could not like comment %s (private account or restricted permissions): %s", comment_id, e)
        time.sleep(1.5)
        return False


def reply_to_comment(comment_id: str, reply_text: str, token: str) -> dict | None:
    """
    Replies to an Instagram comment.
    Endpoint: POST /{comment_id}/replies with JSON {"message": reply_text}
    """
    url = f"{GRAPH_BASE_URL}/{comment_id}/replies"
    headers = {"Authorization": f"Bearer {token}"}
    payload = {"message": reply_text}

    try:
        logger.info("Replying to Instagram comment %s...", comment_id)
        res = requests.post(url, headers=headers, json=payload, timeout=25)
        res.raise_for_status()
        result = res.json()
        logger.info("Successfully posted reply to comment %s! Reply ID: %s", comment_id, result.get("id"))
        return result
    except requests.exceptions.RequestException as e:
        logger.error("Failed to reply to Instagram comment %s: %s", comment_id, e)
        return None
