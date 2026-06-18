ALTER TABLE public.business_messages
  ADD COLUMN IF NOT EXISTS media_kind text,
  ADD COLUMN IF NOT EXISTS media_path text,
  ADD COLUMN IF NOT EXISTS media_mime text,
  ADD COLUMN IF NOT EXISTS media_filename text;