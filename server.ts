import express from "express";
import path from "path";
import cors from "cors";
import bodyParser from "body-parser";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import multer from "multer";
import fetch from "node-fetch";
import { Api } from "telegram/tl";
import { NewMessage } from "telegram/events";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = 3000;

app.use(cors());
app.use(bodyParser.json());

// Supabase Setup
const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_KEY || "";

if (!supabaseUrl || !supabaseKey) {
  console.warn("WARNING: SUPABASE_URL or SUPABASE_KEY is missing. Database operations will fail.");
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Multer Setup for file uploads
const upload = multer({ storage: multer.memoryStorage() });

// Telegram Setup
const apiId = parseInt(process.env.TELEGRAM_API_ID || "0");
const apiHash = process.env.TELEGRAM_API_HASH || "";
const sessionPath = path.join(process.cwd(), "session.txt");

// We'll initialize this in startServer
let client: TelegramClient;

let meEntity: Api.User | null = null;

// Helper: Resolve Participant
async function resolveParticipant(chatId: string, peer: any) {
  try {
    if (!meEntity && client.connected) {
      try {
        const me = await client.getMe();
        if (me instanceof Api.User) meEntity = me;
      } catch (e) {}
    }

    let externalUserId = "";
    let displayName = "Unknown";
    let username = "";
    let isSelf = false;

    if (!peer) {
      externalUserId = meEntity?.id.toString() || "me";
      displayName = meEntity ? `${meEntity.firstName || ""} ${meEntity.lastName || ""}`.trim() : "Me";
      isSelf = true;
    } else {
      try {
        const entity = await client.getEntity(peer);
        if (entity instanceof Api.User) {
          externalUserId = entity.id.toString();
          displayName = `${entity.firstName || ""} ${entity.lastName || ""}`.trim() || entity.username || "User";
          username = entity.username || "";
          isSelf = entity.self || (meEntity && entity.id.toString() === meEntity.id.toString()) || false;
        } else if (entity instanceof Api.Chat || entity instanceof Api.Channel) {
          externalUserId = entity.id.toString();
          displayName = entity.title || "Group/Channel";
        } else {
          //@ts-ignore
          externalUserId = entity.id?.toString() || chatId;
        }
      } catch (e) {
        // Fallback for anonymous or protected peers
        externalUserId = peer.userId?.toString() || peer.chatId?.toString() || peer.channelId?.toString() || peer.id?.toString() || chatId;
      }
    }

    if (!externalUserId) {
      console.error("Critical: Could not resolve externalUserId for chatId:", chatId);
      return null;
    }

    const { data: participant, error } = await supabase
      .from("participants")
      .upsert({
        chat_id: String(chatId),
        external_user_id: String(externalUserId),
        display_name: displayName || "User",
        username: username || "",
        is_self: !!isSelf
      }, { onConflict: "chat_id,external_user_id" })
      .select();

    if (error) {
      console.error("Supabase Error resolving participant (full):", JSON.stringify(error));
      if (error.message.includes("row-level security policy")) {
        console.error("CRITICAL: RLS Policy Violation. You MUST run the SQL in supabase_setup.sql in your Supabase SQL Editor to allow writes.");
      }
      if (error.message.includes("relation \"participants\" does not exist")) {
        console.error("HINT: Database table 'participants' is missing. Run supabase_setup.sql in your Supabase SQL Editor.");
      }
      return null;
    }

    return participant && participant.length > 0 ? participant[0] : null;
  } catch (e) {
    console.error("Failed to resolve participant exception:", e);
    return null;
  }
}

function sanitizeFilename(name: string): string {
  // Replace anything that isn't alphanumeric, dot, or dash with underscore
  return name.replace(/[^a-zA-Z0-9.\-_]/g, "_");
}

async function downloadMediaAndStore(message: Api.Message): Promise<{ type: string, url: string | null, media_name: string | null, mime_type: string }> {
  try {
    if (!message.media) return { type: "text", url: null, media_name: null, mime_type: "text/plain" };

    let type = "file";
    let fileName = `tg-${message.id}-${Date.now()}`;
    let originalName = "";
    let fileSize = 0;
    let mimeType = "application/octet-stream";
    
    if (message.media instanceof Api.MessageMediaPhoto) {
      type = "image";
      fileName += ".jpg";
      originalName = `photo-${message.id}.jpg`;
      mimeType = "image/jpeg";
      if (message.media.photo instanceof Api.Photo) {
        const lastSize = message.media.photo.sizes[message.media.photo.sizes.length - 1];
        if ("size" in lastSize) fileSize = lastSize.size;
      }
    } else if (message.media instanceof Api.MessageMediaDocument) {
      type = "file";
      if (message.media.document instanceof Api.Document) {
        fileSize = typeof message.media.document.size === 'object' && 'toJSNumber' in message.media.document.size 
          ? (message.media.document.size as any).toJSNumber() 
          : Number(message.media.document.size);
        
        mimeType = message.media.document.mimeType || "application/octet-stream";

        // Detect Voice Note
        const isVoice = message.media.document.attributes.find(a => a instanceof Api.DocumentAttributeVideo && a.roundMessage) || 
                       message.media.document.attributes.find(a => a instanceof Api.DocumentAttributeAudio && a.voice);
        if (isVoice) type = "voice";

        const attr = message.media.document.attributes.find(a => a instanceof Api.DocumentAttributeFilename);
        if (attr instanceof Api.DocumentAttributeFilename) {
          originalName = attr.fileName;
          fileName = `tg-${message.id}-${sanitizeFilename(attr.fileName)}`;
        } else if (type === "voice") {
          fileName += ".ogg";
          originalName = "voice_note.ogg";
        }
      }
    } else {
      return { type: "text", url: null, media_name: null, mime_type: "text/plain" };
    }

    const MAX_SIZE = 45 * 1024 * 1024; 
    if (fileSize > MAX_SIZE) {
      console.warn(`Skipping media download: File too large (${(fileSize / (1024 * 1024)).toFixed(2)} MB)`);
      return { type, url: null, media_name: originalName || fileName, mime_type: mimeType };
    }

    const buffer = await client.downloadMedia(message, {});
    if (!buffer) return { type, url: null, media_name: originalName || fileName, mime_type: mimeType };

    const { error: uploadErr } = await supabase.storage
      .from("media")
      .upload(fileName, buffer, { 
        contentType: mimeType,
        cacheControl: "3600",
        upsert: true 
      });

    if (uploadErr) {
      console.error("Failed to upload downloaded TG media:", uploadErr);
      return { type, url: null, media_name: originalName || fileName, mime_type: mimeType };
    }

    const { data: { publicUrl } } = supabase.storage.from("media").getPublicUrl(fileName);
    return { type, url: publicUrl, media_name: originalName || fileName, mime_type: mimeType };
  } catch (e) {
    console.error("Media download/store failed:", e);
    return { type: "text", url: null, media_name: null, mime_type: "text/plain" };
  }
}

// Initial Sync
async function performInitialSync() {
  console.log("Starting initial sync...");
  try {
    const dialogs = await client.getDialogs({ limit: 50 });
    for (const dialog of dialogs) {
      const chatId = dialog.id.toString();
      const chatName = dialog.title || "Unknown Chat";
      //@ts-ignore
      const chatType = dialog.isGroup ? "group" : dialog.isChannel ? "channel" : "private";

      // 1. Sync Chat
      const { error: chatSyncErr } = await supabase.from("chats").upsert({
        platform: "telegram",
        chat_id: chatId,
        chat_name: chatName,
        chat_type: chatType,
        last_message_at: new Date(dialog.date * 1000).toISOString(),
        unread_count: dialog.unreadCount
      }, { onConflict: "chat_id" });

      if (chatSyncErr) {
        console.error(`Supabase Sync Error (Initial Sync - Chat ${chatId}):`, JSON.stringify(chatSyncErr, null, 2));
      }

      // 2. Sync Messages (Last 50)
      const messages = await client.getMessages(dialog.id, { limit: 50 });
      for (const msg of messages) {
        // Optimization: Check if message already exists to avoid re-downloading media
        const { data: existingMsg } = await supabase
          .from("messages")
          .select("id")
          .eq("chat_id", chatId)
          .eq("platform_message_id", msg.id.toString())
          .maybeSingle();

        if (existingMsg) continue;

        const participant = await resolveParticipant(chatId, msg.fromId || msg.peerId);
        
        let msgType = "text";
        let mediaUrl = null;
        let originalFilename = null;

        if (msg.media) {
          const media = await downloadMediaAndStore(msg);
          msgType = media.type;
          mediaUrl = media.url;
          originalFilename = media.media_name;
        }

        const replyToId = msg.replyTo instanceof Api.MessageReplyHeader ? msg.replyTo.replyToMsgId?.toString() : null;

        const { error: msgErr } = await supabase.from("messages").upsert({
          chat_id: chatId,
          platform_message_id: msg.id.toString(),
          sender_participant_id: participant?.id,
          text: msg.message || "",
          type: msgType,
          media_url: mediaUrl,
          media_name: originalFilename,
          reply_to_platform_id: replyToId,
          sent_at: new Date(msg.date * 1000).toISOString(),
          is_outgoing: msg.out
        }, { onConflict: "chat_id,platform_message_id" });

        if (msgErr) {
          console.error(`Supabase Sync Error (Initial Sync - Msg ${msg.id.toString()}):`, JSON.stringify(msgErr, null, 2));
        }
      }
    }
    console.log("Initial sync completed.");
  } catch (e) {
    console.error("Initial sync failed:", e);
  }
}

// Real-time listener
function setupHandlers() {
  client.addEventHandler(async (event) => {
    const message = event.message;
    if (!message) return;

    const chatId = message.chatId?.toString();
    if (!chatId) return;

    console.log("New message received in chat:", chatId, "Content:", message.message || "[Media]");
    
    // ... same logic ...
    // Optimization: Check if message already exists
    const { data: existingMsg } = await supabase
      .from("messages")
      .select("id")
      .eq("chat_id", chatId)
      .eq("platform_message_id", message.id.toString())
      .maybeSingle();

    if (existingMsg) {
      console.log("Message already exists, skipping sync.");
      return;
    }

    const participant = await resolveParticipant(chatId, message.fromId || message.peerId);
    if (!participant) {
      console.warn("Could not resolve participant for incoming message in chat:", chatId);
    }

    let msgType = "text";
    let mediaUrl = null;
    let originalFilename = null;
    if (message.media) {
      console.log("Downloading media for new message...");
      const media = await downloadMediaAndStore(message);
      msgType = media.type;
      mediaUrl = media.url;
      originalFilename = media.media_name;
      console.log("Media downloaded, URL:", mediaUrl);
    }

    const replyToId = message.replyTo instanceof Api.MessageReplyHeader ? message.replyTo.replyToMsgId?.toString() : null;

    const { error: msgErr } = await supabase.from("messages").upsert({
      chat_id: chatId,
      platform_message_id: message.id.toString(),
      sender_participant_id: participant?.id,
      text: message.message || "",
      type: msgType,
      media_url: mediaUrl,
      media_name: originalFilename,
      reply_to_platform_id: replyToId,
      sent_at: new Date(message.date * 1000).toISOString(),
      is_outgoing: message.out
    }, { onConflict: "chat_id,platform_message_id" });

    if (msgErr) {
      console.error("Supabase Sync Error (Real-time):", JSON.stringify(msgErr, null, 2));
    } else {
      console.log("Message successfully synced to Supabase.");
    }

    // Update chat state
    const updateData: any = {
      last_message_at: new Date(message.date * 1000).toISOString(),
    };

    // Increment unread count for incoming messages
    if (!message.out) {
      const { data: currentChat } = await supabase
        .from("chats")
        .select("unread_count")
        .eq("chat_id", chatId)
        .maybeSingle();
      
      updateData.unread_count = (currentChat?.unread_count || 0) + 1;
    }

    await supabase.from("chats").update(updateData).eq("chat_id", chatId);

  }, new NewMessage({}));
}

// Download proxy to force "Save As"
app.get("/api/download", async (req, res) => {
  const { url, filename } = req.query;
  if (!url) return res.status(400).send("Missing URL");

  try {
    const response = await fetch(url as string);
    if (!response.ok) throw new Error(`Failed to fetch file: ${response.statusText}`);

    const contentType = response.headers.get("content-type") || "application/octet-stream";
    const safeFilename = encodeURIComponent(filename as string || "file")
      .replace(/['()]/g, escape)
      .replace(/\*/g, "%2A");

    res.setHeader("Content-Type", contentType);
    res.setHeader(
      "Content-Disposition", 
      `attachment; filename="${filename}"; filename*=UTF-8''${safeFilename}`
    );

    const buffer = await response.buffer();
    res.send(buffer);
  } catch (e) {
    console.error("Download proxy error:", e);
    res.status(500).send("Download failed");
  }
});

// Mark as read endpoint
app.post("/api/mark-as-read", async (req, res) => {
  const { chat_id } = req.body;
  if (!chat_id) return res.status(400).json({ error: "Missing chat_id" });

  try {
    // 1. Mark as read in Telegram
    try {
      if (client.connected) {
        // Need the entity to read history
        const entity = await client.getEntity(chat_id);
        await client.invoke(
          new Api.messages.ReadHistory({
            peer: entity,
            maxId: 0, // 0 means everything
          })
        );
      }
    } catch (e) {
      console.warn("Failed to mark Telegram history as read:", e);
    }

    // 2. Clear unread_count in Supabase
    const { error } = await supabase
      .from("chats")
      .update({ unread_count: 0 })
      .eq("chat_id", chat_id);

    if (error) throw error;
    res.json({ success: true });
  } catch (e: any) {
    console.error("Failed to mark as read:", e);
    res.status(500).json({ error: e.message });
  }
});

// Auth State Helper
let phoneCodeHash = "";
let phoneNumber = "";

// API Routes
app.post("/api/telegram/request-code", async (req, res) => {
  const { phone } = req.body;
  phoneNumber = phone;
  try {
    const result = await client.sendCode(
      { apiId, apiHash },
      phone
    );
    phoneCodeHash = result.phoneCodeHash;
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/telegram/login", async (req, res) => {
  const { code } = req.body;
  try {
    await client.invoke(
      new Api.auth.SignIn({
        phoneNumber: phoneNumber,
        phoneCodeHash: phoneCodeHash,
        phoneCode: code,
      })
    );
    const session = client.session.save() as unknown as string;
    
    // Save to local file (fallback)
    fs.writeFileSync(sessionPath, session);
    
    // Save to Supabase (persistent)
    await supabase.from("settings").upsert({ 
      key: "telegram_session", 
      value: session 
    }, { onConflict: "key" });

    console.log("Session saved to disk and database.");
    res.json({ success: true });
    
    // Start sync after login
    performInitialSync();
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/auth-status", async (req, res) => {
  const isConnected = client.connected;
  let isAuthorized = false;
  if (isConnected) {
    isAuthorized = await client.isUserAuthorized();
  }
  res.json({ isConnected, isAuthorized });
});

app.get("/api/conversations", async (req, res) => {
  const { data, error } = await supabase
    .from("chats")
    .select("*")
    .order("last_message_at", { ascending: false });

  if (error) return res.status(500).json(error);
  res.json(data);
});

app.get("/api/messages", async (req, res) => {
  const { chat_id } = req.query;
  if (!chat_id) return res.status(400).json({ error: "chat_id required" });

  const { data, error } = await supabase
    .from("messages")
    .select(`
      *,
      participants:sender_participant_id (*)
    `)
    .eq("chat_id", chat_id)
    .order("sent_at", { ascending: true });

  if (error) return res.status(500).json(error);
  res.json(data);
});

app.post("/api/send", upload.single("file"), async (req, res) => {
  const { chat_id, text, reply_to_msg_id, type: requestedType } = req.body;
  const file = req.file;

  try {
    if (file) {
      // Check size before upload (Supabase free limit 50MB)
      const MAX_SIZE = 45 * 1024 * 1024;
      if (file.size > MAX_SIZE) {
        return res.status(400).json({ error: `File too large (${(file.size / (1024 * 1024)).toFixed(2)} MB). Max limit is 45MB.` });
      }

      // 1. Upload to Supabase Storage
      const rawName = file.originalname || "upload";
      const sanitizedName = sanitizeFilename(rawName);
      const fileName = `${Date.now()}-${sanitizedName}`;
      
      const { data: storageData, error: storageErr } = await supabase.storage
        .from("media")
        .upload(fileName, file.buffer, {
          contentType: file.mimetype,
          cacheControl: "3600",
          upsert: false
        });

      if (storageErr) {
        console.error("Supabase Storage Error:", storageErr);
        return res.status(500).json({ error: "Failed to upload to storage" });
      }

      // Get Public URL
      const { data: { publicUrl: uploadedUrl } } = supabase.storage
        .from("media")
        .getPublicUrl(fileName);

      // 2. Send to Telegram
      const result = await client.sendFile(chat_id, {
        file: file.buffer,
        caption: text || "",
        replyTo: reply_to_msg_id ? parseInt(reply_to_msg_id) : undefined,
        voiceNote: requestedType === "voice",
        attributes: [
          new Api.DocumentAttributeFilename({ fileName: file.originalname || "file" })
        ]
      });

      // Sync sent media message to Supabase
      const participant = await resolveParticipant(chat_id, null); // Self
      
      const { error: syncErr } = await supabase.from("messages").insert({
        chat_id: chat_id,
        platform_message_id: result.id.toString(),
        sender_participant_id: participant?.id,
        text: text || "",
        type: requestedType === "voice" ? "voice" : file.mimetype.startsWith("image/") ? "image" : "file",
        media_url: uploadedUrl,
        media_name: file.originalname || fileName,
        reply_to_platform_id: reply_to_msg_id || null,
        sent_at: new Date().toISOString(),
        is_outgoing: true
      });

      if (syncErr) {
        console.error("Supabase Sync Error (Media Send Branch):", JSON.stringify(syncErr, null, 2));
      }

      await supabase.from("chats").update({
        last_message_at: new Date().toISOString()
      }).eq("chat_id", chat_id);

      res.json({ success: true, media_url: uploadedUrl });
    } else {
      const sentMsg = await client.sendMessage(chat_id, { 
        message: text,
        replyTo: reply_to_msg_id ? parseInt(reply_to_msg_id) : undefined
      });
      
      // Sync sent text message to Supabase
      const participant = await resolveParticipant(chat_id, null); // Self
      const { error: syncErr } = await supabase.from("messages").insert({
        chat_id: chat_id,
        platform_message_id: sentMsg.id.toString(),
        sender_participant_id: participant?.id,
        text: text,
        type: "text",
        reply_to_platform_id: reply_to_msg_id || null,
        sent_at: new Date().toISOString(),
        is_outgoing: true
      });

      if (syncErr) {
        console.error("Supabase Sync Error (Text Send Branch):", JSON.stringify(syncErr, null, 2));
      }

      await supabase.from("chats").update({
        last_message_at: new Date().toISOString()
      }).eq("chat_id", chat_id);

      res.json({ success: true });
    }
  } catch (e: any) {
    console.error("Send Error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/login", (req, res) => {
  const { email, password } = req.body;
  const ALLOWED_EMAIL = process.env.DASHBOARD_EMAIL || "Crma@gmail.com";
  const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "admin123";
  
  if (email === ALLOWED_EMAIL && password === DASHBOARD_PASSWORD) {
    res.json({ success: true });
  } else {
    res.status(401).json({ error: "Invalid email or password" });
  }
});

app.post("/api/logout-full", async (req, res) => {
  try {
    console.log("Full reset requested. Clearing session...");
    
    // 1. Send response first so UI can reload
    if (!res.headersSent) {
      res.json({ success: true, message: "Session cleared. Restarting..." });
    }

    // 2. Disconnect and stop event handlers
    try {
      if (client.connected) {
        await client.disconnect();
      }
    } catch (e) {}

    // 3. Remove session from Supabase
    await supabase.from("settings").delete().eq("key", "telegram_session");

    // 4. Remove session file
    if (fs.existsSync(sessionPath)) {
      try {
        fs.unlinkSync(sessionPath);
        console.log("Session file deleted.");
      } catch (e) {
        console.error("Failed to delete session file:", e);
      }
    }
    
    // 5. Force restart
    setTimeout(() => {
      console.log("Exiting process for fresh start.");
      process.exit(0);
    }, 500);
  } catch (e: any) {
    console.error("Logout-full error:", e);
    // If we can't send response (already sent), just log
    if (!res.headersSent) {
      res.status(500).json({ error: e.message });
    }
  }
});

async function startServer() {
  // 0. Ensure Storage Bucket and Settings table exist
  try {
    const { data: buckets } = await supabase.storage.listBuckets();
    if (!buckets?.find(b => b.name === "media")) {
      await supabase.storage.createBucket("media", { public: true });
      console.log("Created 'media' bucket in Supabase storage.");
    }
  } catch (e) {
    console.error("Storage bucket check failed:", e);
  }

  // Load Session from Supabase or disk
  let savedSessionString = "";
  try {
    const { data: setting } = await supabase
      .from("settings")
      .select("value")
      .eq("key", "telegram_session")
      .maybeSingle();
      
    if (setting?.value) {
      savedSessionString = setting.value;
      console.log("Loaded session from Supabase.");
    } else if (fs.existsSync(sessionPath)) {
      savedSessionString = fs.readFileSync(sessionPath, "utf8");
      console.log("Loaded session from disk.");
    }
  } catch (e) {
    console.error("Failed to load session from Supabase:", e);
  }

  // Initialize Client
  const session = new StringSession(savedSessionString);
  client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
  });

  // Connect Telegram
  await client.connect();
  setupHandlers();

  if (await client.isUserAuthorized()) {
    console.log("Telegram is authorized.");
    performInitialSync();
  } else {
    console.log("Telegram is NOT authorized. Waiting for login...");
  }
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running at http://0.0.0.0:${PORT}`);
  });
}

startServer().catch(console.error);
