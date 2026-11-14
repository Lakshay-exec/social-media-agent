/**
 * Cloudflare Worker: 24/7 Fully Autonomous Instagram AI Engagement Agent
 *
 * Dual Engine Architecture:
 * 1. REAL-TIME META WEBHOOK: Instant < 2s reply when Meta delivers a comment event.
 * 2. AUTONOMOUS 1-MINUTE CRON: Automatically scans recent posts every 60s,
 *    detects unreplied comments from ANY user, likes them, and posts an AI reply!
 * 3. SCAN-NOW ADMIN ENDPOINT: Allows external 60s cron pinging (e.g. Cron-Job.org / UptimeRobot / GitHub Actions)
 *    to guarantee 100% fail-safe execution regardless of Cloudflare Free tier cron jitter.
 */

export default {
  // 1. Autonomous Scheduled Cron Event (Every 1 minute)
  async scheduled(event, env, ctx) {
    console.log(`[CRON] Scheduled execution fired at ${new Date().toISOString()}`);
    ctx.waitUntil(scanAndReplyInstagram(env));
  },

  // 2. HTTP Fetch Handler
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Git Proxy Route (bypasses local network TLS handshake drops)
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

    // Health / Status Endpoint
    if (url.pathname === "/health" || url.pathname === "/status") {
      return new Response(
        JSON.stringify({
          status: "online",
          service: "Instagram AI Autonomous Agent",
          account: "@" + (env.IG_USERNAME || "acebymistake"),
          timestamp: new Date().toISOString(),
          engine: "Meta Webhook + 1-Min Cron Active",
        }, null, 2),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // Admin On-Demand Scan & Reply (for instant verification and external 60s cron pingers)
    if (url.pathname === "/admin/scan-now") {
      const key = url.searchParams.get("key");
      if (key !== (env.ADMIN_KEY || "ace_admin_2026")) {
        return new Response("Unauthorized", { status: 401 });
      }

      const scanResult = await scanAndReplyInstagram(env);
      return new Response(JSON.stringify(scanResult, null, 2), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Meta Webhook Handshake (GET / or GET /webhook)
    if (request.method === "GET") {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");

      if (mode === "subscribe" && token === env.WEBHOOK_VERIFY_TOKEN) {
        console.log("[WEBHOOK] Verification handshake successful!");
        return new Response(challenge, {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        });
      }

      // Default root landing
      return new Response(
        JSON.stringify({
          status: "active",
          message: "Instagram AI Agent Webhook & Cron Engine is Running 24/7",
          account: "@" + (env.IG_USERNAME || "acebymistake"),
        }, null, 2),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // Meta Incoming Webhook Event (POST / or POST /webhook)
    if (request.method === "POST") {
      try {
        const body = await request.json();
        console.log("[WEBHOOK] Incoming payload:", JSON.stringify(body));
        ctx.waitUntil(handleMetaWebhook(body, env));
        return new Response("EVENT_RECEIVED", { status: 200 });
      } catch (err) {
        console.error("[WEBHOOK] Parse error:", err);
        return new Response("Bad Request", { status: 400 });
      }
    }

    return new Response("Not Found", { status: 404 });
  },
};

/**
 * Scans recent Instagram media, finds unreplied comments from ANY user,
 * auto-likes them, and replies with AI immediately.
 */
async function scanAndReplyInstagram(env) {
  const token = env.IG_ACCESS_TOKEN;
  const igId = env.IG_USER_ID;
  const myUsername = (env.IG_USERNAME || "acebymistake").toLowerCase();
  const MAX_REPLIES_PER_RUN = 3; // Keep runs fast (< 3s) and avoid subrequest limits

  const summary = {
    timestamp: new Date().toISOString(),
    account: myUsername,
    posts_scanned: 0,
    comments_found: 0,
    processed: [],
    skipped: [],
    errors: [],
  };

  if (!token || !igId) {
    summary.errors.push("Missing IG_ACCESS_TOKEN or IG_USER_ID in worker environment!");
    return summary;
  }

  try {
    // Scan the 10 most recent posts/reels
    const res = await fetch(
      `https://graph.facebook.com/v27.0/${igId}/media?fields=id,caption,media_type,timestamp,comments{id,text,username,timestamp,like_count,replies{id,text,username}}&limit=10&access_token=${token}`
    );

    if (!res.ok) {
      const errText = await res.text();
      summary.errors.push(`Graph API /media error (HTTP ${res.status}): ${errText}`);
      return summary;
    }

    const data = await res.json();
    const posts = data.data || [];
    summary.posts_scanned = posts.length;

    for (const post of posts) {
      if (summary.processed.length >= MAX_REPLIES_PER_RUN) break;

      const comments = post.comments?.data || [];
      summary.comments_found += comments.length;

      for (const comment of comments) {
        if (summary.processed.length >= MAX_REPLIES_PER_RUN) break;

        const commentId = comment.id;
        const author = (comment.username || "").toLowerCase();
        const text = comment.text || "";

        // 1. Skip our own comments
        if (author === myUsername) {
          summary.skipped.push({ id: commentId, reason: "author_is_self" });
          continue;
        }

        // 2. Check if we already replied to this comment
        const replies = comment.replies?.data || [];
        const alreadyReplied = replies.some(
          (r) => (r.username || "").toLowerCase() === myUsername
        );

        if (alreadyReplied) {
          summary.skipped.push({ id: commentId, author, reason: "already_replied" });
          continue;
        }

        console.log(`[SCAN] Unreplied comment found from @${author}: "${text}" (ID: ${commentId})`);

        // 3. Auto-Like the comment
        const liked = await likeInstagramComment(commentId, env);

        // 4. Generate AI Reply
        const replyText = await resolveReply(text, author, env);

        // 5. Post Reply
        let replySuccess = false;
        if (replyText) {
          replySuccess = await postInstagramReply(commentId, replyText, env);
        }

        summary.processed.push({
          comment_id: commentId,
          author: author,
          text: text,
          liked: liked,
          reply: replyText,
          success: replySuccess,
        });
      }
    }
  } catch (err) {
    console.error("[SCAN] Error in scanAndReplyInstagram:", err);
    summary.errors.push(`Exception: ${err.message}`);
  }

  return summary;
}

/**
 * Handles incoming real-time Meta webhook payload.
 */
async function handleMetaWebhook(payload, env) {
  if (!payload || !payload.entry) return;

  const myUsername = (env.IG_USERNAME || "acebymistake").toLowerCase();

  for (const entry of payload.entry) {
    for (const change of entry.changes || []) {
      if (change.field === "comments") {
        const value = change.value || {};
        const commentId = value.id;
        const text = value.text || "";
        const author = (value.from?.username || "user").toLowerCase();

        // Skip our own comments
        if (author === myUsername) continue;

        console.log(`[WEBHOOK] Processing real-time comment from @${author}: "${text}" (ID: ${commentId})`);

        // 1. Auto-Like
        await likeInstagramComment(commentId, env);

        // 2. Auto-Reply
        const replyText = await resolveReply(text, author, env);
        if (replyText) {
          await postInstagramReply(commentId, replyText, env);
        }
      }
    }
  }
}

/**
 * Likes an Instagram comment via Graph API.
 */
async function likeInstagramComment(commentId, env) {
  const token = env.IG_ACCESS_TOKEN;
  const userId = env.IG_USER_ID;
  if (!token || !userId) return false;

  try {
    const res = await fetch(`https://graph.facebook.com/v27.0/${userId}/likes`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ comment_id: commentId }),
    });

    if (res.ok) {
      console.log(`[LIKE] Liked comment ${commentId}`);
      return true;
    } else {
      const err = await res.text();
      console.warn(`[LIKE] Like response for ${commentId}: HTTP ${res.status} - ${err}`);
      return false;
    }
  } catch (err) {
    console.error(`[LIKE] Error liking comment ${commentId}:`, err);
    return false;
  }
}

/**
 * Posts reply to an Instagram comment via Graph API.
 */
async function postInstagramReply(commentId, replyText, env) {
  const token = env.IG_ACCESS_TOKEN;
  if (!token) return false;

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
      console.log(`[REPLY] Posted reply to ${commentId}: "${replyText}" (Reply ID: ${data.id})`);
      return true;
    } else {
      const err = await res.text();
      console.error(`[REPLY] Failed to post reply to ${commentId}: HTTP ${res.status} - ${err}`);
      return false;
    }
  } catch (err) {
    console.error(`[REPLY] Error posting reply to ${commentId}:`, err);
    return false;
  }
}

