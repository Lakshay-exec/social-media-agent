"""
agent/threads_api.py
API client for Meta Threads Graph API (https://graph.threads.net/v1.0).
Implements automated 60-day token refresh, 2-step post creation & publishing,
and comment retrieval and replies.
"""
import logging
import os
import time
import requests

logger = logging.getLogger(__name__)

THREADS_BASE_URL = "https://graph.threads.net/v1.0"
THREADS_REFRESH_URL = "https://graph.threads.net/refresh_access_token"


def get_active_threads_token(state: dict) -> str | None:
    """Retrieves active Threads token from state or environment."""
    return state.get("active_threads_token") or os.environ.get("THREADS_ACCESS_TOKEN")


def auto_refresh_threads_token(state: dict) -> bool:
    """
    Refreshes the long-lived Threads access token via GET /refresh_access_token.
    Renews the token for an additional 60 days and stores it in state.
    """
    token = get_active_threads_token(state)
    if not token:
        logger.warning("No Threads token available to refresh.")
        return False

    try:
        logger.info("Attempting automated 60-day Threads access token renewal...")
        params = {
            "grant_type": "th_refresh_token",
            "access_token": token,
        }
        res = requests.get(THREADS_REFRESH_URL, params=params, timeout=25)
        res.raise_for_status()
        data = res.json()

        new_token = data.get("access_token")
        expires_in = data.get("expires_in", 5184000)

        if new_token:
            state["active_threads_token"] = new_token
            logger.info("Threads token renewed successfully! Valid for approx %s seconds.", expires_in)
            return True
        else:
            logger.warning("Threads refresh response did not contain new access_token: %s", data)
            return False
    except requests.exceptions.RequestException as e:
        logger.warning("Threads auto-refresh request returned error: %s. Using existing token.", e)
        return False


def publish_threads_post(post_text: str, state: dict, user_id: str) -> dict:
    """
    Publishes a new text post to Meta Threads using the official 2-step container flow.
    Step 1: POST /{user_id}/threads (media_type=TEXT, text=post_text)
    Step 2: Sleep 30s for Meta container processing
    Step 3: POST /{user_id}/threads_publish (creation_id=container_id)
    """
    token = get_active_threads_token(state)
    if not token or not user_id:
        raise ValueError("Missing Threads credentials (token or user_id).")

    headers = {"Authorization": f"Bearer {token}"}

    # Step 1: Create Container
    logger.info("Step 1: Creating Threads post container...")
    create_url = f"{THREADS_BASE_URL}/{user_id}/threads"
    create_payload = {
        "media_type": "TEXT",
        "text": post_text,
    }
    create_res = requests.post(create_url, headers=headers, json=create_payload, timeout=30)
    create_res.raise_for_status()
    container_id = create_res.json().get("id")
    if not container_id:
        raise RuntimeError(f"Failed to obtain container ID from Meta: {create_res.text}")

    logger.info("Container %s created. Waiting 30s for Meta processing...", container_id)
    time.sleep(30)

    # Step 2: Publish Container
    logger.info("Step 2: Publishing container %s...", container_id)
    publish_url = f"{THREADS_BASE_URL}/{user_id}/threads_publish"
    publish_payload = {"creation_id": container_id}
    publish_res = requests.post(publish_url, headers=headers, json=publish_payload, timeout=30)
    publish_res.raise_for_status()
    result = publish_res.json()
    logger.info("Successfully published thread post! ID: %s", result.get("id"))
    return result


def get_recent_threads(state: dict, user_id: str, limit: int = 3) -> list[dict]:
    """Retrieves recent thread posts for the authenticated user."""
    token = get_active_threads_token(state)
    if not token or not user_id:
        return []

    headers = {"Authorization": f"Bearer {token}"}
    url = f"{THREADS_BASE_URL}/{user_id}/threads"
    params = {"fields": "id,text,timestamp", "limit": limit}

    try:
        res = requests.get(url, headers=headers, params=params, timeout=25)
        res.raise_for_status()
        data = res.json().get("data", [])
        logger.info("Retrieved %d recent threads.", len(data))
        return data
    except requests.exceptions.RequestException as e:
        logger.error("Failed to fetch recent threads: %s", e)
        return []


def get_thread_replies(thread_id: str, state: dict) -> list[dict]:
    """Retrieves replies / comments on a specific thread."""
    token = get_active_threads_token(state)
    if not token:
        return []

    headers = {"Authorization": f"Bearer {token}"}
    url = f"{THREADS_BASE_URL}/{thread_id}/replies"
    params = {"fields": "id,text,username,timestamp"}

    try:
        res = requests.get(url, headers=headers, params=params, timeout=25)
        res.raise_for_status()
        return res.json().get("data", [])
    except requests.exceptions.RequestException as e:
        logger.error("Failed to fetch replies for thread %s: %s", thread_id, e)
        return []


def reply_to_thread(reply_to_id: str, reply_text: str, state: dict, user_id: str) -> dict:
    """
    Replies to a thread or comment using the 2-step container flow with reply_to_id.
    """
    token = get_active_threads_token(state)
    if not token or not user_id:
        raise ValueError("Missing Threads credentials for reply.")

    headers = {"Authorization": f"Bearer {token}"}

    # Step 1: Create Reply Container
    logger.info("Creating Threads reply container for target %s...", reply_to_id)
    create_url = f"{THREADS_BASE_URL}/{user_id}/threads"
    create_payload = {
        "media_type": "TEXT",
        "text": reply_text,
        "reply_to_id": reply_to_id,
    }
    create_res = requests.post(create_url, headers=headers, json=create_payload, timeout=30)
    create_res.raise_for_status()
    container_id = create_res.json().get("id")

    logger.info("Reply container %s created. Waiting 30s...", container_id)
    time.sleep(30)

    # Step 2: Publish Reply
    publish_url = f"{THREADS_BASE_URL}/{user_id}/threads_publish"
    publish_payload = {"creation_id": container_id}
    publish_res = requests.post(publish_url, headers=headers, json=publish_payload, timeout=30)
    publish_res.raise_for_status()
    return publish_res.json()
