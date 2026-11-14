"""
main.py
Main entrypoint for the AI Social Media Agent (Meta Threads & Instagram).
Orchestrates config loading, 60-day token auto-refresh, content generation,
publishing, automated comment liking, smart peer replies, and state persistence.
"""
import logging
import os
import sys

# Attempt local .env loading
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

from agent.brain import generate_post, generate_reply
from agent.instagram_api import (
    auto_refresh_ig_token,
    get_active_ig_token,
    get_media_comments,
    get_recent_media,
    like_comment,
    reply_to_comment,
)
from agent.storage import load_config, load_state, save_state
from agent.threads_api import (
    auto_refresh_threads_token,
    get_active_threads_token,
    get_recent_threads,
    get_thread_replies,
    publish_threads_post,
    reply_to_thread,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("social-agent")


def run_threads_module(config: dict, state: dict) -> None:
    """Executes the Threads pipeline if enabled and credentials exist."""
    threads_cfg = config.get("threads", {})
    if not threads_cfg.get("enabled", True):
        logger.info("Threads module is disabled in config.json. Skipping.")
        return

    user_id = os.environ.get("THREADS_USER_ID")
    token = get_active_threads_token(state)

    if not user_id or not token:
        logger.warning(
            "Threads is enabled in config, but THREADS_USER_ID or THREADS_ACCESS_TOKEN "
            "is missing from environment. Skipping Threads module gracefully."
        )
        return

    logger.info("=== Processing Meta Threads ===")

    # 1. 60-Day Token Auto-Refresh
    try:
        auto_refresh_threads_token(state)
    except Exception as e:
        logger.warning("Threads token refresh encountered an issue: %s", e)

    # 2. Automated Content Creation & Publishing
    if threads_cfg.get("auto_post", True):
        logger.info("--- Threads: Generating and Publishing Post ---")
        try:
            post_text = generate_post(config)
            logger.info("Generated post draft:\n%s", post_text)
            result = publish_threads_post(post_text, state, user_id)
            post_id = result.get("id")
            if post_id:
                state["last_post_id"] = post_id
                logger.info("Threads post published successfully! ID: %s", post_id)
        except Exception as e:
            logger.error("Threads post publishing failed: %s", e)

    # 3. Community Engagement & Replies
    if threads_cfg.get("auto_reply", True):
        logger.info("--- Threads: Checking Recent Threads for Replies ---")
        try:
            max_scan = threads_cfg.get("max_threads_to_scan", 3)
            recent = get_recent_threads(state, user_id, limit=max_scan)
            replied_set = set(state.get("threads_replied_ids", []))
            reply_count = 0

            for thread in recent:
                thread_id = thread.get("id")
                thread_text = thread.get("text", "")
                if not thread_id:
                    continue

                replies = get_thread_replies(thread_id, state)
                for reply in replies:
                    reply_id = reply.get("id")
                    reply_text_body = reply.get("text", "")
                    author = reply.get("username", "user")

                    if not reply_id or reply_id in replied_set:
                        continue

                    # Generate smart response
                    reply_msg = generate_reply(thread_text, author, reply_text_body, config)
                    if reply_msg:
                        try:
                            reply_to_thread(reply_id, reply_msg, state, user_id)
                            replied_set.add(reply_id)
                            reply_count += 1
                            logger.info("Replied to @%s on Thread %s.", author, thread_id)
                        except Exception as e:
                            logger.warning("Failed to publish reply to %s: %s", reply_id, e)
                    else:
                        # Skipped (spam or crypto)
                        replied_set.add(reply_id)

            state["threads_replied_ids"] = list(replied_set)
            logger.info("Threads engagement complete. %d new replies sent.", reply_count)
        except Exception as e:
            logger.error("Threads engagement cycle encountered an error: %s", e)


def run_instagram_module(config: dict, state: dict) -> None:
    """Executes the Instagram pipeline if enabled and credentials exist."""
    ig_cfg = config.get("instagram", {})
    if not ig_cfg.get("enabled", True):
        logger.info("Instagram module is disabled in config.json. Skipping.")
        return

    ig_user_id = os.environ.get("IG_USER_ID")
    token = get_active_ig_token(state)

    if not ig_user_id or not token:
        logger.warning(
            "Instagram is enabled in config, but IG_USER_ID or IG_ACCESS_TOKEN "
            "is missing from environment. Skipping Instagram module gracefully."
        )
        return

    logger.info("=== Processing Instagram ===")

    # 1. 60-Day Token Auto-Refresh
    try:
        auto_refresh_ig_token(state)
        # Update token reference after refresh
        token = get_active_ig_token(state) or token
    except Exception as e:
        logger.warning("Instagram token refresh encountered an issue: %s", e)

    # 2. Automated Engagement (Like and/or Reply to Comments)
    auto_like = ig_cfg.get("auto_like_comments", True)
    auto_reply = ig_cfg.get("auto_reply_comments", True)

    if auto_like or auto_reply:
        logger.info("--- Instagram: Scanning Recent Posts for Comments ---")
        try:
            max_posts = ig_cfg.get("max_posts_to_scan", 5)
            media_list = get_recent_media(ig_user_id, token, limit=max_posts)

            liked_set = set(state.get("ig_liked_ids", []))
            replied_set = set(state.get("ig_replied_ids", []))
            likes_sent = 0
            replies_sent = 0

            for media in media_list:
                media_id = media.get("id")
                caption = media.get("caption", "")
                if not media_id:
                    continue

                comments = get_media_comments(media_id, token)
                for comment in comments:
                    comment_id = comment.get("id")
                    comment_text = comment.get("text", "")
                    author = comment.get("username", "user")

                    if not comment_id:
                        continue

                    # Auto-Like Comment
                    if auto_like and comment_id not in liked_set:
                        if like_comment(ig_user_id, comment_id, token):
                            liked_set.add(comment_id)
                            likes_sent += 1

                    # Auto-Reply to Comment
                    if auto_reply and comment_id not in replied_set:
                        reply_msg = generate_reply(caption, author, comment_text, config)
                        if reply_msg:
                            res = reply_to_comment(comment_id, reply_msg, token)
                            if res and res.get("id"):
                                replied_set.add(comment_id)
                                replies_sent += 1
                        else:
                            # Skipped spam / promo
                            replied_set.add(comment_id)

            state["ig_liked_ids"] = list(liked_set)
            state["ig_replied_ids"] = list(replied_set)
            logger.info("Instagram engagement complete: %d likes, %d replies.", likes_sent, replies_sent)
        except Exception as e:
            logger.error("Instagram engagement cycle encountered an error: %s", e)


def main():
    logger.info("=== Starting AI Social Media Agent ===")

    # 1. Load Config & State
    config = load_config()
    state = load_state()

    # 2. Verify AI Engine Credentials
    if not os.environ.get("GEMINI_API_KEY"):
        logger.error("Critical: GEMINI_API_KEY environment variable is missing. Exiting.")
        sys.exit(1)

    # 3. Run Platform Modules Independently
    run_threads_module(config, state)
    run_instagram_module(config, state)

    # 4. Persist Updated State
    save_state(state)
    logger.info("=== AI Social Media Agent Run Completed Successfully ===")


if __name__ == "__main__":
    main()
