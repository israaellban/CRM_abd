-- 1. Chats Table
CREATE TABLE IF NOT EXISTS chats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform TEXT NOT NULL,
  chat_id TEXT UNIQUE NOT NULL,
  chat_name TEXT,
  chat_type TEXT,
  last_message_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  is_pinned BOOLEAN DEFAULT FALSE,
  unread_count INT DEFAULT 0
);

-- 2. Participants Table
CREATE TABLE IF NOT EXISTS participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  display_name TEXT,
  username TEXT,
  phone TEXT,
  avatar_url TEXT,
  is_self BOOLEAN DEFAULT FALSE,
  UNIQUE(chat_id, external_user_id)
);

-- 3. Messages Table
CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id TEXT NOT NULL,
  platform_message_id TEXT NOT NULL,
  sender_participant_id UUID REFERENCES participants(id),
  text TEXT,
  type TEXT DEFAULT 'text',
  media_url TEXT,
  sent_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  is_outgoing BOOLEAN DEFAULT FALSE,
  UNIQUE(chat_id, platform_message_id)
);

-- Add support for optional columns if they don't exist
DO $$ 
BEGIN 
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='messages' AND column_name='media_name') THEN
    ALTER TABLE messages ADD COLUMN media_name TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='messages' AND column_name='reply_to_platform_id') THEN
    ALTER TABLE messages ADD COLUMN reply_to_platform_id TEXT;
  END IF;
END $$;

-- Settings table for persistent data (like session strings)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Enable RLS
ALTER TABLE chats ENABLE ROW LEVEL SECURITY;
ALTER TABLE participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;

-- Drop existing policies to avoid conflicts
DROP POLICY IF EXISTS "Allow all for chats" ON chats;
DROP POLICY IF EXISTS "Allow all for participants" ON participants;
DROP POLICY IF EXISTS "Allow all for messages" ON messages;
DROP POLICY IF EXISTS "Allow all for settings" ON settings;

-- Create "Allow All" policies for personal dashboard access
CREATE POLICY "Allow all for chats" ON chats FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for participants" ON participants FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for messages" ON messages FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for settings" ON settings FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

-- 4. Storage Policies (for 'media' bucket)
-- Ensure 'media' bucket is public
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types) 
VALUES ('media', 'media', true, 52428800, null)
ON CONFLICT (id) DO UPDATE SET public = true, file_size_limit = 52428800;

-- Drop existing storage policies to reset them
DROP POLICY IF EXISTS "Public Access" ON storage.objects;
DROP POLICY IF EXISTS "Public Insert" ON storage.objects;
DROP POLICY IF EXISTS "Public Update" ON storage.objects;
DROP POLICY IF EXISTS "Public Delete" ON storage.objects;

-- Create policies for storage.objects with explicit role access
CREATE POLICY "Public Access" ON storage.objects FOR SELECT TO anon, authenticated USING (bucket_id = 'media');
CREATE POLICY "Public Insert" ON storage.objects FOR INSERT TO anon, authenticated WITH CHECK (bucket_id = 'media');
CREATE POLICY "Public Update" ON storage.objects FOR UPDATE TO anon, authenticated USING (bucket_id = 'media') WITH CHECK (bucket_id = 'media');
CREATE POLICY "Public Delete" ON storage.objects FOR DELETE TO anon, authenticated USING (bucket_id = 'media');

-- Ensure the bucket is actually accessible by anyone (personal dashboard context)
-- These are critical for avoiding "Permission denied" during uploads
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- Enable Realtime
-- Note: If these fail, the publication might already exist.
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END $$;

ALTER PUBLICATION supabase_realtime ADD TABLE chats;
ALTER PUBLICATION supabase_realtime ADD TABLE messages;