/**
 * Resolves AI reply using Gemini, falling back to genuine creator peer responses.
 */
async function resolveReply(commentText, author, env) {
  const trimmed = commentText.trim().toLowerCase();
  const spamKeywords = [
    "dm me", "check bio", "crypto", "forex", "whatsapp",
    "inbox me", "telegram", "follow back", "f4f", "gain followers"
  ];
  if (spamKeywords.some((k) => trimmed.includes(k))) return null;

  // 1. Try Gemini
  const aiReply = await generateGeminiReply(commentText, author, env);
  if (aiReply) return aiReply;

  // 2. High-quality creator peer fallback pool
  const peerFallbacks = [
    "Appreciate the love! 🖤🔥",
    "Had to lock in for this one! 💀",
    "Much love! 🔥",
    "Real. 🖤",
    "You know how we do it! 💀🔥",
    "Appreciate it bro! 🖤",
    "W 🤝",
    "Locked in! 🎮🔥",
    "Thanks for the support! 👊🔥",
    "Always grinding! 🎮🖤"
  ];
  return peerFallbacks[Math.floor(Math.random() * peerFallbacks.length)];
}

/**
 * Calls Google Gemini API for intelligent contextual reply.
 */
async function generateGeminiReply(commentText, author, env) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const prompt = `You are a competitive gamer and anime enthusiast managing comments on your Instagram profile and Reels (@${env.IG_USERNAME || "acebymistake"}).
Comment from @${author}: "${commentText}"
If spam, hate speech, or promotion, reply strictly: SKIP.
Otherwise, reply with a natural witty 1-sentence reply with 1-2 expressive emojis (under 12 words). No quotes, no @${author}.`;

  const models = ["gemini-flash-lite-latest", "gemini-2.5-flash", "gemini-flash-latest"];
  for (const model of models) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.85, maxOutputTokens: 50 },
          }),
        }
      );

      if (!res.ok) continue;

      const data = await res.json();
      let cleaned = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
      if (cleaned.startsWith('"') && cleaned.endsWith('"')) cleaned = cleaned.slice(1, -1).trim();
      if (cleaned.toUpperCase().startsWith("SKIP")) return null;
      if (cleaned.length > 0) return cleaned;
    } catch (err) {
      console.warn(`[GEMINI] Model ${model} failed:`, err.message);
    }
  }

  return null;
}
