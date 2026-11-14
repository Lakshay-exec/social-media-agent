/**
 * Cloudflare Worker: 24/7 Automated Instagram AI Engagement Agent
 *
 * Dual Engine Architecture:
 * 1. REAL-TIME WEBHOOK: Instant < 2s reply when Meta fires webhook.
 * 2. AUTONOMOUS 1-MINUTE CRON: Automatically scans recent posts every 60s,
 *    detects any unreplied/unliked comments from ANY user, likes & replies!
 *    (Bypasses Meta's Webhook Advanced Access limitations completely!)
 */

export default {
  // 1. Autonomous Scheduled Cron Event (Every 1 minute)
  async scheduled(event, env, ctx) {
    console.log("Cron trigger fired: scanning for unreplied comments...");
    ctx.waitUntil(scanAndReplyInstagram(env));
  },

  // 2. HTTP Fetch Handler (Webhooks, Admin & Handshake)
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Git Proxy Route (bypasses local Wi-Fi handshake drops)
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

    // Webhook Handshake (GET)
    if (request.method === "GET") {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");

      if (mode === "subscribe" && token === env.WEBHOOK_VERIFY_TOKEN) {
        return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
      }
      return new Response("Verification failed", { status: 403 });
    }

    // Incoming Webhook Event (POST)
    if (request.method === "POST") {
      try {
        const body = await request.json();
        console.log("Incoming Webhook payload:", JSON.stringify(body));
        ctx.waitUntil(handleMetaWebhook(body, env));
        return new Response("EVENT_RECEIVED", { status: 200 });
      } catch (err) {
        return new Response("Bad Request", { status: 400 });
      }
    }

    return new Response("AI Social Media Agent Webhook Server is Live!", { status: 200 });
  },
};

/**
 * Scans recent Instagram media, finds unreplied comments from ANY user,
 * auto-likes them and replies immediately.
 */
async function scanAndReplyInstagram(env) {
  const token = env.IG_ACCESS_TOKEN;
  const igId = env.IG_USER_ID;
  const myUsername = (env.IG_USERNAME || "").toLowerCase();
  const summary = { processed: [], skipped: [] };
  if (!token || !igId) return summary;

  try {
    const res = await fetch(
      `https://graph.facebook.com/v27.0/${igId}/media?fields=id,caption,comments{id,text,username,timestamp,like_count,replies{id,text,username}}&limit=5&access_token=${token}`
    );
    const data = await res.json();
    if (!data.data) return summary;

    for (const post of data.data) {
      const comments = post.comments?.data || [];
      for (const comment of comments) {
        const commentId = comment.id;
        const author = (comment.username || "").toLowerCase();
        const text = comment.text || "";

        // Skip our own comments
        if (author === myUsername) continue;

        // Check if we already replied to this comment
        const replies = comment.replies?.data || [];
        const alreadyReplied = replies.some((r) => (r.username || "").toLowerCase() === myUsername);

        if (!alreadyReplied) {
          console.log(`Autonomous scan found unreplied comment from @${author}: "${text}" (ID: ${commentId})`);

          // 1. Auto-Like
          await likeInstagramComment(commentId, env);

          // 2. Generate Reply
          const replyText = await resolveReply(text, author, env);
          if (replyText) {
            await postInstagramReply(commentId, replyText, env);
            summary.processed.push({ commentId, author, text, reply: replyText });
          }
        } else {
          summary.skipped.push(commentId);
        }
      }
    }
  } catch (err) {
    console.error("Error in scanAndReplyInstagram:", err);
    summary.error = err.message;
  }

  return summary;
}

/**
 * Handles incoming real-time Meta webhook payload.
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

        const myUsername = (env.IG_USERNAME || "").toLowerCase();
        if (author.toLowerCase() === myUsername) continue;

        // Auto-Like
        await likeInstagramComment(commentId, env);

        // Auto-Reply
        const replyText = await resolveReply(text, author, env);
        if (replyText) {
          await postInstagramReply(commentId, replyText, env);
        }
      }
    }
  }
}

async function likeInstagramComment(commentId, env) {
  const token = env.IG_ACCESS_TOKEN;
  const userId = env.IG_USER_ID;
  if (!token || !userId) return;

  try {
    await fetch(`https://graph.facebook.com/v27.0/${userId}/likes`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ comment_id: commentId }),
    });
    console.log(`Liked comment ${commentId}`);
  } catch (err) {
    console.error(`Error liking comment ${commentId}:`, err);
  }
}

async function resolveReply(commentText, author, env) {
  const trimmed = commentText.trim().toLowerCase();
  const spamKeywords = ["dm me", "check bio", "crypto", "forex", "whatsapp", "inbox me", "telegram", "follow back", "f4f"];
  if (spamKeywords.some((k) => trimmed.includes(k))) return null;

  // 1. Try Gemini
  const aiReply = await generateGeminiReply(commentText, author, env);
  if (aiReply) return aiReply;

  // 2. Authentic Peer Fallback Pool
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

async function generateGeminiReply(commentText, author, env) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const prompt = `You are a competitive gamer and anime enthusiast managing comments on your Instagram profile and Reels (@${env.IG_USERNAME || "creator"}).
Comment from @${author}: "${commentText}"
If spam or hate speech, reply strictly: SKIP.
Otherwise, reply with a natural witty 1-sentence reply with 1-2 expressive emojis (under 12 words). No quotes, no @${author}.`;

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
      if (cleaned.startsWith('"') && cleaned.endsWith('"')) cleaned = cleaned.slice(1, -1).trim();
      if (cleaned.toUpperCase().startsWith("SKIP")) return null;
      if (cleaned.length > 0) return cleaned;
    } catch (err) {}
  }
  return null;
}

async function postInstagramReply(commentId, replyText, env) {
  const token = env.IG_ACCESS_TOKEN;
  if (!token) return;

  try {
    const res = await fetch(`https://graph.facebook.com/v27.0/${commentId}/replies`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message: replyText }),
    });
    console.log(`Replied to ${commentId}: HTTP ${res.status}`);
  } catch (err) {
    console.error(`Error replying to comment ${commentId}:`, err);
  }
}
