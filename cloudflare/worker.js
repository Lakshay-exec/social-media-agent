/**
 * Cloudflare Worker: Real-Time Instagram AI Engagement Agent
 * Catches Meta Webhook events for comments on ANY Reel or Post,
 * instantly likes the comment, evaluates with Gemini AI, and replies!
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

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

    // 2. Incoming Comment Event (POST)
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

async function handleMetaWebhook(payload, env) {
  if (!payload || !payload.entry) return;

  for (const entry of payload.entry) {
    for (const change of entry.changes || []) {
      if (change.field === "comments") {
        const value = change.value || {};
        const commentId = value.id;
        const text = value.text || "";
        const author = value.from?.username || "user";

        // Never reply to our own comments
        const myUsername = (env.IG_USERNAME || "").toLowerCase();
        if (author.toLowerCase() === myUsername) {
          console.log(`Skipping our own comment (${commentId}) by @${author}`);
          continue;
        }

        console.log(`Processing comment by @${author}: "${text}" (ID: ${commentId})`);

        // 1. Auto-Like Comment
        await likeInstagramComment(commentId, env);

        // 2. Generate AI Reply
        const replyText = await generateGeminiReply(text, author, env);

        // 3. Post Reply
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
    const res = await fetch(`https://graph.facebook.com/v27.0/${userId}/likes`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ comment_id: commentId }),
    });
    console.log(`Liked comment ${commentId}: ${res.status}`);
  } catch (err) {
    console.error(`Error liking comment:`, err);
  }
}

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
   - STRICT CONSTRAINT: Maximum 15 words total.
   - Do NOT tag @${author} or say "Hey @${author}".
   - Output ONLY the raw reply sentence.`;

  const models = ["gemini-3-flash-preview", "gemini-3.1-flash-lite"];

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
      return cleaned;
    } catch (err) {
      console.warn(`Gemini error:`, err);
    }
  }
  return null;
}

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
    console.log(`Replied to ${commentId}: ${res.status}`);
  } catch (err) {
    console.error(`Error replying to ${commentId}:`, err);
  }
}
