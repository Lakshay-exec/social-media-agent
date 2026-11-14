"""
agent/brain.py
AI reasoning engine powered by the official google-genai SDK.
Generates human-like, non-corporate social media posts and authentic peer replies
for Meta Threads and Instagram.
"""
import logging
import os
import random
import re
from google import genai
from google.genai import types

logger = logging.getLogger(__name__)

STYLE_DESCRIPTIONS = {
    "MINI_REVIEW": (
        "Give a sharp, unfiltered mini-review of a game mechanic, anime arc, character, or update. "
        "Share an honest opinion or rating with a punchy conclusion."
    ),
    "QUESTION_DEBATE": (
        "Ask a provocative, debate-sparking question or challenge that practically forces people "
        "in the comments to take a side or reply."
    ),
    "HOT_TAKE": (
        "Drop a spicy, controversial 1-2 line opinion that challenges consensus and sparks discussion."
    ),
}

INCOMPLETE_TRAILERS = {
    "and", "or", "but", "with", "the", "a", "an", "zero", "my", "to", "in", "of", "for", "on", "at", "if", "then"
}


def _clean_generated_text(text: str) -> str:
    """Strips surrounding quotes, AI preambles, and extra whitespace."""
    text = text.strip()
    text = re.sub(
        r"^(?:(?:Draft|Post|Threads Post|Instagram Comment|Here is(?: a| the)? post|Status update)[\s:*_*-]*)+",
        "",
        text,
        flags=re.IGNORECASE,
    ).strip()
    if (text.startswith('"') and text.endswith('"')) or (text.startswith("'") and text.endswith("'")):
        text = text[1:-1].strip()
    if text.startswith("> "):
        text = text[2:].strip()
    return text.strip()


def _is_valid_complete_post(text: str) -> bool:
    """Validates that a post is complete and under 350 characters."""
    if len(text) < 25 or len(text) > 350:
        return False

    words = text.split()
    if len(words) < 4:
        return False

    last_word = words[-1].lower().strip(".,!?:;\"'()#")
    if last_word in INCOMPLETE_TRAILERS:
        return False

    return True


def _get_genai_client() -> genai.Client:
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise ValueError("GEMINI_API_KEY environment variable is missing.")
    return genai.Client(
        api_key=api_key,
        http_options=types.HttpOptions(api_version="v1beta", timeout=60000),
    )


def generate_post(config: dict) -> str:
    """
    Generates an authentic, human-like social post under 350 characters
    matching user's niche, persona, and custom instructions.
    """
    client = _get_genai_client()
    primary_model = config.get("gemini_model", "gemini-3.8-flash")
    niche = config.get("niche", "Competitive Gaming and Anime")
    persona = config.get("persona", "A casual 20-something creator posting raw thoughts from their phone.")
    custom_instructions = config.get("custom_instructions", "Never sound like AI. Maximum 1 hashtag or none.")
    post_styles = config.get("post_styles", ["MINI_REVIEW", "QUESTION_DEBATE", "HOT_TAKE"])

    selected_style = random.choice(post_styles) if post_styles else "HOT_TAKE"
    style_desc = STYLE_DESCRIPTIONS.get(
        selected_style,
        "Share an authentic thought that sparks discussion."
    )

    prompt = f"""You are posting authentic thoughts on Meta Threads from your phone.

Account Persona:
{persona}

Niche:
{niche}

Post Style:
[{selected_style}] {style_desc}

User Custom Guidelines:
{custom_instructions}

Strict Generation Rules:
1. Under 350 characters total. Keep it natural, punchy, and conversational.
2. Never sound corporate, promotional, or like an AI bot. No generic clichés or inspirational quotes.
3. Maximum 1 hashtag at the end, or zero hashtags.
4. MUST BE A 100% COMPLETE, FINISHED THOUGHT. Never trail off mid-sentence.
5. Output ONLY the raw post text. No preamble, no quotes around the text.
"""

    models_to_try = [primary_model]
    for fallback in ["gemini-3-flash-preview", "gemini-3.1-flash-lite"]:
        if fallback not in models_to_try:
            models_to_try.append(fallback)

    last_candidate = ""
    for model_name in models_to_try:
        for attempt in range(2):
            try:
                logger.info("Generating post with model %s (attempt %d, style: %s)...", model_name, attempt + 1, selected_style)
                response = client.models.generate_content(
                    model=model_name,
                    contents=prompt,
                    config=types.GenerateContentConfig(
                        temperature=0.88,
                        max_output_tokens=180,
                        thinking_config=types.ThinkingConfig(thinking_budget=0),
                    ),
                )

                raw_text = response.text or ""
                cleaned = _clean_generated_text(raw_text)

                if _is_valid_complete_post(cleaned):
                    logger.info("Successfully generated post (%d chars): %s", len(cleaned), cleaned)
                    return cleaned

                last_candidate = cleaned
                logger.warning("Post candidate did not meet quality/length bounds (%d chars): '%s'.", len(cleaned), cleaned)
            except Exception as e:
                logger.warning("Model %s attempt %d encountered error: %s", model_name, attempt + 1, e)

    if last_candidate and 25 <= len(last_candidate) <= 380:
        logger.info("Using last valid candidate as fallback.")
        return last_candidate

    raise RuntimeError("Failed to generate valid social post across all available Gemini models.")


