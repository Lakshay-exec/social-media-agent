/**
 * Cloudflare Worker: Real-Time Instagram AI Engagement Agent
 * 
 * 1. Webhook Handshake: Verifies Meta Webhook challenge.
 * 2. Instant Comment Engagement:
 *    - Auto-likes incoming comments in < 1 second.
 *    - Evaluates comment via Google Gemini AI for spam filtering & authentic peer reply.
 *    - Seamless fallback to authentic gaming/anime peer replies if Gemini rate limit (429) is reached.
 *    - Posts reply via Meta Graph API in under 2 seconds.
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 0. Git Proxy Route (bypasses local Wi-Fi handshake drops)
    if (url.pathname.startsWith("/gh/")) {
      const ghPath = url.pathname.replace(/^\/gh/, "");
      const targetUrl = "https://github.com" + ghPath + url.search;
      const newHeaders = new Headers(request.headers);
      newHeaders.set("Host", "github.com");
      return fetch(targetUrl, {
        method: request.method,
        headers: newHeaders,
        body: request.body,
        redirect: "follow",
      });
    }

    // 1. Meta Webhook Verification Handshake (GET)
    if (request.method === "GET") {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");

      const verifyToken = env.WEBHOOK_VERIFY_TOKEN;

      if (mode === "subscribe" && token && token === verifyToken) {
        console.log("Meta Webhook verification handshake successful!");
        return new Response(challenge, {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        });
      }
      return new Response("Verification failed", { status: 403 });
    }

    // 2. Incoming Comment Event from Meta (POST)
    if (request.method === "POST") {
      try {
        const body = await request.json();
        console.log("Incoming Webhook payload:", JSON.stringify(body));

        // Process in background without blocking Meta's 5s timeout
        ctx.waitUntil(handleMetaWebhook(body, env));

        return new Response("EVENT_RECEIVED", { status: 200 });
      } catch (err) {
        return new Response("Bad Request", { status: 400 });
      }
    }

    return new Response("AI Instagram Engagement Worker is Live!", { status: 200 });
  },
};

/**
 * Handles incoming Meta webhook payload.
 */
async function handleMetaWebhook(payload, env) {
  if (!payload || !payload.entry) return;

  for (const entry of payload.entry) {
    for (const change of entry.changes || []) {
      if (change.field === "comments") {
        const value = change.value || {};
        const commentId = value.id;
        const text = value.text || "";
        const author = value.from?.username || "user";

        // Never reply to or like our own comments
        const myUsername = (env.IG_USERNAME || "").toLowerCase();
        if (author.toLowerCase() === myUsername) {
          console.log(`Skipping our own comment (${commentId}) by @${author}`);
          continue;
        }

        console.log(`Processing comment by @${author}: "${text}" (ID: ${commentId})`);

        // 1. Instant Auto-Like
        await likeInstagramComment(commentId, env);

        // 2. Generate Reply (Gemini AI or Smart Peer Fallback)
        const replyText = await resolveReply(text, author, env);

        // 3. Post Reply
        if (replyText) {
          await postInstagramReply(commentId, replyText, env);
        }
      }
    }
  }
}

/**
 * Auto-likes an Instagram comment via Graph API.
 */
async function likeInstagramComment(commentId, env) {
  const token = env.IG_ACCESS_TOKEN;
  const userId = env.IG_USER_ID;
  if (!token || !userId) return;

  try {
    const res = await fetch(`https://graph.facebook.com/v27.0/${userId}/likes`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ comment_id: commentId }),
    });
    console.log(`Liked comment ${commentId} (HTTP ${res.status})`);
  } catch (err) {
    console.error(`Error liking comment ${commentId}:`, err);
  }
}

/**
 * Resolves the reply text using Gemini AI with fallback to contextual peer replies.
 */
async function resolveReply(commentText, author, env) {
  const trimmed = commentText.trim().toLowerCase();

  // Basic spam check
  const spamKeywords = ["dm me", "check bio", "crypto", "forex", "whatsapp", "inbox me", "telegram", "follow back", "f4f"];
  if (spamKeywords.some((k) => trimmed.includes(k))) {
    console.log(`Skipping spam comment from @${author}: "${commentText}"`);
    return null;
  }

  // 1. Attempt dynamic reply via Gemini AI
  const aiReply = await generateGeminiReply(commentText, author, env);
  if (aiReply) {
    return aiReply;
  }

  // 2. High-engagement authentic fallback replies (gaming/anime persona)
  const peerFallbacks = [
    "Appreciate the love! 🖤🔥",
    "Had to lock in for this one! 💀",
    "Much love! 🔥",
    "Real. 🖤",
    "You know how we do it! 💀🔥",
    "Appreciate it bro! 🖤",
    "W 🤝",
    "Locked in! 🎮🔥"
  ];
  return peerFallbacks[Math.floor(Math.random() * peerFallbacks.length)];
}

/**
 * Calls Google Gemini AI to draft a natural, witty peer reply.
 */
async function generateGeminiReply(commentText, author, env) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const prompt = `You are a competitive gamer and anime enthusiast managing comments on your Instagram profile and Reels (@${env.IG_USERNAME || "creator"}).

Comment from @${author}: "${commentText}"

Decision Task:
1. SPAM / PROMO FILTER:
   If the comment is spam, crypto promo, bot follow-bait, or hate speech, output strictly: SKIP

2. CASUAL PEER REPLY:
   If it is a real human comment:
   - Draft a natural, witty 1-sentence reply with 1-2 expressive emojis (e.g. 💀, 🖤, 😭, 🔥).
   - STRICT CONSTRAINT: Maximum 12 words total.
   - Do NOT tag @${author} or say "Hey @${author}".
   - Output ONLY the raw reply sentence.`;

  const models = ["gemini-2.5-flash-lite", "gemini-3.8-flash", "gemini-flash-latest"];

  for (const model of models) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.85, maxOutputTokens: 50 },
        }),
      });

      if (!res.ok) continue;

      const data = await res.json();
      let cleaned = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";

      if (cleaned.startsWith('"') && cleaned.endsWith('"')) {
        cleaned = cleaned.slice(1, -1).trim();
      }

      if (cleaned.toUpperCase().startsWith("SKIP")) return null;
      if (cleaned.length > 0) return cleaned;
    } catch (err) {
      console.warn(`Gemini model ${model} error:`, err);
    }
  }
  return null;
}

/**
 * Posts reply to an Instagram comment via Meta Graph API.
 */
async function postInstagramReply(commentId, replyText, env) {
  const token = env.IG_ACCESS_TOKEN;
  if (!token) return;

  try {
    const res = await fetch(`https://graph.facebook.com/v27.0/${commentId}/replies`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: replyText }),
    });

    if (res.ok) {
      const data = await res.json();
      console.log(`Successfully replied to comment ${commentId}! Reply ID: ${data.id}`);
    } else {
      const errText = await res.text();
      console.error(`Failed to reply to comment ${commentId}: ${errText}`);
    }
  } catch (err) {
    console.error(`Error replying to comment ${commentId}:`, err);
  }
}
