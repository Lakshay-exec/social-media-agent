/**
 * Cloudflare Worker: Real-Time Instagram AI Engagement Agent
 *
 * Catches Meta Webhook events for new comments on ANY Instagram Reel or Post,
 * immediately likes the comment, evaluates it with Google Gemini AI,
 * and replies with an authentic peer response in under 3 seconds!
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. Meta Webhook Verification (GET)
    if (request.method === "GET") {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");

      const verifyToken = env.WEBHOOK_VERIFY_TOKEN || "ace_social_agent_2026";

      if (mode === "subscribe" && token === verifyToken) {
        console.log("Meta Webhook verification handshake successful!");
        return new Response(challenge, {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        });
      } else {
        console.warn("Meta Webhook verification failed. Invalid verify token.");
        return new Response("Verification failed", { status: 403 });
      }
    }

    // 2. Incoming Webhook Event (POST)
    if (request.method === "POST") {
      try {
        const body = await request.json();

        // Meta requires an immediate 200 OK response within 5 seconds
        // ctx.waitUntil keeps the Worker alive in the background to handle AI & API calls
        ctx.waitUntil(handleMetaWebhook(body, env));

        return new Response("EVENT_RECEIVED", { status: 200 });
      } catch (err) {
        console.error("Error reading webhook payload:", err);
        return new Response("Bad Request", { status: 400 });
      }
    }

    return new Response("AI Social Media Agent Webhook Server is Live!", { status: 200 });
  },
};

/**
 * Parses incoming Meta Webhook events and executes real-time AI engagement.
 */
async function handleMetaWebhook(payload, env) {
  if (payload.object !== "instagram" || !payload.entry) {
    return;
  }

  for (const entry of payload.entry) {
    const changes = entry.changes || [];
    for (const change of changes) {
      if (change.field === "comments") {
        const value = change.value || {};
        const commentId = value.id;
        const text = value.text || "";
        const from = value.from || {};
        const author = from.username || "user";
        const mediaId = value.media ? value.media.id : "";

        // Skip our own comments
        const myUsername = (env.IG_USERNAME || "your_instagram_username").toLowerCase();
        if (author.toLowerCase() === myUsername) {
          console.log(`Skipping our own comment (${commentId}) by @${author}`);
          continue;
        }

        console.log(`Received new comment on Reel/Post ${mediaId} by @${author}: "${text}"`);

        // 1. Instant Auto-Like
        await likeInstagramComment(commentId, env);

        // 2. AI Reply Generation with Gemini
        const replyText = await generateGeminiReply(text, author, env);

        // 3. Post Reply (if not flagged as SKIP)
        if (replyText) {
          await postInstagramReply(commentId, replyText, env);
        } else {
          console.log(`Comment by @${author} flagged as SKIP (spam/promo/unrelated).`);
        }
      }
    }
  }
}

/**
 * Auto-likes an Instagram comment on behalf of the business/creator account.
 */
async function likeInstagramComment(commentId, env) {
  const token = env.IG_ACCESS_TOKEN;
  const userId = env.IG_USER_ID;

  if (!token || !userId) {
    console.warn("Missing IG_ACCESS_TOKEN or IG_USER_ID. Skipping auto-like.");
    return;
  }

  const url = `https://graph.facebook.com/v27.0/${userId}/likes`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ comment_id: commentId }),
    });

    if (res.ok) {
      console.log(`Successfully liked comment ${commentId}!`);
    } else {
      const errText = await res.text();
      console.warn(`Could not like comment ${commentId}: ${errText}`);
    }
  } catch (err) {
    console.error(`Error liking comment ${commentId}:`, err);
  }
}

/**
 * Generates an authentic, casual peer reply using Google Gemini.
 */
async function generateGeminiReply(commentText, author, env) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("Missing GEMINI_API_KEY.");
    return null;
  }

  const prompt = `You are an authentic 20-something competitive gamer (Valorant ranked grinder) and dark anime enthusiast managing comments on your Instagram profile and Reels (@${env.IG_USERNAME || "your_instagram_username"}).

Comment from @${author}: "${commentText}"

Decision Task:
1. SPAM / SCAM / PROMO FILTER:
   If the comment is spam, crypto trading solicitation, bot follow-bait, promotional advertising, or hate speech, output strictly: SKIP

2. CASUAL PEER REPLY:
   If it is a real human comment:
   - Draft a natural, witty, relatable 1-sentence reply with 1-2 expressive emojis (e.g. 💀, 🖤, 😭, 🔥).
   - STRICT CONSTRAINT: Under 15 words total.
   - Do NOT tag @${author} or use formal greetings like "Hey @${author}".
   - Output ONLY the raw reply sentence. No quotes, no preamble.`;

  const models = ["gemini-3-flash-preview", "gemini-3.1-flash-lite"];

  for (const model of models) {
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    try {
      const res = await fetch(geminiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.85,
            maxOutputTokens: 50,
          },
        }),
      });

      if (!res.ok) {
        continue;
      }

      const data = await res.json();
      const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      let cleaned = rawText.trim();

      if (cleaned.startsWith('"') && cleaned.endsWith('"')) {
        cleaned = cleaned.slice(1, -1).trim();
      }

      if (cleaned.toUpperCase() === "SKIP" || cleaned.toUpperCase().startsWith("SKIP")) {
        return null;
      }

      return cleaned;
    } catch (err) {
      console.warn(`Gemini model ${model} error:`, err);
    }
  }

  return null;
}

/**
 * Posts the generated reply to the comment.
 */
async function postInstagramReply(commentId, replyText, env) {
  const token = env.IG_ACCESS_TOKEN;
  if (!token) return;

  const url = `https://graph.facebook.com/v27.0/${commentId}/replies`;

  try {
    const res = await fetch(url, {
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
      console.error(`Failed to post reply to comment ${commentId}: ${errText}`);
    }
  } catch (err) {
    console.error(`Error posting reply to comment ${commentId}:`, err);
  }
}