def generate_reply(post_context: str, author: str, comment_text: str, config: dict) -> str | None:
    """
    Evaluates incoming comments on Threads or Instagram.
    Returns None if the comment is spam/crypto/bot promo (SKIP),
    otherwise drafts a casual 1-sentence peer reply (max 15 words).
    """
    client = _get_genai_client()
    primary_model = config.get("gemini_model", "gemini-3.8-flash")
    persona = config.get("persona", "A casual creator replying to comments.")
    custom_instructions = config.get("custom_instructions", "Keep it authentic, blunt, and natural.")

    prompt = f"""You are managing comments on your social media post.

Persona:
{persona}

Custom Instructions:
{custom_instructions}

Context:
- Your Post: "{post_context}"
- User @{author} commented: "{comment_text}"

Decision Task:
1. SPAM / SCAM / SELF-PROMO FILTER:
   If the comment is spam, crypto/trading solicitation, bot follow-bait, adult promo,
   or completely irrelevant self-advertisement, output ONLY: SKIP

2. CASUAL PEER REPLY:
   If it is a real human comment:
   - Draft a natural, witty 1-sentence peer-to-peer reply.
   - STRICT CONSTRAINT: Maximum 15 words total.
   - Do NOT include @mentions or greetings like "Hey @{author}".
   - Do NOT wrap in quotes.
   - Output ONLY the reply sentence.
"""

    models_to_try = [primary_model, "gemini-3-flash-preview", "gemini-3.1-flash-lite"]

    for model_name in models_to_try:
        try:
            logger.info("Evaluating comment by @%s (model: %s)...", author, model_name)
            response = client.models.generate_content(
                model=model_name,
                contents=prompt,
                config=types.GenerateContentConfig(
                    temperature=0.75,
                    max_output_tokens=60,
                    thinking_config=types.ThinkingConfig(thinking_budget=0),
                ),
            )

            raw_text = (response.text or "").strip()
            cleaned = _clean_generated_text(raw_text)

            if cleaned.upper() == "SKIP" or cleaned.upper().startswith("SKIP"):
                logger.info("Comment by @%s flagged as SKIP (spam/irrelevant/promo).", author)
                return None

            words = cleaned.split()
            if len(words) > 15:
                cleaned = " ".join(words[:15])

            logger.info("Generated reply to @%s: %s", author, cleaned)
            return cleaned

        except Exception as e:
            logger.warning("Error evaluating reply with model %s: %s", model_name, e)

    logger.error("Failed to evaluate reply after retries. Skipping.")
    return None
