"""
agent/storage.py
Handles persistent storage for configuration and runtime state.
Guarantees clean UTF-8 encoding without BOM for Linux runner compatibility.
Strictly sanitizes state before saving to ensure zero private tokens are ever written to git.
"""
import json
import logging
import os

logger = logging.getLogger(__name__)

DEFAULT_CONFIG = {
    "niche": "Competitive Gaming, Valorant, and Dark Psychological Anime",
    "persona": "A 20-year-old gamer and anime fan posting raw, casual thoughts from their phone. Witty, blunt, relatable, never sounds like a brand or AI.",
    "custom_instructions": "Use natural phrasing and occasional lowercase. Never use corporate buzzwords, emojis, or motivational quotes. Maximum 1 hashtag or none at all. Focus on sparking debates and giving honest mini-reviews.",
    "post_styles": ["MINI_REVIEW", "QUESTION_DEBATE", "HOT_TAKE"],
    "threads": {
        "enabled": True,
        "auto_post": True,
        "auto_reply": True,
        "max_threads_to_scan": 3,
    },
    "instagram": {
        "enabled": True,
        "auto_reply_comments": True,
        "auto_like_comments": True,
        "max_posts_to_scan": 5,
    },
    "gemini_model": "gemini-3.8-flash",
}

DEFAULT_STATE = {
    "threads_replied_ids": [],
    "ig_replied_ids": [],
    "ig_liked_ids": [],
    "last_post_id": None,
}


def load_config(path: str = "config.json") -> dict:
    """Loads user configuration from config.json with fallback to defaults."""
    if not os.path.exists(path):
        logger.warning("Config file '%s' not found. Using default configuration.", path)
        return DEFAULT_CONFIG.copy()

    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
            logger.info("Successfully loaded configuration from '%s'.", path)
            return data
    except Exception as e:
        logger.error("Failed to read config from '%s': %s. Falling back to defaults.", path, e)
        return DEFAULT_CONFIG.copy()


def load_state(path: str = "state.json") -> dict:
    """Loads runtime state from state.json."""
    if not os.path.exists(path):
        logger.info("State file '%s' not found. Initializing empty state.", path)
        return DEFAULT_STATE.copy()

    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
            for key, val in DEFAULT_STATE.items():
                if key not in data:
                    data[key] = val
            logger.info("Successfully loaded state from '%s'.", path)
            return data
    except Exception as e:
        logger.error("Failed to read state from '%s': %s. Resetting state.", path, e)
        return DEFAULT_STATE.copy()


def save_state(state: dict, path: str = "state.json") -> None:
    """
    Saves runtime state atomically to state.json in standard UTF-8 without BOM.
    Strictly strips private tokens (active_threads_token, active_ig_token) so
    confidential credentials NEVER leak into the git repository.
    """
    sanitized = state.copy()
    sanitized.pop("active_threads_token", None)
    sanitized.pop("active_ig_token", None)

    temp_path = f"{path}.tmp"
    try:
        with open(temp_path, "w", encoding="utf-8") as f:
            json.dump(sanitized, f, indent=2, ensure_ascii=False)
            f.write("\n")
        if os.path.exists(path):
            os.replace(temp_path, path)
        else:
            os.rename(temp_path, path)
        logger.info("Saved sanitized state to '%s' (zero private tokens exposed).", path)
    except Exception as e:
        logger.error("Failed to persist state to '%s': %s", path, e)
        if os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except OSError:
                pass
